#!/usr/bin/env node
/**
 * Algorithm — compose an issue from RSS/Atom feeds.
 *
 * Replaces the agentic research loop. The difference that matters is where
 * the work happens: fetching, date filtering, dedup and rotation are all
 * done in code here, and the model is called exactly ONCE, over titles and
 * feed excerpts only. It never fetches an article, so nothing accumulates
 * in its context.
 *
 * The old pipeline cost $9.53 and 231 turns for one issue, because every
 * article it read stayed in context and every subsequent turn re-read all
 * of it — 26.4M cached input tokens. This one sends a single request of
 * roughly 20K tokens.
 *
 * Reads  : assets/feeds.json  (produced by audit-feeds.js --write)
 *          issues/NNNN.json   (for dedup and rotation history)
 * Writes : issues/_draft.json (Publish assigns the real issue number)
 *
 * Env    : ANTHROPIC_API_KEY
 *
 * Usage: node scripts/compose-from-feeds.js [--date YYYY-MM-DD]
 *                                           [--per-category N]
 *                                           [--dry]        no API call
 *                                           [--no-linkcheck]
 */

'use strict';

const fs = require('fs');
const path = require('path');
const L = require('./feed-lib.js');

const ROOT = path.resolve(__dirname, '..');
const ISSUES_DIR = path.join(ROOT, 'issues');
const FEEDS_FILE = path.join(ROOT, 'assets', 'feeds.json');
const DRAFT = path.join(ISSUES_DIR, '_draft.json');

const CATEGORIES = ['art', 'film', 'tech', 'lit', 'music', 'design', 'fashion'];

const UA =
  'Mozilla/5.0 (Macintosh; Intel Mac OS X 10_15_7) AppleWebKit/537.36 ' +
  '(KHTML, like Gecko) Chrome/124.0 Safari/537.36';

const FETCH_TIMEOUT_MS = 15000;
const FETCH_CONCURRENCY = 12;
const MODEL = 'claude-sonnet-5';

// ---------------------------------------------------------------------------
// Small helpers
// ---------------------------------------------------------------------------

function arg(name, fallback = null) {
  const i = process.argv.indexOf(`--${name}`);
  return i !== -1 && process.argv[i + 1] && !process.argv[i + 1].startsWith('--')
    ? process.argv[i + 1]
    : fallback;
}
const has = (name) => process.argv.includes(`--${name}`);

async function mapLimit(items, limit, fn) {
  const out = new Array(items.length);
  let next = 0;
  await Promise.all(
    Array.from({ length: Math.min(limit, items.length) }, async () => {
      for (;;) {
        const i = next++;
        if (i >= items.length) return;
        out[i] = await fn(items[i], i);
      }
    }),
  );
  return out;
}

async function httpGet(url, { method = 'GET' } = {}) {
  const ctrl = new AbortController();
  const timer = setTimeout(() => ctrl.abort(), FETCH_TIMEOUT_MS);
  try {
    const res = await fetch(url, {
      method,
      redirect: 'follow',
      signal: ctrl.signal,
      headers: { 'User-Agent': UA, Accept: '*/*' },
    });
    const body = method === 'GET' ? await res.text() : '';
    return { ok: res.ok, status: res.status, body };
  } catch (err) {
    return { ok: false, status: 0, body: '', error: String(err.name || err) };
  } finally {
    clearTimeout(timer);
  }
}

// ---------------------------------------------------------------------------
// PURE: prompt construction and response handling (tested in test-compose.js)
// ---------------------------------------------------------------------------

/**
 * Builds the selection prompt. Deliberately asks only for choices and short
 * connective text — never for summaries of articles the model has not read.
 * The blurb shown on the site is the publisher's own excerpt, carried
 * through unchanged from the feed.
 */
