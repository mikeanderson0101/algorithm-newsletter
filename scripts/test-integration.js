#!/usr/bin/env node
/**
 * Algorithm — end-to-end integration test.
 *
 * Run: node scripts/test-integration.js
 *
 * Drives the REAL compose-from-feeds.js main() against a stubbed
 * global.fetch, in a temporary repo laid out like the real one. Nothing is
 * re-implemented here — the fetch loop, candidate selection, prompt build,
 * response handling, link check and draft write are all the shipping code.
 *
 * Then it runs the real validate.js against the draft that was produced,
 * so the two halves of the pipeline are checked against each other rather
 * than in isolation. That seam is where this project has repeatedly
 * broken: each piece worked, the handoff did not.
 */

'use strict';

const fs = require('fs');
const path = require('path');
const os = require('os');
const { execFileSync } = require('child_process');

const REPO = path.resolve(__dirname, '..');

let passed = 0;
let failed = 0;
const failures = [];
function ok(name, cond, detail = '') {
  if (cond) passed++;
  else {
    failed++;
    failures.push(`${name}${detail ? '\n     ' + detail : ''}`);
  }
}
function check(name, a, e) {
  ok(name, JSON.stringify(a) === JSON.stringify(e), `expected ${JSON.stringify(e)}, got ${JSON.stringify(a)}`);
}

// --- build a temp repo ---------------------------------------------------

const TMP = fs.mkdtempSync(path.join(os.tmpdir(), 'algo-itest-'));
fs.mkdirSync(path.join(TMP, 'scripts'), { recursive: true });
fs.mkdirSync(path.join(TMP, 'issues'), { recursive: true });
fs.mkdirSync(path.join(TMP, 'assets'), { recursive: true });
for (const f of ['feed-lib.js', 'compose-from-feeds.js', 'validate.js']) {
  fs.copyFileSync(path.join(REPO, 'scripts', f), path.join(TMP, 'scripts', f));
}

const CATS = ['art', 'film', 'tech', 'lit', 'music', 'design', 'fashion'];
const SOURCES = {};
for (const cat of CATS) {
  // fashion deliberately gets a single publication, mirroring the real
  // source list where fashion has only four working feeds. A category with
  // one publication must yield ONE entry, not two from the same masthead —
  // validate.js rejects the latter, which is how the first live run died.
  const count = cat === 'fashion' ? 1 : 6;
  for (let n = 1; n <= count; n++) SOURCES[`${cat}Src${n}`] = cat;
}

const feedsJson = {};
for (const [name, cat] of Object.entries(SOURCES)) {
  feedsJson[name] = { feed: `https://feeds.test/${name}`, categories: [cat], confidence: 'stated' };
}
// A feed that 500s and one that returns junk: neither may break the run.
feedsJson.DeadSrc = { feed: 'https://feeds.test/DEAD', categories: ['art'], confidence: 'stated' };
feedsJson.JunkSrc = { feed: 'https://feeds.test/JUNK', categories: ['art'], confidence: 'stated' };
fs.writeFileSync(path.join(TMP, 'assets', 'feeds.json'), JSON.stringify(feedsJson, null, 2));

// One prior issue, so dedup and rotation history are genuinely exercised.
const priorUrl = 'https://articles.test/artSrc1/0';
fs.writeFileSync(
  path.join(TMP, 'issues', '0001.json'),
  JSON.stringify({
    issue: 1,
    date: '2026-09-01',
    headline: 'Prior *Issue*',
    intro: 'x. y. z.',
    byline: 'b',
    categories: CATS.map((k) => ({
      key: k,
      entries: [
        { title: `prior ${k} A`, author: 'A', source: `${k}Src1`, summary: 's', why: 'w', url: `https://articles.test/${k}Src1/0`, verified: true },
        { title: `prior ${k} B`, author: 'B', source: `${k}Src2`, summary: 's', why: 'w', url: `https://articles.test/${k}Src2/0`, verified: true },
      ],
    })),
  }, null, 2),
);

// --- stub the network ----------------------------------------------------

const nowMs = Date.now();
const rfc822 = (daysAgo) => new Date(nowMs - daysAgo * 86400000).toUTCString();

