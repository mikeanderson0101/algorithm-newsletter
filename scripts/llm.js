#!/usr/bin/env node
/**
 * Algorithm — every model call goes through here, and so does every cent.
 *
 * Two things this file exists to guarantee:
 *
 * 1. No call accumulates context. Each request carries exactly the one
 *    article (or one list of titles) it is about, and nothing else. The
 *    agentic pipeline this replaces cost $9.53 an issue because every
 *    article it read stayed in context and was re-read on every later turn.
 *
 * 2. A run cannot spend more than the cap. The ledger prices every response
 *    from its own `usage`, and every stage asks `room()` before it starts.
 *    Spend is persisted to the run's work folder, so a resumed run counts
 *    what the first attempt already paid for.
 */

'use strict';

const fs = require('fs');
const sdk = require('@anthropic-ai/sdk');

const Anthropic = sdk.default || sdk;

const MODELS = {
  reader: 'claude-haiku-5-5',
  judge: 'claude-sonnet-5-5',
};

// $ per million tokens, standard (non-batch) rates, cached 2026-10-06.
// Haiku 5.5 is quoted for prompts up to 100K tokens; no request here comes
// near that, because no request carries more than one article.
const PRICES = {
  'claude-haiku-5-5': { input: 0.10, output: 0.50 },
  'claude-sonnet-5-5': { input: 2.00, output: 10.00 },
};
const BATCH_DISCOUNT = 0.5;

class Ledger {
  constructor({ cap = 1.0, file = null } = {}) {
    this.cap = cap;
    this.file = file;
    this.entries = [];
    if (file && fs.existsSync(file)) {
      try {
        this.entries = JSON.parse(fs.readFileSync(file, 'utf8')).entries || [];
      } catch {
        /* a corrupt ledger restarts at zero rather than blocking the run */
      }
    }
  }

  get spent() {
    return this.entries.reduce((n, e) => n + e.cost, 0);
  }

  add(stage, model, usage, { batch = false } = {}) {
    const p = PRICES[model];
    if (!p) throw new Error(`No price on file for ${model}`);
    const input =
      (usage.input_tokens || 0) +
      (usage.cache_creation_input_tokens || 0) * 1.25 +
      (usage.cache_read_input_tokens || 0) * 0.1;
    const output = usage.output_tokens || 0;
    const cost = ((input * p.input + output * p.output) / 1e6) * (batch ? BATCH_DISCOUNT : 1);
    this.entries.push({ stage, model, batch, input: Math.round(input), output, cost });
    this.save();
    return cost;
  }

  /** Throws before a stage starts if its projected cost would break the cap. */
  room(stage, projected) {
    if (this.spent + projected > this.cap) {
      throw new Error(
        `${stage} would bring this run to about $${(this.spent + projected).toFixed(2)}, ` +
          `over the $${this.cap.toFixed(2)} cap. Nothing was sent. ` +
          `Reduce --read-per-category or --check-per-category, or raise --cap.`,
      );
    }
  }

  byStage() {
    const out = {};
    for (const e of this.entries) out[e.stage] = (out[e.stage] || 0) + e.cost;
    return out;
  }

  save() {
    if (!this.file) return;
    fs.writeFileSync(
      this.file,
      JSON.stringify({ cap: this.cap, spent: this.spent, entries: this.entries }, null, 2) + '\n',
    );
  }
}

/** Rough projection: ~4 characters per token, output as given. */
function project(model, inputChars, outputTokens, { batch = false } = {}) {
  const p = PRICES[model];
  return (((inputChars / 4) * p.input + outputTokens * p.output) / 1e6) * (batch ? BATCH_DISCOUNT : 1);
}

let client = null;
function getClient() {
  if (!client) client = new Anthropic();
  return client;
}

function textOf(message) {
  return (message.content || [])
    .filter((b) => b.type === 'text')
    .map((b) => b.text)
    .join('');
}

function parseJson(text) {
  const s = String(text || '').trim();
  const start = s.indexOf('{');
  const end = s.lastIndexOf('}');
  if (start === -1 || end <= start) throw new Error('No JSON object in model response');
  return JSON.parse(s.slice(start, end + 1));
}

function params({ model, system, prompt, schema, maxTokens, effort }) {
  return {
    model,
    max_tokens: maxTokens,
    system,
    messages: [{ role: 'user', content: prompt }],
    output_config: {
      effort,
      format: { type: 'json_schema', schema },
    },
  };
}

/** One request, one JSON object back, priced into the ledger. */
async function askJson(ledger, stage, opts) {
  const { model, maxTokens = 4000, effort = 'low' } = opts;
  const message = await getClient().messages.create(params({ ...opts, maxTokens, effort }));
  ledger.add(stage, model, message.usage);
  if (message.stop_reason === 'refusal') throw new Error(`${stage}: the model declined this request`);
  if (message.stop_reason === 'max_tokens') throw new Error(`${stage}: response hit max_tokens`);
  return parseJson(textOf(message));
}

/**
 * Many independent requests through the Batch API, at half price.
 *
 * Returns { results: { [custom_id]: object }, failed: [custom_id] }. A
 * weekly issue can wait the few minutes a batch usually takes; if it takes
 * longer than `maxWaitMs` the batch id is returned so a rerun can collect it
 * without paying twice.
 */
async function batchJson(ledger, stage, model, requests, { maxTokens = 2000, effort = 'low', existingId = null, maxWaitMs = 45 * 60000, onCreated = () => {} } = {}) {
  const c = getClient();
  let id = existingId;
  if (!id) {
    const created = await c.messages.batches.create({
      requests: requests.map((r) => ({
        custom_id: r.id,
        params: params({ model, system: r.system, prompt: r.prompt, schema: r.schema, maxTokens, effort }),
      })),
    });
    id = created.id;
    onCreated(id);
  }

  const started = Date.now();
  for (;;) {
    const b = await c.messages.batches.retrieve(id);
    if (b.processing_status === 'ended') break;
    if (Date.now() - started > maxWaitMs) {
      return { pendingId: id, results: {}, failed: [] };
    }
    const n = b.request_counts;
    process.stdout.write(`\r  batch ${id.slice(-8)}: ${n.succeeded + n.errored} of ${requests.length || '?'} done`);
    await new Promise((r) => setTimeout(r, 20000));
  }
  process.stdout.write('\n');

  const results = {};
  const failed = [];
  for await (const r of await c.messages.batches.results(id)) {
    if (r.result.type !== 'succeeded') {
      failed.push(r.custom_id);
      continue;
    }
    const message = r.result.message;
    ledger.add(stage, model, message.usage, { batch: true });
    try {
      results[r.custom_id] = parseJson(textOf(message));
    } catch {
      failed.push(r.custom_id);
    }
  }
  return { results, failed };
}

module.exports = { MODELS, PRICES, Ledger, project, askJson, batchJson, parseJson };
