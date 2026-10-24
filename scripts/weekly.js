#!/usr/bin/env node
/**
 * Troller — make an issue, by hand, once or twice a week.
 *
 *   node scripts/weekly.js scout    [--date YYYY-MM-DD]   News Troll: builds the shortlist
 *   node scripts/weekly.js publish  [--date YYYY-MM-DD]   News Troll: writes the issue, validates, builds
 *   node scripts/weekly.js songs    [--taste '<json>']    Song Troll: its own refresh, writes a batch, builds
 *
 * Nothing here is scheduled. The history of why, in one paragraph: the
 * agentic version read everything inside one long model loop and cost $9.53
 * an issue; the RSS version read nothing and published casino ads, job
 * listings and exchange rates. This version reads every finalist, but each
 * read is its own small request, so nothing accumulates.
 *
 * ARTICLES (links only — no summaries are written for publication)
 *   1. feeds -> date window, dedupe, rotation, junk titles, English   code, $0
 *   2. shortlist ~12 per category from titles and excerpts             Haiku, one call
 *   3. fetch each, cut to the article body, drop thin/paywalled/foreign code, $0
 *   4. read each in full: on brief? substantive? depth 1-5             Haiku, one call per article
 *   5. read the top ~6 per category again, score 1-10                  Sonnet, Batch API (half price)
 *   6. pick the top 5 per category, one outlet per category            code
 *
 * SONG TROLL (the `songs` command, refreshed on its own, never by scout)
 *   1. find this week's list posts (Stereogum 5 Best, Bandcamp Essential
 *      Releases, Various Small Flames, Best Fit, WBRU)                 code, $0
 *   2. pull every song out of each post                                Haiku, one call per post
 *   3. drop known/excluded/already-shown artists                       code
 *   4. pick the batch using your thumbs                                Sonnet, one call
 *
 * Every stage writes its result into .work/<date>/ and is skipped on a rerun,
 * so an interrupted run resumes without paying twice. The ledger there
 * (cost.json) is checked before each stage against the cap (default $1).
 *
 * Needs ANTHROPIC_API_KEY in the environment.
 */

'use strict';

const fs = require('fs');
const path = require('path');
const { spawnSync } = require('child_process');
const L = require('./feed-lib.js');
const T = require('./page-text.js');
const AI = require('./llm.js');

const ROOT = path.resolve(__dirname, '..');
const ISSUES_DIR = path.join(ROOT, 'issues');
const MUSIC_DIR = path.join(ROOT, 'music');
const FEEDS_FILE = path.join(ROOT, 'assets', 'feeds.json');
const MUSIC_SOURCES_FILE = path.join(ROOT, 'assets', 'music-sources.json');
const TASTE_FILE = path.join(MUSIC_DIR, 'taste.json');

const CATEGORIES = ['art', 'film', 'tech', 'lit', 'music', 'design', 'fashion'];

// What each section is for. Rewritten 24 Oct 2026 with Mike: new writing
// about new things; design as a wide net; menswear with an American lean;
// books leaning SFF with comics and graphic novels.
const BRIEFS = {
  art: 'contemporary art criticism: reviews of exhibitions and new work on view now, and essays on what artists are making now. Not market, auction, prize, museum-funding or gallery news.',
  film: 'film criticism of new releases (in cinemas, streaming or on the festival circuit this season) and essays on current film. Not box office, casting, trailers or festival line-ups.',
  tech: 'technology and AI writing with an argument about what is happening now: essays, criticism, serious reporting. Not product launches, buying guides, funding rounds or trade news.',
  lit: 'reviews and criticism of new books, leaning hard toward science fiction and fantasy, plus smart writing about new comics, manga and graphic novels; strong criticism of other new fiction and nonfiction also fits. Not publishing news, award lists, cover reveals, bestseller lists or listicles.',
  music: 'reviews and criticism of new albums, songs and artists. Not chart news, tour dates, gig reports or release announcements.',
  design: 'design criticism and ideas across the whole field: architecture, interiors, industrial and product design, graphic design and branding, typography and type design. New buildings, new products, new identities, new typefaces. Not sponsored content, shopping roundups, competition notices or firm news.',
  fashion: 'menswear criticism and analysis with a strong American lean: new collections, new brands and labels, how men dress now, clothing as culture and craft. Not shopping guides, gift guides, brand-partner content, celebrity outfit posts, or watch, fragrance and gear reviews.',
};

/** "The Guardian (menswear)" -> "The Guardian": one outlet, however many feeds. */
const outlet = (name) => String(name || '').replace(/\s*\([^)]*\)\s*$/, '').trim();

const UA =
  'Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 ' +
  '(KHTML, like Gecko) Chrome/124.0 Safari/537.36';
const FETCH_TIMEOUT_MS = 20000;

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
const num = (name, fallback) => Number(arg(name, String(fallback)));

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

async function httpGet(url) {
  const ctrl = new AbortController();
  const timer = setTimeout(() => ctrl.abort(), FETCH_TIMEOUT_MS);
  try {
    const res = await fetch(url, {
      redirect: 'follow',
      signal: ctrl.signal,
      headers: { 'User-Agent': UA, Accept: 'text/html,application/xhtml+xml,application/xml;q=0.9,*/*;q=0.8' },
    });
    return { ok: res.ok, status: res.status, url: res.url || url, body: await res.text() };
  } catch (err) {
    return { ok: false, status: 0, url, body: '', error: String(err.name || err) };
  } finally {
    clearTimeout(timer);
  }
}

function readJson(file, fallback) {
  try {
    return JSON.parse(fs.readFileSync(file, 'utf8'));
  } catch {
    return fallback;
  }
}
function writeJson(file, data) {
  fs.mkdirSync(path.dirname(file), { recursive: true });
  fs.writeFileSync(file, JSON.stringify(data, null, 2) + '\n');
}

/** Runs `fn` once per work folder; later runs reuse the saved result. */
async function stage(work, name, fn) {
  const file = path.join(work, `${name}.json`);
  if (fs.existsSync(file)) {
    console.log(`  (reusing ${name} from an earlier run)`);
    return readJson(file);
  }
  const result = await fn();
  writeJson(file, result);
  return result;
}

function loadNumbered(dir) {
  if (!fs.existsSync(dir)) return [];
  return fs
    .readdirSync(dir)
    .filter((f) => /^\d{4}\.json$/.test(f))
    .sort()
    .map((f) => readJson(path.join(dir, f), null))
    .filter(Boolean);
}

const clampInt = (n, lo, hi) => Math.max(lo, Math.min(hi, Math.round(Number(n) || lo)));
const words = (s, n) => String(s || '').split(/\s+/).slice(0, n).join(' ');