function buildPrompt(byCategory, { date, perCategory }) {
  const lines = [];
  lines.push(
    `You are selecting links for Algorithm, a culture feed dated ${date}.`,
    '',
    `Pick ${perCategory} item(s) for each of the seven categories below from the`,
    'candidates provided. Candidates are already filtered for recency, for',
    'duplicates against every previous issue, and for publication rotation, so',
    'anything listed is eligible — you are choosing among valid options, not',
    'checking validity.',
    '',
    'How to choose:',
    '- Prefer pieces with an argument or a point of view over news, listicles,',
    '  press releases, product launches and awards round-ups.',
    '- Prefer variety of publication and subject within each category.',
    '- Do not agonise. A reasonable pick now beats a perfect pick later; the',
    '  reader skims and chooses for themselves.',
    '- You have not read these articles and must not pretend otherwise. Do not',
    '  write summaries. Choose by title and excerpt only.',
    '',
    'Return ONLY a JSON object, no markdown fence, no commentary:',
    '{',
    '  "headline": "Three to six *words*, one phrase in asterisks renders red",',
    '  "intro": "Two or three sentences introducing the issue loosely.",',
    '  "picks": { "art": [0, 4], "film": [2], ... }',
    '}',
    '',
    'The numbers in "picks" are the candidate ids shown in brackets below.',
    `Every category must be present. Give exactly ${perCategory} id(s) per`,
    'category, chosen only from that category\'s list.',
    '',
  );

  for (const cat of CATEGORIES) {
    const items = byCategory[cat] || [];
    lines.push(`## ${cat} (${items.length} candidates)`);
    if (!items.length) {
      lines.push('  (none available)');
    }
    for (const it of items) {
      lines.push(
        `  [${it.id}] ${it.title} — ${it.source}` +
          (it.published ? ` (${it.published.slice(0, 10)})` : ''),
      );
      if (it.summary) lines.push(`       ${L.truncate(it.summary, 180)}`);
    }
    lines.push('');
  }
  return lines.join('\n');
}

/** Assigns stable ids used by the prompt and resolved from the response. */
function assignIds(byCategory) {
  const withIds = {};
  const index = new Map();
  let n = 0;
  for (const cat of CATEGORIES) {
    withIds[cat] = (byCategory[cat] || []).map((c) => {
      const item = { ...c, id: n++ };
      index.set(item.id, item);
      return item;
    });
  }
  return { withIds, index };
}

/** Extracts a JSON object from a model response that may be fenced or padded. */
function parseModelJson(text) {
  if (typeof text !== 'string' || !text.trim()) {
    throw new Error('Empty model response');
  }
  let s = text.trim();
  const fence = s.match(/```(?:json)?\s*([\s\S]*?)```/i);
  if (fence) s = fence[1].trim();
  const start = s.indexOf('{');
  const end = s.lastIndexOf('}');
  if (start === -1 || end === -1 || end <= start) {
    throw new Error('No JSON object found in model response');
  }
  return JSON.parse(s.slice(start, end + 1));
}

/**
 * Turns the model's chosen ids into issue entries.
 *
 * Anything the model returns that is not a valid id for that category is
 * discarded rather than trusted, and the gap is backfilled from the top of
 * the candidate list. A model that hallucinates an id, repeats one, or
 * drops a category therefore produces a slightly less interesting issue
 * rather than a broken one.
 */
function resolvePicks(parsed, withIds, index, { perCategory }) {
  const warnings = [];
  const picks = parsed && typeof parsed === 'object' ? parsed.picks || {} : {};
  const categories = [];

  for (const cat of CATEGORIES) {
    const pool = withIds[cat] || [];
    const requested = Array.isArray(picks[cat]) ? picks[cat] : [];
    if (!Array.isArray(picks[cat])) {
      warnings.push(`picks.${cat} missing or not an array; backfilling`);
    }

    const chosen = [];
    const used = new Set();
    for (const raw of requested) {
      const id = Number(raw);
      const item = index.get(id);
      if (!Number.isInteger(id) || !item) {
        warnings.push(`${cat}: id ${JSON.stringify(raw)} is not a valid candidate`);
        continue;
      }
      if (item.category !== cat) {
        warnings.push(`${cat}: id ${id} belongs to ${item.category}`);
        continue;
      }
      if (used.has(id)) {
        warnings.push(`${cat}: id ${id} repeated`);
        continue;
      }
      used.add(id);
      chosen.push(item);
      if (chosen.length >= perCategory) break;
    }

    for (const item of pool) {
      if (chosen.length >= perCategory) break;
      if (used.has(item.id)) continue;
      used.add(item.id);
      chosen.push(item);
      warnings.push(`${cat}: backfilled "${L.truncate(item.title, 40)}"`);
    }

    if (chosen.length < perCategory) {
      warnings.push(
        `${cat}: only ${chosen.length} of ${perCategory} available (pool was ${pool.length})`,
      );
    }

    categories.push({
      key: cat,
      entries: chosen.map((c) => ({
        title: c.title,
        author: c.author || null,
        source: c.source,
        summary: c.summary || '',
        why: '',
        url: c.url,
        verified: true,
      })),
    });
  }

  return { categories, warnings };
}

