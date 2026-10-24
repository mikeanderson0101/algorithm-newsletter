#!/usr/bin/env node
/**
 * Troller — make an issue, by hand, once or twice a week.
 *
 *   node scripts/weekly.js scout    [--date YYYY-MM-DD]   builds the shortlist
 *   node scripts/weekly.js publish  [--date YYYY-MM-DD]   writes the issue + music batch, validates, builds
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
 * NEW MUSIC
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
  'focus track. note: at most 22 words, in your own words, on what the post says about the song; ' +
  'never invent details. youtube: the id from a (youtube:ID) marker next to that song, else "". ' +
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
  'liked and away from what they disliked, and spread the picks across sources. Return candidate ids only.';

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

async function findListPosts(name, src, windowDays) {
  const cutoff = Date.now() - windowDays * 86400000;
  if (src.feed) {
    const r = await httpGet(src.feed);
    if (!r.ok) return [];
    const re = new RegExp(src.match, 'i');
    return L.parseFeed(r.body)
      .filter((it) => re.test(it.title) && (!it.published || Date.parse(it.published) >= cutoff))
      .slice(0, src.maxPosts || 2)
      .map((it) => ({ site: name, title: it.title, url: it.link, published: it.published }));
  }
  if (src.index) {
    const r = await httpGet(src.index);
    if (!r.ok) return [];
    const re = new RegExp(`href=["']((?:https?://[^"']*)?/[^"']*${src.linkMatch}[^"']*)["']`, 'gi');
    const links = [...new Set([...r.body.matchAll(re)].map((m) => new URL(m[1], src.index).toString()))];
    return links.slice(0, src.maxPosts || 1).map((url) => ({ site: name, title: src.label, url, published: null }));
  }
  return [];
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

  const posts = await stage(work, 'music-1-posts', async () => {
    console.log('Finding this week\'s music list posts...');
    const found = (await Promise.all(Object.entries(sources).map(([n, s]) => findListPosts(n, s, opts.musicWindowDays)))).flat();
    const out = [];
    await mapLimit(found, 6, async (p) => {
      const r = await httpGet(p.url);
      if (!r.ok) return;
      const text = T.capWords(T.extractText(r.body, { media: true }), 4000);
      if (T.wordCount(text) >= 80) out.push({ ...p, text });
    });
    console.log(`  ${out.length} list posts: ${out.map((p) => p.site).join(', ') || 'none'}.`);
    return out;
  });

  const songs = await stage(work, 'music-2-songs', async () => {
    const chars = posts.reduce((n, p) => n + p.text.length + 1200, 0);
    ledger.room('Music extraction', AI.project(AI.MODELS.reader, chars, posts.length * 2500));
    console.log(`Pulling songs out of ${posts.length} posts (Haiku)...`);
    const all = [];
    const errors = [];
    await mapLimit(posts, 4, async (p) => {
      try {
        const r = await AI.askJson(ledger, 'music: extract', {
          model: AI.MODELS.reader, system: EXTRACT_SYSTEM, maxTokens: 6000, schema: EXTRACT_SCHEMA,
          prompt: `Site: ${p.site}\nPost: ${p.title}\nURL: ${p.url}\n\n<post>\n${p.text}\n</post>`,
        });
        for (const s of r.songs || []) {
          if (!s.artist || !s.title) continue;
          all.push({
            artist: s.artist.trim(), title: s.title.trim(), note: words(s.note, 26),
            yt: /^[\w-]{6,}$/.test(s.youtube || '') ? s.youtube : null,
            bc: /^https?:\/\/[a-z0-9-]+\.bandcamp\.com\//i.test(s.bandcamp || '') ? s.bandcamp : null,
            site: p.site,
            src: { label: [L.truncate(p.title, 40), shortDate(p.published)].filter(Boolean).join(', '), url: p.url },
          });
        }
      } catch (err) {
        errors.push(err.message);
        console.log(`  could not read ${p.site}: ${err.message}`);
      }
    });
    if (posts.length && errors.length > posts.length / 3) throw new Error(`${errors.length} of ${posts.length} music posts failed: ${errors[0]}`);
    return all;
  });

  // Free filters: no repeats, nothing excluded or disliked, one song per artist.
  const seen = new Set();
  const fresh = [];
  for (const s of songs) {
    const k = artistKey(s.artist);
    if (!k || seen.has(k) || shownArtists.has(k) || blocked.has(k)) continue;
    seen.add(k);
    fresh.push({ ...s, cid: `m${fresh.length}` });
  }
  console.log(`  ${songs.length} songs found, ${fresh.length} new to you.`);

  const picked = await stage(work, 'music-3-picks', async () => {
    if (fresh.length <= opts.songs) return fresh.map((s) => s.cid);
    const prompt = [
      `Choose ${opts.songs} songs.`,
      `Liked before: ${(taste.liked || []).join('; ') || 'none yet'}.`,
      `Disliked before: ${(taste.disliked || []).join('; ') || 'none yet'}.`,
      '',
      ...fresh.map((s) => `[${s.cid}] ${s.artist} – ${s.title} (${s.site}): ${s.note}`),
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
  out.push(`## Song Troll (${music.filter((s) => s.pick).length} picked)`, '');
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
    songs: num('songs', 20),
    musicWindowDays: num('music-window-days', 16),
    cap: num('cap', 1),
  };
}

async function scout(date, work) {
  const opts = options();
  const ledger = new AI.Ledger({ cap: opts.cap, file: path.join(work, 'cost.json') });
  console.log(`Scouting the issue for ${date}. Work folder: ${path.relative(ROOT, work)}\n`);

  const articles = has('music-only') ? {} : await scoutArticles(work, ledger, opts);
  console.log('');
  const music = has('articles-only') ? [] : await scoutMusic(work, ledger, opts);

  writeJson(path.join(work, 'shortlist.json'), { date, articles, music });
  fs.writeFileSync(path.join(work, 'shortlist.md'), shortlistMarkdown(date, articles, music, ledger));

  console.log('\nPicked:');
  for (const cat of CATEGORIES) {
    const list = articles[cat] || [];
    console.log(`  ${cat.padEnd(8)} ${list.filter((e) => e.pick).length} of ${list.length} read`);
  }
  console.log(`  songs    ${music.filter((s) => s.pick).length}`);
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
  const songs = (shortlist.music || []).filter((s) => s.pick);

  // No cover line. Issues are titled plainly by number and week (Mike's call,
  // 24 Oct 2026); the automated versions wrote tabloid headlines.
  const outlets = new Set(entries.map((e) => e.source.toLowerCase())).size;
  const issueNo = loadNumbered(ISSUES_DIR).length + 1;
  const intro =
    `${entries.length} pieces of criticism from ${outlets} publications, each read in full before it was picked. ` +
    (songs.length ? `Plus ${songs.length} new songs in Song Troll.` : '');

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

  if (songs.length) {
    const batchNo = loadNumbered(MUSIC_DIR).length + 1;
    const batch = {
      batch: batchNo,
      date,
      items: songs.map((s) => ({
        id: `${slug(s.artist)}-${slug(s.title)}`, site: s.site, src: s.src, artist: s.artist, title: s.title,
        note: s.note, ...(s.yt ? { yt: s.yt } : {}), ...(s.bc ? { bc: s.bc } : {}), batch: batchNo,
      })),
    };
    const musicFile = path.join(MUSIC_DIR, `${String(batchNo).padStart(4, '0')}.json`);
    writeJson(musicFile, batch);
    console.log(`Wrote ${path.relative(ROOT, musicFile)}: ${songs.length} songs.`);
  }

  for (const script of [['validate.js', path.relative(ROOT, issueFile)], ['build.js']]) {
    const r = spawnSync(process.execPath, [path.join(__dirname, script[0]), ...script.slice(1)], { cwd: ROOT, stdio: 'inherit' });
    if (r.status !== 0) throw new Error(`${script[0]} failed. Nothing has been committed.`);
  }
  console.log(`\nIssue No. ${issueNo} is built locally. Total spent on it: $${ledger.spent.toFixed(3)}. Nothing has been committed or pushed.`);
}

async function main() {
  const cmd = process.argv[2];
  const date = arg('date') || new Date().toISOString().slice(0, 10);
  if (!/^\d{4}-\d{2}-\d{2}$/.test(date)) throw new Error(`Invalid --date: ${date}`);
  const work = arg('work') ? path.resolve(ROOT, arg('work')) : path.join(ROOT, '.work', date);
  fs.mkdirSync(work, { recursive: true });

  if (cmd === 'scout') return scout(date, work);
  if (cmd === 'publish') return publish(date, work);
  console.log('Usage: node scripts/weekly.js scout|publish [--date YYYY-MM-DD]');
  process.exit(1);
}

if (require.main === module) {
  main().catch((err) => {
    console.error(`\nFAILED: ${err.message}`);
    process.exit(1);
  });
}

module.exports = { BRIEFS, CATEGORIES, triagePrompt, shortlistMarkdown, artistKey };