// ---------------------------------------------------------------------------
// Articles
// ---------------------------------------------------------------------------

const TRIAGE_SYSTEM =
  'You shortlist articles for Troller, a weekly digest of links to the best criticism and ' +
  'long-form cultural writing in English. You see only titles, outlets and excerpts. Favour pieces ' +
  'likely to be criticism, essays, substantial reviews, reported features or serious interviews on ' +
  "the category's subject. Pass over anything that reads as news, an announcement, a listicle, " +
  'shopping, sponsored content, an event listing, a podcast or video post, or something off-subject.';

function triagePrompt(byCat, k) {
  const lines = [`For each category, list up to ${k} candidate ids, most promising first. Use only ids from that category's list.`, ''];
  for (const cat of CATEGORIES) {
    lines.push(`## ${cat}: ${BRIEFS[cat]}`);
    for (const c of byCat[cat] || []) {
      lines.push(`[${c.id}] ${c.title} — ${c.source}${c.published ? ` (${c.published.slice(0, 10)})` : ''}`);
      if (c.summary) lines.push(`    ${L.truncate(c.summary, 160)}`);
    }
    lines.push('');
  }
  return lines.join('\n');
}

const TRIAGE_SCHEMA = {
  type: 'object',
  properties: Object.fromEntries(CATEGORIES.map((c) => [c, { type: 'array', items: { type: 'string' } }])),
  required: CATEGORIES,
  additionalProperties: false,
};

// How to read a category brief. The first live run (24 Oct 2026) read them
// like a contract: a strong essay on war and poetry was rejected under Books
// for not being science fiction, and serious author interviews were turned
// away for "not being criticism". The bar on quality stays exactly where it
// is; this only stops good writing being lost on a technicality.
const BRIEF_RULES =
  'How to read the category brief: "leaning" names a preference, never a requirement, so strong ' +
  'writing in the wider field belongs (any serious literary criticism or essay fits Books, not ' +
  'only science fiction). A substantial interview or profile with real ideas counts as long-form ' +
  'writing. The subject test is about what the piece is mostly about, read generously: an essay ' +
  'on the history or philosophy of technology fits Tech, a design essay about a building fits ' +
  'Design. Pieces mostly about a different field (a film essay under Music, sport under Fashion) ' +
  'are off-subject.';

// New writing about new things (Mike, 24 Oct 2026). The first issue drew
// an appreciation of Rocky and a 25th-anniversary essay on Aphex Twin's
// Drukqs: good writing, wrong brief.
const NEW_RULE =
  'Troller covers new work. about_new is true only if the piece is mainly about something new: ' +
  'a release, exhibition, building, book, comic, collection, label, product, typeface or ' +
  'development from roughly the last three months, or just ahead. Writing that revisits older ' +
  'work (an anniversary, a classic film, an old album, a career retrospective, history) counts ' +
  'only when it is pegged to something new, such as a new reissue, restoration, edition or ' +
  'exhibition. For technology, current developments count as new. A trend piece about how people ' +
  'dress, live, build or design right now is new too.';

const READ_SYSTEM =
  'You screen one article for Troller, a weekly digest of links to the best criticism and ' +
  'long-form cultural writing. You are given the full text. Judge only what is on the page. ' +
  'keep is true only if the piece is criticism, an essay, a substantial review, a reported feature ' +
  "or a serious interview, AND it is on the category's subject, AND it is in English. keep is false " +
  'for news items, announcements, listicles, buying guides, shopping, sponsored or gambling content, ' +
  'job ads, press releases, event listings, podcast or video show notes, and anything off-subject. ' +
  BRIEF_RULES + ' ' + NEW_RULE + ' ' +
  'depth: 1 = nothing to it, 2 = thin, 3 = solid, 4 = strong, 5 = exceptional. ' +
  'reason: at most 15 words on why.';

const READ_SCHEMA = {
  type: 'object',
  properties: {
    keep: { type: 'boolean' },
    about_new: { type: 'boolean' },
    kind: { type: 'string', enum: ['criticism', 'essay', 'review', 'feature', 'interview', 'news', 'listicle', 'shopping', 'promotional', 'other'] },
    depth: { type: 'integer' },
    reason: { type: 'string' },
  },
  required: ['keep', 'about_new', 'kind', 'depth', 'reason'],
  additionalProperties: false,
};

const CHECK_SYSTEM =
  'You are the final editor of Troller, a weekly digest of links to the best criticism and ' +
  'long-form cultural writing, for a demanding reader. You are given one article in full. ' +
  'score from 1 to 10 for how much that reader would want this link: 9-10 a must-read, 7-8 strong, ' +
  '5-6 competent but ordinary, 4 or below should not run. keep is false if it is not substantive ' +
  "criticism or long-form writing on the category's subject, and false if it is not mainly about " +
  'new work. ' + NEW_RULE.replace('about_new is true', 'A piece is new') + ' ' + BRIEF_RULES + ' Judge the writing ' +
  'itself; do not mark a piece down for its format (an interview) or for sitting outside a ' +
  '"leaning". reason: at most 15 words naming its main strength or flaw.';

const CHECK_SCHEMA = {
  type: 'object',
  properties: {
    score: { type: 'integer' },
    keep: { type: 'boolean' },
    reason: { type: 'string' },
  },
  required: ['score', 'keep', 'reason'],
  additionalProperties: false,
};

function articlePrompt(c, text) {
  return [
    `Category: ${c.category} (${BRIEFS[c.category]})`,
    `Outlet: ${c.source}`,
    `Title: ${c.title}`,
    `URL: ${c.url}`,
    '',
    '<article>',
    text,
    '</article>',
  ].join('\n');
}