function feedXml(name) {
  const items = [
    // Deliberately hostile, mirroring real feeds: item 0 has NO description
    // at all (this is what broke the 19 Sept run), item 1 has no author,
    // item 2 is normal, item 3 is too old.
    { t: `${name} fresh one`, d: 1, i: 0, desc: false, author: true },
    { t: `${name} fresh two`, d: 2, i: 1, desc: true, author: false },
    { t: `${name} fresh three`, d: 4, i: 2, desc: true, author: true },
    { t: `${name} ancient`, d: 400, i: 3, desc: true, author: true },
  ];
  return `<?xml version="1.0"?><rss version="2.0" xmlns:dc="http://purl.org/dc/elements/1.1/"><channel>
<title>${name}</title>
${items.map((it) => `<item><title>${it.t} &amp; co</title><link>https://articles.test/${name}/${it.i}</link><pubDate>${rfc822(it.d)}</pubDate>${it.author ? `<dc:creator>Writer ${it.i}</dc:creator>` : ''}${it.desc ? `<description><![CDATA[<p>Excerpt for ${it.t}.</p>]]></description>` : '<description></description>'}</item>`).join('\n')}
</channel></rss>`;
}

const calls = { feeds: 0, api: 0, head: 0 };
let apiPrompt = null;
let apiResponder = null;

global.fetch = async (url, opts = {}) => {
  const u = String(url);

  if (u === 'https://api.anthropic.com/v1/messages') {
    calls.api++;
    apiPrompt = JSON.parse(opts.body).messages[0].content;
    const text = apiResponder(apiPrompt);
    return {
      ok: true,
      status: 200,
      json: async () => ({
        content: [{ type: 'text', text }],
        usage: { input_tokens: 1234, output_tokens: 567 },
      }),
    };
  }

  if (u.startsWith('https://feeds.test/')) {
    calls.feeds++;
    const name = u.split('/').pop();
    if (name === 'DEAD') return { ok: false, status: 500, text: async () => '' };
    if (name === 'JUNK') return { ok: true, status: 200, text: async () => '<html>no</html>' };
    return { ok: true, status: 200, text: async () => feedXml(name) };
  }

  if (u.startsWith('https://articles.test/')) {
    calls.head++;
    // One specific article is dead, to prove the link check drops it.
    if (u.endsWith('/artSrc3/1')) return { ok: false, status: 404, text: async () => '' };
    return { ok: true, status: 200, text: async () => 'ok' };
  }

  throw new Error(`unexpected fetch: ${u}`);
};

// --- run -----------------------------------------------------------------

const C = require(path.join(TMP, 'scripts', 'compose-from-feeds.js'));
const DRAFT = path.join(TMP, 'issues', '_draft.json');

const origLog = console.log;
const logLines = [];
console.log = (...a) => logLines.push(a.join(' '));

async function run(argv, responder) {
  apiResponder = responder;
  logLines.length = 0;
  process.argv = ['node', 'compose-from-feeds.js', ...argv];
  if (fs.existsSync(DRAFT)) fs.unlinkSync(DRAFT);
  await C.main();
  return fs.existsSync(DRAFT) ? JSON.parse(fs.readFileSync(DRAFT, 'utf8')) : null;
}

/** Asks for two picks from the SAME publication in every category. */
function greedyResponder(prompt) {
  const picks = {};
  for (const cat of CATS) {
    const section = prompt.split(`## ${cat} `)[1] || '';
    const lines = [...section.matchAll(/^\s*\[(\d+)\]\s+(.+?) — (.+?)(?: \(|$)/gm)];
    const bySrc = {};
    for (const m of lines) (bySrc[m[3]] = bySrc[m[3]] || []).push(Number(m[1]));
    const biggest = Object.values(bySrc).sort((a, b) => b.length - a.length)[0] || [];
    picks[cat] = biggest.slice(0, 2);
  }
  return JSON.stringify({ headline: 'Greedy *Picks*', intro: 'a. b.', picks });
}

/** A well-behaved model: picks the first two valid ids per category. */
function goodResponder(prompt) {
  const picks = {};
  for (const cat of CATS) {
    const section = prompt.split(`## ${cat} `)[1] || '';
    const ids = [...section.matchAll(/^\s*\[(\d+)\]/gm)].map((m) => Number(m[1]));
    picks[cat] = ids.slice(0, 2);
  }
  return JSON.stringify({ headline: 'Machines *Read* Again', intro: 'One. Two. Three.', picks });
}