/** Falls back to plain text if the model gives nothing usable. */
function buildIssue({ date, parsed, categories }) {
  const headline =
    typeof parsed?.headline === 'string' && parsed.headline.trim()
      ? L.truncate(parsed.headline.trim(), 80)
      : 'The *Feed*';
  const intro =
    typeof parsed?.intro === 'string' && parsed.intro.trim()
      ? L.truncate(parsed.intro.trim(), 500)
      : 'A selection of recent writing from across the culture press.';
  return {
    issue: 1, // placeholder; Publish assigns the real number
    date,
    headline,
    intro,
    byline: `${date} — selected links`,
    categories,
  };
}

// ---------------------------------------------------------------------------
// Network-bound work
// ---------------------------------------------------------------------------

async function fetchAllFeeds(feeds) {
  const entries = Object.entries(feeds);
  console.log(`Fetching ${entries.length} feeds...`);

  const results = await mapLimit(entries, FETCH_CONCURRENCY, async ([source, meta]) => {
    const res = await httpGet(meta.feed);
    if (!res.ok) {
      return { source, meta, items: [], error: `HTTP ${res.status || res.error}` };
    }
    const items = L.parseFeed(res.body);
    return { source, meta, items, error: items.length ? null : 'parsed 0 items' };
  });

  const bySource = [];
  let okCount = 0;
  const problems = [];
  for (const r of results) {
    if (r.error) problems.push(`  ${r.source}: ${r.error}`);
    else okCount++;
    for (const cat of r.meta.categories || []) {
      bySource.push({ source: r.source, category: cat, items: r.items });
    }
  }

  console.log(`  ${okCount}/${results.length} feeds returned items.`);
  if (problems.length) {
    console.log(`  ${problems.length} problem feed(s):`);
    for (const p of problems.slice(0, 20)) console.log(p);
    if (problems.length > 20) console.log(`  ...and ${problems.length - 20} more`);
  }
  return bySource;
}

async function callModel(prompt) {
  const key = process.env.ANTHROPIC_API_KEY;
  if (!key) throw new Error('ANTHROPIC_API_KEY is not set');

  const res = await fetch('https://api.anthropic.com/v1/messages', {
    method: 'POST',
    headers: {
      'content-type': 'application/json',
      'x-api-key': key,
      'anthropic-version': '2023-06-01',
    },
    body: JSON.stringify({
      model: MODEL,
      max_tokens: 2000,
      messages: [{ role: 'user', content: prompt }],
    }),
  });

  const data = await res.json().catch(() => null);
  if (!res.ok) {
    const detail = data?.error?.message || `HTTP ${res.status}`;
    throw new Error(`Anthropic API error: ${detail}`);
  }
  const text = (data?.content || [])
    .filter((b) => b.type === 'text')
    .map((b) => b.text)
    .join('\n');

  const u = data?.usage || {};
  console.log(
    `  model: in=${u.input_tokens ?? '?'} out=${u.output_tokens ?? '?'} tokens`,
  );
  return text;
}

/** Drops entries whose URL no longer resolves. Cheap insurance against 404s. */
async function linkCheck(categories) {
  const all = [];
  for (const c of categories) for (const e of c.entries) all.push(e);
  console.log(`Checking ${all.length} links...`);

  const statuses = await mapLimit(all, FETCH_CONCURRENCY, async (e) => {
    let r = await httpGet(e.url, { method: 'HEAD' });
    // Plenty of sites reject HEAD but serve GET fine.
    if (!r.ok && [403, 405, 501, 0].includes(r.status)) {
      r = await httpGet(e.url);
    }
    return r.ok || r.status === 403 ? null : `${e.source}: HTTP ${r.status || r.error}`;
  });

  let dropped = 0;
  for (const c of categories) {
    c.entries = c.entries.filter((e) => {
      const i = all.indexOf(e);
      if (statuses[i]) {
        console.log(`  dropping ${statuses[i]}`);
        dropped++;
        return false;
      }
      return true;
    });
  }
  console.log(`  ${dropped} dead link(s) dropped.`);
  return dropped;
}

// ---------------------------------------------------------------------------
// Main
// ---------------------------------------------------------------------------