async function scoutArticles(work, ledger, opts) {
  const feeds = readJson(FEEDS_FILE, null);
  if (!feeds) throw new Error('assets/feeds.json is missing.');
  const issues = loadNumbered(ISSUES_DIR);
  // Repeats are checked against every issue ever published. Rotation counts
  // only weekly issues: the last RSS issues carried 28 links each, two a day,
  // and counting them rested 753 items on the first trial run, leaving 116
  // candidates for a whole week.
  const history = {
    ...L.historyFromIssues(issues),
    rotationCounts: L.historyFromIssues(issues.filter((i) => i.pipeline === 'weekly')).rotationCounts,
  };

  // 1. Feeds and free filters.
  const pool = await stage(work, 'articles-1-candidates', async () => {
    const entries = Object.entries(feeds);
    console.log(`Fetching ${entries.length} feeds...`);
    const bySource = [];
    const fetched = await mapLimit(entries, 12, async ([source, meta]) => {
      const r = await httpGet(meta.feed);
      return { source, meta, items: r.ok ? L.parseFeed(r.body) : [] };
    });
    // --categories design,fashion reruns just those sections (into their own
    // --work folder), so a thin section can be redone without paying again
    // for the rest of the issue.
    const only = arg('categories') ? arg('categories').split(',') : null;
    for (const f of fetched) {
      for (const cat of f.meta.categories || []) {
        if (only && !only.includes(cat)) continue;
        // Outlet, not feed: rotation and the one-per-category rule are about
        // publications, and published issues record the outlet name.
        bySource.push({ source: outlet(f.source), category: cat, items: f.items, tier: f.meta.tier || 'essay' });
      }
    }
    console.log(`  ${fetched.filter((f) => f.items.length).length} of ${entries.length} feeds returned items.`);

    const { candidates, dropped } = L.selectCandidates({
      bySource,
      now: Date.now(),
      windowDays: opts.windowDays,
      seenUrls: history.seenUrls,
      seenTitles: history.seenTitles,
      rotationCounts: history.rotationCounts,
      rotationMax: 2,
      maxPerSource: 4,
    });
    const english = candidates.filter((c) => T.looksEnglish(`${c.title} ${c.summary || ''}`, { minWords: 15 }));
    console.log(
      `  ${english.length} candidates after filters (dropped ${dropped.stale} stale, ${dropped.duplicate} already used, ` +
        `${dropped.junk} junk titles, ${dropped.rested} rested, ${candidates.length - english.length} not English).`,
    );
    return english.map((c, i) => ({ ...c, id: `a${i}` }));
  });

  // 2. Shortlist from titles and excerpts.
  const byCat = {};
  for (const c of pool) (byCat[c.category] = byCat[c.category] || []).push(c);
  for (const cat of CATEGORIES) {
    byCat[cat] = (byCat[cat] || [])
      .sort((a, b) => (a.tier === 'news') - (b.tier === 'news') || (b.published || '').localeCompare(a.published || ''))
      .slice(0, 60);
  }
  const want = opts.readPerCategory + 4; // spares for pages that fail to fetch
  const triage = await stage(work, 'articles-2-shortlist', async () => {
    const prompt = triagePrompt(byCat, want);
    ledger.room('Shortlist', AI.project(AI.MODELS.reader, prompt.length + 1500, 3000));
    console.log('Shortlisting from titles and excerpts...');
    const picks = await AI.askJson(ledger, 'articles: shortlist', {
      model: AI.MODELS.reader, system: TRIAGE_SYSTEM, prompt, schema: TRIAGE_SCHEMA, maxTokens: 6000,
    });
    const out = {};
    for (const cat of CATEGORIES) {
      const valid = new Set((byCat[cat] || []).map((c) => c.id));
      out[cat] = [...new Set(picks[cat] || [])].filter((id) => valid.has(id));
      // Top up from the head of the list if the model returned too few.
      for (const c of byCat[cat] || []) {
        if (out[cat].length >= want) break;
        if (!out[cat].includes(c.id)) out[cat].push(c.id);
      }
    }
    return out;
  });

  // 3. Fetch and cut to the article body.
  const byId = new Map(pool.map((c) => [c.id, c]));
  const texts = await stage(work, 'articles-3-texts', async () => {
    const ids = CATEGORIES.flatMap((cat) => triage[cat] || []);
    console.log(`Fetching ${ids.length} shortlisted articles...`);
    const got = await mapLimit(ids, 8, async (id) => {
      const c = byId.get(id);
      const r = await httpGet(c.url);
      if (!r.ok) return { id, skip: `HTTP ${r.status || r.error}` };
      const lang = T.declaredLanguage(r.body);
      const text = T.extractText(r.body);
      const n = T.wordCount(text);
      if (lang && lang !== 'en') return { id, skip: `page language "${lang}"` };
      if (!T.looksEnglish(text)) return { id, skip: 'not English' };
      if (T.looksPaywalled(text)) return { id, skip: 'paywalled' };
      if (n < opts.minWords) return { id, skip: `only ${n} words` };
      return { id, words: n, text: T.capWords(text, opts.maxWords) };
    });
    const out = {};
    for (const cat of CATEGORIES) {
      const ok = [];
      for (const id of triage[cat] || []) {
        const g = got.find((x) => x.id === id);
        if (g && !g.skip && ok.length < opts.readPerCategory) ok.push(g);
      }
      out[cat] = ok;
    }
    const skipped = got.filter((g) => g.skip).length;
    console.log(`  ${got.length - skipped} readable, ${skipped} skipped for free (dead, thin, paywalled or not English).`);
    return out;
  });

  // 4. Haiku reads each one in full.
  const reads = await stage(work, 'articles-4-reads', async () => {
    const jobs = CATEGORIES.flatMap((cat) => texts[cat].map((t) => ({ ...t, c: byId.get(t.id) })));
    const chars = jobs.reduce((n, j) => n + j.text.length + 1500, 0);
    ledger.room('Reading', AI.project(AI.MODELS.reader, chars, jobs.length * 600));
    console.log(`Reading ${jobs.length} articles in full (Haiku)...`);
    const out = {};
    const errors = [];
    await mapLimit(jobs, 6, async (j) => {
      try {
        const v = await AI.askJson(ledger, 'articles: read', {
          model: AI.MODELS.reader, system: READ_SYSTEM, prompt: articlePrompt(j.c, j.text), schema: READ_SCHEMA, maxTokens: 1500,
        });
        // Old subjects are dropped here in code, not left to the model's keep.
        const isNew = v.about_new !== false;
        out[j.id] = {
          keep: !!v.keep && isNew, about_new: isNew, kind: v.kind, depth: clampInt(v.depth, 1, 5),
          reason: words(isNew ? v.reason : `Not new work. ${v.reason}`, 22),
        };
      } catch (err) {
        errors.push(err.message);
        out[j.id] = { keep: false, kind: 'other', depth: 1, reason: `could not be read: ${err.message}` };
      }
    });
    // A stage is saved only if it mostly worked, so a rerun after (say) a
    // missing API key retries instead of reusing a page of failures.
    if (errors.length > jobs.length / 4) throw new Error(`${errors.length} of ${jobs.length} reads failed: ${errors[0]}`);
    const kept = Object.values(out).filter((v) => v.keep).length;
    console.log(`  ${kept} of ${jobs.length} kept.`);
    return out;
  });

  // 5. Sonnet reads the strongest again and scores them, at batch prices.
  const finalists = {};
  for (const cat of CATEGORIES) {
    finalists[cat] = texts[cat]
      .filter((t) => reads[t.id] && reads[t.id].keep && reads[t.id].depth >= 3)
      .sort((a, b) => reads[b.id].depth - reads[a.id].depth)
      .slice(0, opts.checkPerCategory);
  }
  const checks = await stage(work, 'articles-5-checks', async () => {
    const jobs = CATEGORIES.flatMap((cat) => finalists[cat].map((t) => ({ ...t, c: byId.get(t.id) })));
    if (!jobs.length) return {};
    const batch = !has('no-batch');
    const chars = jobs.reduce((n, j) => n + j.text.length + 1500, 0);
    ledger.room('Editor check', AI.project(AI.MODELS.judge, chars, jobs.length * 1200, { batch }));
    const requests = jobs.map((j) => ({ id: j.id, system: CHECK_SYSTEM, prompt: articlePrompt(j.c, j.text), schema: CHECK_SCHEMA }));
    console.log(`Editor check on ${jobs.length} finalists (Sonnet${batch ? ', Batch API' : ''})...`);

    let results = {};
    if (batch) {
      const idFile = path.join(work, 'articles-5-batch-id.txt');
      const existingId = fs.existsSync(idFile) ? fs.readFileSync(idFile, 'utf8').trim() : null;
      const r = await AI.batchJson(ledger, 'articles: editor check', AI.MODELS.judge, requests, {
        existingId, maxTokens: 3000, onCreated: (id) => fs.writeFileSync(idFile, id),
      });
      if (r.pendingId) {
        throw new Error(`The batch is still running (${r.pendingId}). Run scout again later; it will collect the results without resubmitting.`);
      }
      results = r.results;
    } else {
      await mapLimit(requests, 4, async (q) => {
        try {
          results[q.id] = await AI.askJson(ledger, 'articles: editor check', {
            model: AI.MODELS.judge, system: q.system, prompt: q.prompt, schema: q.schema, maxTokens: 3000,
          });
        } catch { /* left unscored */ }
      });
    }
    const out = {};
    for (const [id, v] of Object.entries(results)) {
      out[id] = { score: clampInt(v.score, 1, 10), keep: !!v.keep, reason: words(v.reason, 20) };
    }
    return out;
  });

  // 6. Rank and pick.
  const ranked = {};
  for (const cat of CATEGORIES) {
    ranked[cat] = texts[cat]
      .map((t) => {
        const c = byId.get(t.id);
        return {
          id: t.id, title: c.title, source: c.source, author: c.author || null, url: c.url,
          published: c.published, words: t.words,
          read: reads[t.id] || null, check: checks[t.id] || null, pick: false,
        };
      })
      .sort((a, b) =>
        (b.check ? b.check.score : 0) - (a.check ? a.check.score : 0) ||
        (b.read ? b.read.depth : 0) - (a.read ? a.read.depth : 0));
  }
  const perOutlet = {};
  for (const cat of CATEGORIES) {
    const used = new Set();
    let n = 0;
    for (const e of ranked[cat]) {
      if (n >= opts.perCategory) break;
      if (!e.check || !e.check.keep || e.check.score < opts.minScore) continue;
      const s = outlet(e.source).toLowerCase();
      if (used.has(s) || (perOutlet[s] || 0) >= 2) continue;
      e.pick = true;
      used.add(s);
      perOutlet[s] = (perOutlet[s] || 0) + 1;
      n++;
    }
  }
  return ranked;
}