(async () => {
  process.env.ANTHROPIC_API_KEY = 'test-key-not-real';

  // === 1. happy path ====================================================
  const issue = await run(['--date', '2026-09-14'], goodResponder);

  ok('e2e: draft written', issue !== null);
  check('e2e: exactly one API call', calls.api, 1);
  check('e2e: placeholder issue number', issue.issue, 1);
  check('e2e: date honoured', issue.date, '2026-09-14');
  check('e2e: seven categories', issue.categories.length, 7);
  check('e2e: headline from model', issue.headline, 'Machines *Read* Again');

  ok('e2e: a broken feed did not abort the run',
    logLines.some((l) => l.includes('problem feed')), logLines.join('\n'));

  const allEntries = issue.categories.flatMap((c) => c.entries);
  ok('e2e: every entry has an https url',
    allEntries.every((e) => /^https:\/\//.test(e.url)));
  ok('e2e: no stale items selected',
    !allEntries.some((e) => e.title.includes('ancient')),
    allEntries.map((e) => e.title).join(' | '));
  ok('e2e: entities decoded in titles',
    allEntries.every((e) => !e.title.includes('&amp;')),
    allEntries.map((e) => e.title).find((t) => t.includes('&amp;')) || '');
  // A summary may legitimately be empty — some feeds ship no <description>.
  // What matters is that it is always a string and never contains markup.
  ok('e2e: summaries are strings with no markup',
    allEntries.every((e) => typeof e.summary === 'string' && !e.summary.includes('<p>')));
  ok('e2e: at least some summaries carry a publisher excerpt',
    allEntries.some((e) => e.summary.length > 0));
  ok('e2e: previously published URL not reused',
    !allEntries.some((e) => e.url === priorUrl), priorUrl);
  ok('e2e: dead link dropped by link check',
    !allEntries.some((e) => e.url.endsWith('/artSrc3/1')));

  // Rotation: artSrc1 and artSrc2 each ran once in issue 1, so they are
  // still eligible (cap is 2). Nothing should be silently excluded.
  ok('e2e: rotation did not empty any category',
    issue.categories.every((c) => c.entries.length >= 1),
    JSON.stringify(issue.categories.map((c) => [c.key, c.entries.length])));

  // === 2. the model returns garbage ====================================
  const junk = await run(['--date', '2026-09-14'], () => 'I am sorry, I cannot help with that.');
  ok('garbage: still wrote a draft', junk !== null);
  check('garbage: seven categories anyway', junk.categories.length, 7);
  ok('garbage: entries backfilled',
    junk.categories.every((c) => c.entries.length >= 1));
  ok('garbage: fell back to a headline', typeof junk.headline === 'string' && junk.headline.length > 0);

  // === 3. the model invents ids ========================================
  const liar = await run(['--date', '2026-09-14'], () =>
    JSON.stringify({
      headline: 'X *Y*',
      intro: 'a. b.',
      picks: Object.fromEntries(CATS.map((c) => [c, [99991, 99992]])),
    }),
  );
  ok('hallucinated ids: draft still valid', liar !== null);
  ok('hallucinated ids: every url is real',
    liar.categories.flatMap((c) => c.entries).every((e) => e.url.startsWith('https://articles.test/')));

  // === 3b. model insists on one publication per category ===============
  const greedy = await run(['--date', '2026-09-14'], greedyResponder);
  for (const c of greedy.categories) {
    const srcs = c.entries.map((e) => e.source);
    ok(`one-per-pub: ${c.key} has no repeated publication`,
      new Set(srcs).size === srcs.length, srcs.join(', '));
  }
  check('one-per-pub: single-publication category yields one entry',
    greedy.categories.find((c) => c.key === 'fashion').entries.length, 1);

  // === 3c. hostile feeds: empty descriptions must not fail the run =====
  const hostile = await run(['--date', '2026-09-14'], goodResponder);
  ok('hostile: draft still written', hostile !== null);
  ok('hostile: every entry has a string summary',
    hostile.categories.flatMap((c) => c.entries).every((e) => typeof e.summary === 'string'));
  ok('hostile: every entry has a real URL',
    hostile.categories.flatMap((c) => c.entries).every((e) => /^https:\/\//.test(e.url)));
  {
    const urls = hostile.categories.flatMap((c) => c.entries.map((e) => e.url));
    check('hostile: no duplicate URLs across the issue', new Set(urls).size, urls.length);
  }

  // === 3d. four entries per category, end to end =======================
  const four = await run(['--date', '2026-09-14', '--per-category', '4'], goodResponder);
  ok('four: draft written', four !== null);
  for (const c of four.categories) {
    const srcs = c.entries.map((e) => e.source);
    ok(`four: ${c.key} publications are distinct`,
      new Set(srcs).size === srcs.length, srcs.join(', '));
    ok(`four: ${c.key} has at most four entries`, c.entries.length <= 4, String(c.entries.length));
  }
  ok('four: a healthy category actually reaches four',
    four.categories.find((c) => c.key === 'art').entries.length === 4,
    String(four.categories.find((c) => c.key === 'art').entries.length));

  // === 4. validate.js accepts the draft ================================
  console.log = origLog;
  let validateOut = '';
  let validateCode = 0;
  try {
    validateOut = execFileSync('node', [path.join(TMP, 'scripts', 'validate.js'), DRAFT], {
      cwd: TMP,
      encoding: 'utf8',
      stdio: ['ignore', 'pipe', 'pipe'],
    });
  } catch (err) {
    validateCode = err.status || 1;
    validateOut = (err.stdout || '') + (err.stderr || '');
  }
  ok('validate: accepts the generated draft', validateCode === 0,
    validateOut.split('\n').filter((l) => l.includes('ERROR')).slice(0, 6).join('\n'));

  // --- report ------------------------------------------------------------
  fs.rmSync(TMP, { recursive: true, force: true });
  console.log('');
  if (failed) {
    console.log(`FAILED: ${failed} of ${passed + failed}\n`);
    for (const f of failures) console.log('  \u2717 ' + f);
    console.log('');
    process.exit(1);
  }
  console.log(`All ${passed} integration assertions passed.`);
})().catch((err) => {
  console.log = origLog;
  console.error('\nIntegration test crashed:', err);
  process.exit(1);
});