function loadIssues() {
  if (!fs.existsSync(ISSUES_DIR)) return [];
  return fs
    .readdirSync(ISSUES_DIR)
    .filter((f) => /^\d{4}\.json$/.test(f))
    .sort()
    .map((f) => {
      try {
        return JSON.parse(fs.readFileSync(path.join(ISSUES_DIR, f), 'utf8'));
      } catch {
        return null;
      }
    })
    .filter(Boolean);
}

async function main() {
  const date = arg('date') || new Date().toISOString().slice(0, 10);
  if (!/^\d{4}-\d{2}-\d{2}$/.test(date)) throw new Error(`Invalid --date: ${date}`);
  const perCategory = Number(arg('per-category', '2'));
  if (!Number.isInteger(perCategory) || perCategory < 1) {
    throw new Error(`Invalid --per-category: ${arg('per-category')}`);
  }

  if (!fs.existsSync(FEEDS_FILE)) {
    throw new Error(
      'assets/feeds.json is missing. Run the Audit Feeds workflow with the ' +
        '"write" box ticked once to generate it.',
    );
  }
  const feeds = JSON.parse(fs.readFileSync(FEEDS_FILE, 'utf8'));
  const feedCount = Object.keys(feeds).length;
  if (!feedCount) throw new Error('assets/feeds.json is empty.');

  const issues = loadIssues();
  const { seenUrls, seenTitles, rotationCounts } = L.historyFromIssues(issues);
  console.log(
    `${feedCount} feeds, ${issues.length} past issue(s), ${seenUrls.size} URLs already used.`,
  );

  const bySource = await fetchAllFeeds(feeds);

  const { candidates, dropped } = L.selectCandidates({
    bySource,
    now: Date.now(),
    windowDays: Number(arg('window-days', '21')),
    seenUrls,
    seenTitles,
    rotationCounts,
    rotationMax: 2,
    maxPerSource: 3,
  });
  console.log(
    `Candidates: ${candidates.length} eligible ` +
      `(dropped ${dropped.stale} stale, ${dropped.duplicate} duplicate, ` +
      `${dropped.undated} undated, ${dropped.rested} rested, ${dropped.future} future)`,
  );

  const grouped = L.groupForPrompt(candidates, { maxPerCategory: 40 });
  for (const cat of CATEGORIES) {
    const n = (grouped[cat] || []).length;
    if (n < perCategory) {
      console.log(`  WARNING: ${cat} has only ${n} candidate(s) for ${perCategory} slot(s)`);
    }
  }

  const { withIds, index } = assignIds(grouped);
  const prompt = buildPrompt(withIds, { date, perCategory });
  console.log(`Prompt is ~${Math.round(prompt.length / 4)} tokens.`);

  let parsed = null;
  if (has('dry')) {
    console.log('--dry: skipping the API call, backfilling every pick.');
  } else {
    const text = await callModel(prompt);
    try {
      parsed = parseModelJson(text);
    } catch (err) {
      console.log(`  model returned unusable JSON (${err.message}); backfilling.`);
    }
  }

  const { categories, warnings } = resolvePicks(parsed, withIds, index, { perCategory });
  for (const w of warnings) console.log(`  note: ${w}`);

  if (!has('no-linkcheck') && !has('dry')) await linkCheck(categories);

  const empty = categories.filter((c) => !c.entries.length).map((c) => c.key);
  if (empty.length === CATEGORIES.length) {
    throw new Error('Every category came out empty — refusing to write a draft.');
  }
  if (empty.length) console.log(`  WARNING: empty categories: ${empty.join(', ')}`);

  const issue = buildIssue({ date, parsed, categories });
  fs.mkdirSync(ISSUES_DIR, { recursive: true });
  fs.writeFileSync(DRAFT, JSON.stringify(issue, null, 2) + '\n');

  const total = categories.reduce((n, c) => n + c.entries.length, 0);
  console.log(`\nWrote issues/_draft.json — ${total} entries across ${categories.length} categories.`);
}

if (require.main === module) {
  main().catch((err) => {
    console.error(`\nFAILED: ${err.message}`);
    process.exit(1);
  });
}

module.exports = {
  buildPrompt, assignIds, parseModelJson, resolvePicks, buildIssue, CATEGORIES,
  // exported for the integration test, which stubs global.fetch and runs
  // the real code path end to end rather than re-implementing it
  main,
};