// ---------------------------------------------------------------------------
// New Music
// ---------------------------------------------------------------------------

const EXTRACT_SYSTEM =
  'You pull songs out of one music site\'s weekly list or roundup post for a new-music page. ' +
  'List each new song the post recommends. Only songs, not whole albums unless the post names a ' +
  'focus track. Skip songs the post presents as old: reissues, archival releases, or anything ' +
  'released before 2023. note: at most 22 words, in your own words, on what the post says about the ' +
  'song; never invent details. youtube: the id from a (youtube:ID) marker next to that song, else "". ' +
  'bandcamp: the URL from a (bandcamp:URL) marker next to that song, else "".';

const EXTRACT_SCHEMA = {
  type: 'object',
  properties: {
    songs: {
      type: 'array',
      items: {
        type: 'object',
        properties: {
          artist: { type: 'string' },
          title: { type: 'string' },
          note: { type: 'string' },
          youtube: { type: 'string' },
          bandcamp: { type: 'string' },
        },
        required: ['artist', 'title', 'note', 'youtube', 'bandcamp'],
        additionalProperties: false,
      },
    },
  },
  required: ['songs'],
  additionalProperties: false,
};

const PICK_SYSTEM =
  'You choose the next batch of songs for a personal new-music page. Lean toward what the listener ' +
  'liked and away from what they disliked, and spread the picks across sources. Candidates come from ' +
  'an archive of music sites\' weekly lists back to 2025, strongest first: songs on several sites\' ' +
  'lists lead, then the newest. Favour those, but mix in a few distinctive finds. Return candidate ids only.';

const PICK_SCHEMA = {
  type: 'object',
  properties: { picks: { type: 'array', items: { type: 'string' } } },
  required: ['picks'],
  additionalProperties: false,
};

const artistKey = (a) => String(a || '').toLowerCase().replace(/^the\s+/, '').replace(/[^a-z0-9]+/g, ' ').trim();
const slug = (s) => String(s || '').toLowerCase().replace(/[^a-z0-9]+/g, '-').replace(/^-|-$/g, '').slice(0, 60);

function shortDate(iso) {
  if (!iso) return '';
  const d = new Date(iso);
  return d.toLocaleDateString('en-US', { month: 'short', day: 'numeric', timeZone: 'UTC' });
}

const MONTHS3 = ['jan', 'feb', 'mar', 'apr', 'may', 'jun', 'jul', 'aug', 'sep', 'oct', 'nov', 'dec'];

/**
 * A post's date from its address, for archives that list links without dates.
 *   ".../essential-releases-february-20-2026"  (Bandcamp Daily)
 *   "/music/2026/oct/23/add-to-playlist-..."     (the Guardian)
 */
function dateFromUrl(url) {
  let m = url.match(/-([a-z]+)-(\d{1,2})-(\d{4})\/?$/i);
  if (m && !Number.isNaN(Date.parse(`${m[1]} ${m[2]}, ${m[3]} UTC`))) return new Date(`${m[1]} ${m[2]}, ${m[3]} UTC`).toISOString();
  m = url.match(/\/(\d{4})\/([a-z]{3})\/(\d{1,2})\//i);
  if (m && MONTHS3.includes(m[2].toLowerCase())) return new Date(Date.UTC(+m[1], MONTHS3.indexOf(m[2].toLowerCase()), +m[3])).toISOString();
  // ".../best-new-ambient-september-2026" (Bandcamp's monthly genre columns)
  m = url.match(/-([a-z]+)-(\d{4})\/?$/i);
  if (m && MONTHS3.includes(m[1].slice(0, 3).toLowerCase())) return new Date(Date.UTC(+m[2], MONTHS3.indexOf(m[1].slice(0, 3).toLowerCase()), 1)).toISOString();
  return null;
}

/**
 * Bandcamp's older Essential Releases addresses drop the year
 * (".../essential-releases-jul-17"). The archive runs newest first, so the
 * year is the year of the last dated post, or one less once the month
 * jumps forward (December after January).
 */
function inferDate(url, prevIso) {
  const m = url.match(/-([a-z]+)-(\d{1,2})\/?$/i);
  if (!m || !prevIso || !MONTHS3.includes(m[1].slice(0, 3).toLowerCase())) return null;
  const month = MONTHS3.indexOf(m[1].slice(0, 3).toLowerCase());
  const prev = new Date(prevIso);
  const year = month > prev.getUTCMonth() ? prev.getUTCFullYear() - 1 : prev.getUTCFullYear();
  return new Date(Date.UTC(year, month, +m[2])).toISOString();
}

/**
 * Every weekly list post a source has published since `since`, newest first.
 * Free: feeds, archive pages and Substack's archive data, no model calls.
 * Four kinds of source, set in assets/music-sources.json:
 *   wp-feed   a WordPress feed, paged with ?paged=N (Stereogum, Various Small Flames)
 *   html-list an archive page with ?page=N whose links carry the date (Bandcamp Daily)
 *   substack  Substack's archive data, paged by offset (WBRU)
 *   index     one page linking only the latest post (The Line of Best Fit: no archive)
 */
async function discoverPosts(name, src, since) {
  const sinceMs = Date.parse(since);
  const re = src.match ? new RegExp(src.match, 'i') : null;
  const out = [];
  // One site can have several sources (Bandcamp Daily's genre columns): the
  // source's `site` names the site, and its `label` names the column.
  const keep = (p) => p.url && (!p.published || Date.parse(p.published) >= sinceMs) &&
    out.push({ site: src.site || name, label: src.label || null, ...p });

  if (src.type === 'wp-feed') {
    for (let page = 1; page <= (src.maxPages || 30); page++) {
      const r = await httpGet(`${src.url}${src.url.includes('?') ? '&' : '?'}paged=${page}`);
      const items = r.ok ? L.parseFeed(r.body) : [];
      if (!items.length) break;
      for (const it of items) if (!re || re.test(it.title)) keep({ title: it.title, url: it.link, published: it.published });
      const oldest = items.map((i) => i.published).filter(Boolean).sort()[0];
      if (oldest && Date.parse(oldest) < sinceMs) break;
    }
  } else if (src.type === 'html-list') {
    const seen = new Set();
    let lastDate = null;
    for (let page = 1; page <= (src.maxPages || 10); page++) {
      const r = await httpGet(src.url.replace('{n}', page));
      if (!r.ok) break;
      const links = [...new Set([...r.body.matchAll(new RegExp(`href=["']([^"'#]*${src.linkMatch}[^"'#]*)["']`, 'gi'))]
        .map((m) => new URL(m[1], src.url).toString()))].filter((u) => !seen.has(u));
      // Past the end, some archives (the Guardian's) loop back to page 1.
      if (!links.length) break;
      let older = false;
      for (const url of links) {
        seen.add(url);
        const published = dateFromUrl(url) || inferDate(url, lastDate);
        if (published) lastDate = published;
        if (published && Date.parse(published) < sinceMs) { older = true; continue; }
        keep({ title: src.label, url, published });
      }
      if (older) break;
    }
  } else if (src.type === 'substack') {
    for (let offset = 0; offset < 1000; offset += 50) {
      const r = await httpGet(`${src.url}/api/v1/archive?sort=new&offset=${offset}&limit=50`);
      let posts = [];
      try { posts = r.ok ? JSON.parse(r.body) : []; } catch { posts = []; }
      if (!Array.isArray(posts) || !posts.length) break;
      for (const p of posts) if (!re || re.test(p.title || '')) keep({ title: p.title, url: p.canonical_url, published: p.post_date });
      if (Date.parse(posts[posts.length - 1].post_date) < sinceMs) break;
    }
  } else if (src.type === 'index') {
    const r = await httpGet(src.url);
    if (r.ok) {
      const links = [...new Set([...r.body.matchAll(new RegExp(`href=["']((?:https?://[^"']*)?/[^"']*${src.linkMatch}[^"']*)["']`, 'gi'))]
        .map((m) => new URL(m[1], src.url).toString()))];
      for (const url of links.slice(0, src.maxPosts || 1)) keep({ title: src.label, url, published: new Date().toISOString() });
    }
  }
  return out;
}

/**
 * The song pool: every song ever pulled from a list post, keyed by post, so
 * no post is read (and paid for) twice. Committed with the site, so the
 * GitHub button and a local run share it. Each refresh adds the newest
 * posts it has not read yet, which is how Song Troll digs back to 2025.
 */
const POOL_FILE = path.join(MUSIC_DIR, 'pool.json');

/**
 * The link text under each song: "The 5 Best Songs Of The Week, Aug 7",
 * "Essential Releases, Jul 17", "Track review, Oct 22". A source's own label
 * wins over the post title (Pitchfork's titles are just the song), and a
 * title that already carries its date ("Today's Top Indie: September 15,
 * 2026") is not dated twice.
 */
function postLabel(p, sources) {
  const base = String(p.label || (sources[p.site] && sources[p.site].label) || p.title || '').replace(/,\s*\d{4}-\d{2}-\d{2}$/, '').trim();
  return /\b20\d{2}\b/.test(base)
    ? L.truncate(base, 44)
    : [L.truncate(base, 40), shortDate(p.published)].filter(Boolean).join(', ');
}
function loadPool() {
  return readJson(POOL_FILE, { about: 'Songs pulled from music list posts, by post URL. Written by scripts/weekly.js songs.', posts: {} });
}
function savePool(pool) {
  fs.writeFileSync(POOL_FILE, JSON.stringify(pool, null, 1) + '\n');
}

async function scoutMusic(work, ledger, opts) {
  const sources = readJson(MUSIC_SOURCES_FILE, {});
  const taste = readJson(TASTE_FILE, { exclude: [], liked: [], disliked: [] });
  const batches = loadNumbered(MUSIC_DIR);
  const shownArtists = new Set(batches.flatMap((b) => b.items.map((i) => artistKey(i.artist))));
  const blocked = new Set([
    ...(taste.exclude || []).map(artistKey),
    ...(taste.disliked || []).map((s) => artistKey(String(s).split(' – ')[0])),
  ]);
  const pool = loadPool();

  const posts = await stage(work, 'music-1-posts', async () => {
    console.log(`Finding music list posts back to ${opts.since}...`);
    const found = (await Promise.all(Object.entries(sources).map(([n, s]) => discoverPosts(n, s, opts.since)))).flat();
    const unread = found
      .filter((p) => !pool.posts[p.url])
      .sort((a, b) => (b.published || '').localeCompare(a.published || ''));
    const bySite = {};
    for (const p of found) bySite[p.site] = (bySite[p.site] || 0) + 1;
    console.log(`  ${found.length} list posts since ${opts.since} (${Object.entries(bySite).map(([s, n]) => `${s} ${n}`).join(', ')}); ` +
      `${found.length - unread.length} already in the pool, ${unread.length} unread.`);
    const take = unread.slice(0, opts.posts);
    const out = [];
    // Gentle by default on big runs: Bandcamp throttled a 6-at-a-time backfill.
    await mapLimit(take, num('fetch-concurrency', take.length > 40 ? 2 : 6), async (p) => {
      const r = await httpGet(p.url);
      if (!r.ok) return;
      const text = T.capWords(T.extractText(r.body, { media: true }), 4000);
      if (T.wordCount(text) >= 80) out.push({ ...p, text });
    });
    console.log(out.length > 12
      ? `  Reading ${out.length} unread posts, ${(out[out.length - 1].published || '').slice(0, 10)} to ${(out[0].published || '').slice(0, 10)}.`
      : `  Reading ${out.length} unread: ${out.map((p) => `${p.site} ${(p.published || '').slice(0, 10)}`).join(', ') || 'none, the archive is up to date'}.`);
    return out;
  });

  await stage(work, 'music-2-songs', async () => {
    // Many posts (the one-time backfill) go through the Batch API at half
    // price; a normal refresh has a handful and is quicker one by one.
    const batch = posts.length > 8 && !has('no-batch');
    const chars = posts.reduce((n, p) => n + p.text.length + 1200, 0);
    ledger.room('Music extraction', AI.project(AI.MODELS.reader, chars, posts.length * 2500, { batch }));
    console.log(`Pulling songs out of ${posts.length} posts (Haiku${batch ? ', Batch API' : ''})...`);
    const errors = [];
    let added = 0;
    const promptFor = (p) => `Site: ${p.site}\nPost: ${p.title}\nURL: ${p.url}\n\n<post>\n${p.text}\n</post>`;
    const file = (p, r) => {
      const songs = (r.songs || []).filter((s) => s.artist && s.title).map((s) => ({
        artist: s.artist.trim(), title: s.title.trim(), note: words(s.note, 26),
        yt: /^[\w-]{6,}$/.test(s.youtube || '') ? s.youtube : null,
        bc: /^https?:\/\/[a-z0-9-]+\.bandcamp\.com\//i.test(s.bandcamp || '') ? s.bandcamp : null,
      }));
      pool.posts[p.url] = {
        site: p.site, title: p.title, ...(p.label ? { label: p.label } : {}), published: p.published,
        read: new Date().toISOString().slice(0, 10), songs,
      };
      added += songs.length;
    };
    if (batch) {
      const idFile = path.join(work, 'music-2-batch-id.txt');
      const ids = new Map(posts.map((p, i) => [`p${i}`, p]));
      const r = await AI.batchJson(ledger, 'music: extract', AI.MODELS.reader,
        [...ids].map(([id, p]) => ({ id, system: EXTRACT_SYSTEM, prompt: promptFor(p), schema: EXTRACT_SCHEMA })),
        { maxTokens: 6000, effort: 'low', existingId: fs.existsSync(idFile) ? fs.readFileSync(idFile, 'utf8').trim() : null,
          onCreated: (id) => fs.writeFileSync(idFile, id) });
      if (r.pendingId) throw new Error(`The batch is still running (${r.pendingId}). Run songs again with --work ${path.relative(ROOT, work)} to collect it.`);
      for (const [id, res] of Object.entries(r.results)) file(ids.get(id), res);
      for (const id of r.failed) errors.push(`${ids.get(id).site} ${ids.get(id).url}`);
    } else {
      await mapLimit(posts, 4, async (p) => {
        try {
          file(p, await AI.askJson(ledger, 'music: extract', {
            model: AI.MODELS.reader, system: EXTRACT_SYSTEM, maxTokens: 6000, schema: EXTRACT_SCHEMA, prompt: promptFor(p),
          }));
        } catch (err) {
          errors.push(err.message);
          console.log(`  could not read ${p.site}: ${err.message}`);
        }
      });
    }
    if (posts.length && errors.length > posts.length / 3) throw new Error(`${errors.length} of ${posts.length} music posts failed: ${errors[0]}`);
    savePool(pool);
    console.log(`  ${added} songs added to the pool (${Object.keys(pool.posts).length} posts read so far).`);
    return { added };
  });

  // Candidates come from the whole archive. The quality signal is agreement:
  // a song several sites put on their lists ranks first, then the newest.
  // Free filters: no artist already on the page, nothing excluded or
  // disliked, one song per artist.
  const all = Object.entries(pool.posts)
    .sort((a, b) => (b[1].published || '').localeCompare(a[1].published || ''))
    .flatMap(([url, p]) => p.songs.map((s) => ({
      ...s, site: p.site, published: p.published,
      src: { label: postLabel(p, sources), url },
    })));
  const songKey = (s) => `${artistKey(s.artist)}|${String(s.title).toLowerCase().replace(/[^a-z0-9]+/g, ' ').trim()}`;
  const sitesFor = new Map();
  for (const s of all) {
    const k = songKey(s);
    if (!sitesFor.has(k)) sitesFor.set(k, new Set());
    sitesFor.get(k).add(s.site);
  }
  const seen = new Set();
  const fresh = [];
  for (const s of all) {
    const k = artistKey(s.artist);
    if (!k || seen.has(k) || shownArtists.has(k) || blocked.has(k)) continue;
    // --years 2026, or 2025,2026: a refresh limited to those years' lists.
    if (opts.years && !opts.years.has((s.published || '').slice(0, 4))) continue;
    seen.add(k);
    const lists = [...sitesFor.get(songKey(s))];
    fresh.push({ ...s, lists });
  }
  fresh.sort((a, b) => b.lists.length - a.lists.length || (b.published || '').localeCompare(a.published || ''));
  fresh.forEach((s, i) => { s.cid = `m${i}`; });
  console.log(`  ${all.length} songs in the archive, ${fresh.length} new to you` +
    `${opts.years ? ` from ${[...opts.years].join(', ')}` : ''}, ` +
    `${fresh.filter((s) => s.lists.length > 1).length} on more than one site's list.`);
  if (opts.archiveOnly) return [];
  // Keep the picking prompt small: the strongest unshown candidates only.
  fresh.splice(opts.candidates);

  const picked = await stage(work, 'music-3-picks', async () => {
    if (fresh.length <= opts.songs) return fresh.map((s) => s.cid);
    const prompt = [
      `Choose ${opts.songs} songs.`,
      `Liked before: ${(taste.liked || []).join('; ') || 'none yet'}.`,
      `Disliked before: ${(taste.disliked || []).join('; ') || 'none yet'}.`,
      '',
      ...fresh.map((s) => `[${s.cid}] ${s.artist} – ${s.title} (${s.lists.length > 1 ? `on ${s.lists.length} lists: ${s.lists.join(', ')}` : s.site}, ${(s.published || '').slice(0, 7)}): ${s.note}`),
    ].join('\n');
    ledger.room('Music picks', AI.project(AI.MODELS.judge, prompt.length + 800, 3000));
    console.log(`Picking ${opts.songs} songs (Sonnet)...`);
    const r = await AI.askJson(ledger, 'music: pick', {
      model: AI.MODELS.judge, system: PICK_SYSTEM, prompt, schema: PICK_SCHEMA, maxTokens: 4000,
    });
    const valid = new Set(fresh.map((s) => s.cid));
    return [...new Set(r.picks || [])].filter((id) => valid.has(id)).slice(0, opts.songs);
  });

  const chosen = new Set(picked);
  return fresh.map((s) => ({ ...s, pick: chosen.has(s.cid) }));
}

// ---------------------------------------------------------------------------
// Shortlist file
// ---------------------------------------------------------------------------

function shortlistMarkdown(date, articles, music, ledger) {
  const out = [`# Troller shortlist, ${date}`, ''];
  out.push('Ticked entries are the default picks. To change them, set `"pick"` in shortlist.json, or ask Claude.', '');
  const names = { art: 'Fine Art', film: 'Film', tech: 'Tech & AI', lit: 'Literary', music: 'Music Criticism', design: 'Design', fashion: "Men's Fashion" };
  for (const cat of CATEGORIES) {
    const list = articles[cat] || [];
    out.push(`## ${names[cat]} (${list.filter((e) => e.pick).length} picked)`, '');
    for (const e of list) {
      const score = e.check ? `${e.check.score}/10` : e.read ? `depth ${e.read.depth}/5` : '–';
      const why = (e.check && e.check.reason) || (e.read && e.read.reason) || '';
      out.push(`- [${e.pick ? 'x' : ' '}] **${score}** [${e.title}](${e.url}), ${e.source} (${e.id}). ${why}`);
    }
    out.push('');
  }
  if (music.length) out.push(`## Song Troll (${music.filter((s) => s.pick).length} picked)`, '');
  for (const s of music) {
    out.push(`- [${s.pick ? 'x' : ' '}] ${s.artist} – ${s.title} (${s.site}, ${s.cid}). ${s.note}`);
  }
  out.push('', '## Cost', '');
  for (const [k, v] of Object.entries(ledger.byStage())) out.push(`- ${k}: $${v.toFixed(3)}`);
  out.push(`- **Total: $${ledger.spent.toFixed(3)}** of the $${ledger.cap.toFixed(2)} cap`, '');
  return out.join('\n');
}

// ---------------------------------------------------------------------------
// Commands
// ---------------------------------------------------------------------------

function options() {
  return {
    perCategory: num('per-category', 5),
    // Widened after the first live run, which read 73 articles for $0.145
    // and found only 9 worth running: the budget was going unused.
    readPerCategory: num('read-per-category', 20),
    checkPerCategory: num('check-per-category', 8),
    minScore: num('min-score', 6),
    windowDays: num('window-days', 14),
    minWords: num('min-words', 600),
    maxWords: num('max-words', 3000),
    // Ten a batch by default: enough to explore, few enough to listen to.
    songs: num('songs', 10),
    // Song Troll's archive reaches back to 2023 (Mike, 24 Oct 2026). Each
    // refresh reads this many unread list posts, newest first, into it.
    since: arg('since', '2023-01-01'),
    // Which years a refresh draws from: "all" (default), "2026", "2025,2026".
    years: (() => {
      const v = String(arg('years', 'all')).trim().toLowerCase();
      if (!v || v === 'all') return null;
      return new Set(v.split(/[,\s]+/).filter((y) => /^\d{4}$/.test(y)));
    })(),
    posts: num('posts', 20),
    candidates: num('candidates', 150),
    cap: num('cap', 1),
  };
}

async function scout(date, work) {
  const opts = options();
  const ledger = new AI.Ledger({ cap: opts.cap, file: path.join(work, 'cost.json') });
  console.log(`Scouting the issue for ${date}. Work folder: ${path.relative(ROOT, work)}\n`);

  // News Troll only. Song Troll refreshes on its own schedule, by hand, with
  // `node scripts/weekly.js songs` or the button on its page (Mike, 24 Oct 2026).
  const articles = await scoutArticles(work, ledger, opts);
  const music = [];

  writeJson(path.join(work, 'shortlist.json'), { date, articles, music });
  fs.writeFileSync(path.join(work, 'shortlist.md'), shortlistMarkdown(date, articles, music, ledger));

  console.log('\nPicked:');
  for (const cat of CATEGORIES) {
    const list = articles[cat] || [];
    console.log(`  ${cat.padEnd(8)} ${list.filter((e) => e.pick).length} of ${list.length} read`);
  }
  console.log(`\nSpent $${ledger.spent.toFixed(3)} (cap $${ledger.cap.toFixed(2)}).`);
  console.log(`Review: ${path.relative(ROOT, path.join(work, 'shortlist.md'))}`);
  console.log(`Then:   node scripts/weekly.js publish --date ${date}`);
}

async function publish(date, work) {
  const opts = options();
  const ledger = new AI.Ledger({ cap: opts.cap, file: path.join(work, 'cost.json') });
  const shortlist = readJson(path.join(work, 'shortlist.json'), null);
  if (!shortlist) throw new Error(`No shortlist for ${date}. Run: node scripts/weekly.js scout --date ${date}`);

  const categories = CATEGORIES.map((key) => ({
    key,
    entries: (shortlist.articles[key] || []).filter((e) => e.pick).map((e) => ({
      title: e.title, author: e.author || null, source: outlet(e.source), summary: '', why: '', url: e.url,
      // Honest now: every picked entry was fetched and read in full, twice.
      verified: true,
    })),
  }));
  const entries = categories.flatMap((c) => c.entries);

  // No cover line. Issues are titled plainly by number and week (Mike's call,
  // 24 Oct 2026); the automated versions wrote tabloid headlines.
  const outlets = new Set(entries.map((e) => e.source.toLowerCase())).size;
  const issueNo = loadNumbered(ISSUES_DIR).length + 1;
  const intro =
    `${entries.length} pieces of criticism from ${outlets} publications, each read in full before it was picked.`;

  const issue = {
    issue: issueNo,
    date,
    headline: `Issue ${issueNo}`,
    intro: intro.trim(),
    byline: `Issue No. ${issueNo} — week of ${date}`,
    pipeline: 'weekly',
    categories,
  };
  const issueFile = path.join(ISSUES_DIR, `${String(issueNo).padStart(4, '0')}.json`);
  writeJson(issueFile, issue);
  console.log(`Wrote ${path.relative(ROOT, issueFile)}: ${entries.length} links.`);

  for (const script of [['validate.js', path.relative(ROOT, issueFile)], ['build.js']]) {
    const r = spawnSync(process.execPath, [path.join(__dirname, script[0]), ...script.slice(1)], { cwd: ROOT, stdio: 'inherit' });
    if (r.status !== 0) throw new Error(`${script[0]} failed. Nothing has been committed.`);
  }
  console.log(`\nIssue No. ${issueNo} is built locally. Total spent on it: $${ledger.spent.toFixed(3)}. Nothing has been committed or pushed.`);
}

/**
 * Folds thumbs from the Song Troll page ("Copy my thumbs") into
 * music/taste.json, so the next batch leans toward them. Accepts the JSON
 * the button copies: { "liked": [...], "disliked": [...] }.
 */
function mergeTaste(raw) {
  if (!raw || !String(raw).trim()) return;
  let incoming;
  try {
    incoming = JSON.parse(raw);
  } catch {
    throw new Error('The thumbs pasted in are not valid JSON. Use the "Copy my thumbs" button on Song Troll.');
  }
  const taste = readJson(TASTE_FILE, { exclude: [], liked: [], disliked: [] });
  const union = (a, b) => [...new Set([...(a || []), ...(b || [])].map((s) => String(s).trim()).filter(Boolean))];
  taste.liked = union(taste.liked, incoming.liked);
  taste.disliked = union(taste.disliked, incoming.disliked);
  // A song can only be one or the other; the newest thumb wins.
  const nowLiked = new Set(incoming.liked || []);
  const nowDisliked = new Set(incoming.disliked || []);
  taste.liked = taste.liked.filter((s) => !nowDisliked.has(s));
  taste.disliked = taste.disliked.filter((s) => !nowLiked.has(s));
  writeJson(TASTE_FILE, taste);
  console.log(`Thumbs merged: ${taste.liked.length} liked, ${taste.disliked.length} disliked in music/taste.json.`);
}

/**
 * Song Troll refresh, separate from News Troll. Reads any list posts
 * published since the last refresh into the archive (music/pool.json, never
 * shown on the site), picks a batch of 10 from the whole archive with your
 * thumbs, writes the next music/NNNN.json and rebuilds. A few cents. Run by
 * hand, or from the "Refresh Song Troll" button, which opens the manual-only
 * GitHub workflow (.github/workflows/song-troll.yml).
 *
 *   songs --backfill   one time: read every list post back to --since
 *                      (2025-01-01) into the archive, at Batch API prices,
 *                      and pick nothing. Under $1 for ~400 posts.
 */
async function songs(date) {
  const opts = options();
  if (has('backfill')) {
    opts.posts = Infinity;
    opts.archiveOnly = true;
    opts.cap = num('cap', 5);
  }
  mergeTaste(arg('taste') || process.env.TROLLER_TASTE || '');

  // A fresh folder per refresh: the stages cache, and a second refresh on the
  // same day should look again rather than reuse the first.
  const stamp = new Date().toISOString().slice(0, 16).replace(/[:T]/g, '-');
  const work = arg('work') ? path.resolve(ROOT, arg('work')) : path.join(ROOT, '.work', `songs-${stamp}`);
  fs.mkdirSync(work, { recursive: true });
  const ledger = new AI.Ledger({ cap: opts.cap, file: path.join(work, 'cost.json') });
  console.log(`Refreshing Song Troll. Work folder: ${path.relative(ROOT, work)}\n`);

  const picked = (await scoutMusic(work, ledger, opts)).filter((s) => s.pick);
  if (opts.archiveOnly) {
    console.log(`\nArchive built. Spent $${ledger.spent.toFixed(3)}. No batch written; refreshes now pick from it.`);
    return;
  }
  if (!picked.length) {
    console.log('\nNo new songs this time; nothing written.');
    return;
  }

  const batchNo = loadNumbered(MUSIC_DIR).length + 1;
  const batch = {
    batch: batchNo,
    date,
    items: picked.map((s) => ({
      id: `${slug(s.artist)}-${slug(s.title)}`, site: s.site, src: s.src, artist: s.artist, title: s.title,
      note: s.note, ...(s.yt ? { yt: s.yt } : {}), ...(s.bc ? { bc: s.bc } : {}), batch: batchNo,
      // The year of the list it was picked from; the page's Year filter uses it.
      ...(s.published ? { year: Number(s.published.slice(0, 4)) } : {}),
    })),
  };
  const musicFile = path.join(MUSIC_DIR, `${String(batchNo).padStart(4, '0')}.json`);
  writeJson(musicFile, batch);
  console.log(`\nWrote ${path.relative(ROOT, musicFile)}: batch ${batchNo}, ${picked.length} songs.`);

  const r = spawnSync(process.execPath, [path.join(__dirname, 'build.js')], { cwd: ROOT, stdio: 'inherit' });
  if (r.status !== 0) throw new Error('build.js failed.');
  console.log(`Spent $${ledger.spent.toFixed(3)}.`);
}

async function main() {
  const cmd = process.argv[2];
  const date = arg('date') || new Date().toISOString().slice(0, 10);
  if (!/^\d{4}-\d{2}-\d{2}$/.test(date)) throw new Error(`Invalid --date: ${date}`);
  if (cmd === 'songs') return songs(date);

  const work = arg('work') ? path.resolve(ROOT, arg('work')) : path.join(ROOT, '.work', date);
  fs.mkdirSync(work, { recursive: true });

  if (cmd === 'scout') return scout(date, work);
  if (cmd === 'publish') return publish(date, work);
  console.log('Usage: node scripts/weekly.js scout|publish|songs [--date YYYY-MM-DD]');
  process.exit(1);
}

if (require.main === module) {
  main().catch((err) => {
    console.error(`\nFAILED: ${err.message}`);
    process.exit(1);
  });
}

module.exports = { BRIEFS, CATEGORIES, triagePrompt, shortlistMarkdown, artistKey, postLabel, dateFromUrl };
