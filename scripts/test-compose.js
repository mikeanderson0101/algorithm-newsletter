#!/usr/bin/env node
/**
 * Algorithm — tests for compose-from-feeds.js pure logic.
 *
 * Run: node scripts/test-compose.js
 *
 * The point of these is the failure modes. A model that returns fenced
 * JSON, invented ids, ids from the wrong category, duplicates, a missing
 * category, or prose instead of JSON must all degrade into a slightly
 * duller issue — never a crash and never a wrong link. Each of those is
 * pinned below.
 */

'use strict';

const C = require('./compose-from-feeds.js');

let passed = 0;
let failed = 0;
const failures = [];

function check(name, actual, expected) {
  const a = JSON.stringify(actual);
  const e = JSON.stringify(expected);
  if (a === e) passed++;
  else {
    failed++;
    failures.push(`${name}\n     expected: ${e}\n     actual:   ${a}`);
  }
}
function ok(name, cond, detail = '') {
  if (cond) passed++;
  else {
    failed++;
    failures.push(`${name}${detail ? '\n     ' + detail : ''}`);
  }
}
function throws(name, fn) {
  try {
    fn();
    failed++;
    failures.push(`${name}\n     expected a throw, got none`);
  } catch {
    passed++;
  }
}

// --- fixture -------------------------------------------------------------

function cand(cat, n) {
  return {
    title: `${cat} title ${n}`,
    url: `https://${cat}.example/${n}`,
    source: `${cat} Source ${n}`,
    category: cat,
    author: n % 2 ? `Author ${n}` : null,
    published: `2026-09-1${n % 10}T00:00:00.000Z`,
    summary: `Excerpt for ${cat} ${n}.`,
  };
}

const grouped = {};
for (const cat of C.CATEGORIES) grouped[cat] = [cand(cat, 1), cand(cat, 2), cand(cat, 3)];

const { withIds, index } = C.assignIds(grouped);

// --- id assignment -------------------------------------------------------

check('assignIds: all categories present', Object.keys(withIds).sort(), [...C.CATEGORIES].sort());
check('assignIds: total indexed', index.size, C.CATEGORIES.length * 3);
ok('assignIds: ids are unique and sequential',
  [...index.keys()].join(',') === [...index.keys()].map((_, i) => i).join(','));
check('assignIds: first id is 0', withIds.art[0].id, 0);
ok('assignIds: category preserved on item', index.get(0).category === 'art');

// --- prompt --------------------------------------------------------------

const prompt = C.buildPrompt(withIds, { date: '2026-09-14', perCategory: 2 });
ok('prompt: mentions the date', prompt.includes('2026-09-14'));
for (const cat of C.CATEGORIES) {
  ok(`prompt: has ${cat} section`, prompt.includes(`## ${cat}`));
}
ok('prompt: includes candidate ids in brackets', prompt.includes('[0]'));
ok('prompt: includes excerpt text', prompt.includes('Excerpt for art 1.'));
ok('prompt: forbids inventing summaries', /must not pretend|Do not\s+write summaries/i.test(prompt));
ok('prompt: states the per-category count', prompt.includes('exactly 2 id(s) per'));

const emptyPrompt = C.buildPrompt(
  { ...withIds, fashion: [] },
  { date: '2026-09-14', perCategory: 2 },
);
ok('prompt: empty category rendered explicitly', emptyPrompt.includes('(none available)'));

// --- model JSON parsing --------------------------------------------------

check('parse: plain object',
  C.parseModelJson('{"headline":"A *B*","intro":"i","picks":{}}').headline, 'A *B*');
check('parse: fenced json',
  C.parseModelJson('```json\n{"headline":"X","picks":{}}\n```').headline, 'X');
check('parse: bare fence',
  C.parseModelJson('```\n{"headline":"Y","picks":{}}\n```').headline, 'Y');
check('parse: leading prose',
  C.parseModelJson('Sure! Here you go:\n{"headline":"Z","picks":{}}').headline, 'Z');
check('parse: trailing prose',
  C.parseModelJson('{"headline":"W","picks":{}}\nHope that helps!').headline, 'W');
throws('parse: empty string throws', () => C.parseModelJson(''));
throws('parse: null throws', () => C.parseModelJson(null));
throws('parse: no object throws', () => C.parseModelJson('no json at all'));
throws('parse: malformed json throws', () => C.parseModelJson('{"a": }'));

// --- resolvePicks: the happy path ---------------------------------------

const good = {
  headline: 'The *Feed* Speaks',
  intro: 'One. Two.',
  picks: Object.fromEntries(
    C.CATEGORIES.map((cat) => [cat, [withIds[cat][0].id, withIds[cat][2].id]]),
  ),
};
const goodRes = C.resolvePicks(good, withIds, index, { perCategory: 2 });
check('resolve: seven categories', goodRes.categories.length, 7);
check('resolve: two entries each',
  goodRes.categories.map((c) => c.entries.length), [2, 2, 2, 2, 2, 2, 2]);
check('resolve: no warnings on clean input', goodRes.warnings, []);
check('resolve: picks the requested items',
  goodRes.categories[0].entries.map((e) => e.title), ['art title 1', 'art title 3']);
check('resolve: url carried through',
  goodRes.categories[0].entries[0].url, 'https://art.example/1');
check('resolve: publisher excerpt used as summary',
  goodRes.categories[0].entries[0].summary, 'Excerpt for art 1.');
check('resolve: why left empty (we did not read it)',
  goodRes.categories[0].entries[0].why, '');
check('resolve: null author preserved as null',
  goodRes.categories[0].entries[1].author, 'Author 3');

// --- resolvePicks: hostile model output ---------------------------------

// Hallucinated id
const badId = { picks: { ...good.picks, art: [9999, withIds.art[1].id] } };
const badIdRes = C.resolvePicks(badId, withIds, index, { perCategory: 2 });
check('resolve: invalid id dropped but count preserved',
  badIdRes.categories[0].entries.length, 2);
ok('resolve: warns about invalid id',
  badIdRes.warnings.some((w) => w.includes('9999')), badIdRes.warnings.join(' | '));
ok('resolve: no entry has an undefined url',
  badIdRes.categories.every((c) => c.entries.every((e) => typeof e.url === 'string' && e.url)));

// Cross-category id
const crossCat = { picks: { ...good.picks, art: [withIds.film[0].id, withIds.art[0].id] } };
const crossRes = C.resolvePicks(crossCat, withIds, index, { perCategory: 2 });
ok('resolve: rejects id from another category',
  crossRes.categories[0].entries.every((e) => e.url.startsWith('https://art.')),
  JSON.stringify(crossRes.categories[0].entries.map((e) => e.url)));
ok('resolve: warns about cross-category id',
  crossRes.warnings.some((w) => w.includes('belongs to')));

// Duplicate ids
const dup = { picks: { ...good.picks, art: [0, 0] } };
const dupRes = C.resolvePicks(dup, withIds, index, { perCategory: 2 });
check('resolve: duplicate id not used twice',
  new Set(dupRes.categories[0].entries.map((e) => e.url)).size, 2);
ok('resolve: warns about repeat', dupRes.warnings.some((w) => w.includes('repeated')));

// Missing category
const missing = { picks: { ...good.picks } };
delete missing.picks.fashion;
const missRes = C.resolvePicks(missing, withIds, index, { perCategory: 2 });
check('resolve: missing category still produced',
  missRes.categories.find((c) => c.key === 'fashion').entries.length, 2);
ok('resolve: warns about missing category',
  missRes.warnings.some((w) => w.includes('fashion')));

// Wrong types
const wrongTypes = { picks: { art: 'nope', film: null, tech: [{}], lit: [1.5] } };
const wrongRes = C.resolvePicks(wrongTypes, withIds, index, { perCategory: 2 });
check('resolve: survives wrong types', wrongRes.categories.length, 7);
ok('resolve: still fills every category',
  wrongRes.categories.every((c) => c.entries.length === 2));

// Null / undefined parsed object (model failed entirely)
const nullRes = C.resolvePicks(null, withIds, index, { perCategory: 2 });
check('resolve: null parsed object backfills fully', nullRes.categories.length, 7);
ok('resolve: backfill fills all slots',
  nullRes.categories.every((c) => c.entries.length === 2));
ok('resolve: backfill takes newest first',
  nullRes.categories[0].entries[0].title === 'art title 1');

// Pool smaller than requested
const thin = { art: [cand('art', 1)] };
for (const cat of C.CATEGORIES) if (cat !== 'art') thin[cat] = [];
const { withIds: thinIds, index: thinIndex } = C.assignIds(thin);
const thinRes = C.resolvePicks(null, thinIds, thinIndex, { perCategory: 2 });
check('resolve: thin pool yields what it can',
  thinRes.categories.find((c) => c.key === 'art').entries.length, 1);
check('resolve: empty pool yields zero entries',
  thinRes.categories.find((c) => c.key === 'film').entries.length, 0);
ok('resolve: warns about shortfall',
  thinRes.warnings.some((w) => w.includes('only 1 of 2')));

// --- one entry per publication per category ------------------------------
// validate.js rejects two entries from the same publication in one
// category as a hard ERROR. The first live run died here: the model chose
// both design picks from The Architectural Review. Pinned so it cannot
// regress.
{
  const dupSrc = {};
  for (const cat of C.CATEGORIES) dupSrc[cat] = [];
  // Three candidates in art, two sharing a publication.
  dupSrc.art = [
    { ...cand('art', 1), source: 'Same Press' },
    { ...cand('art', 2), source: 'Same Press' },
    { ...cand('art', 3), source: 'Other Press' },
  ];
  const { withIds: dIds, index: dIdx } = C.assignIds(dupSrc);

  // Model explicitly asks for both from the same publication.
  const res = C.resolvePicks(
    { picks: { art: [dIds.art[0].id, dIds.art[1].id] } },
    dIds, dIdx, { perCategory: 2 },
  );
  const artSources = res.categories.find((c) => c.key === 'art').entries.map((e) => e.source);
  check('one-per-pub: model duplicate publication rejected',
    new Set(artSources).size, artSources.length);
  check('one-per-pub: still returns two entries', artSources.length, 2);
  ok('one-per-pub: second entry came from the other publication',
    artSources.includes('Other Press'), artSources.join(', '));
  ok('one-per-pub: warns when skipping',
    res.warnings.some((w) => w.includes('already used in this category')),
    res.warnings.join(' | '));

  // Backfill must respect the rule too.
  const bf = C.resolvePicks(null, dIds, dIdx, { perCategory: 2 });
  const bfSources = bf.categories.find((c) => c.key === 'art').entries.map((e) => e.source);
  check('one-per-pub: backfill does not duplicate a publication',
    new Set(bfSources).size, bfSources.length);

  // Only one publication available: yield one entry, never an invalid two.
  const single = { };
  for (const cat of C.CATEGORIES) single[cat] = [];
  single.art = [
    { ...cand('art', 1), source: 'Only Press' },
    { ...cand('art', 2), source: 'Only Press' },
  ];
  const { withIds: sIds, index: sIdx } = C.assignIds(single);
  const sRes = C.resolvePicks(null, sIds, sIdx, { perCategory: 2 });
  check('one-per-pub: single-publication category yields one entry',
    sRes.categories.find((c) => c.key === 'art').entries.length, 1);
}

const promptRule = C.buildPrompt(withIds, { date: '2026-09-14', perCategory: 2 });
ok('prompt: states the one-publication-per-category rule',
  /different publications/i.test(promptRule));

// --- buildIssue ----------------------------------------------------------

const issue = C.buildIssue({ date: '2026-09-14', parsed: good, categories: goodRes.categories });
check('buildIssue: placeholder issue number', issue.issue, 1);
check('buildIssue: date', issue.date, '2026-09-14');
check('buildIssue: headline carried', issue.headline, 'The *Feed* Speaks');
check('buildIssue: seven categories', issue.categories.length, 7);
ok('buildIssue: no pulse field', !('pulse' in issue));

const fallback = C.buildIssue({ date: '2026-09-14', parsed: null, categories: goodRes.categories });
ok('buildIssue: falls back to a headline', typeof fallback.headline === 'string' && fallback.headline.length > 0);
ok('buildIssue: falls back to an intro', fallback.intro.length > 10);

const junkHeadline = C.buildIssue({
  date: '2026-09-14',
  parsed: { headline: 123, intro: [] },
  categories: goodRes.categories,
});
ok('buildIssue: ignores non-string headline', typeof junkHeadline.headline === 'string');
ok('buildIssue: ignores non-string intro', typeof junkHeadline.intro === 'string');

// --- sanitizer: the draft must always survive validate.js ----------------
// Four consecutive live runs died at validation over data the composer had
// in hand. The sanitizer now guarantees the fatal checks pass; these pin it.
{
  const mk = (over = {}) => ({
    title: 'A Title', author: 'A', source: 'Some Source',
    summary: 'Text.', why: '', url: 'https://real.example/a', verified: true, ...over,
  });
  const cats = () => C.CATEGORIES.map((k) => ({ key: k, entries: [mk(), mk({ url: 'https://real.example/b', title: 'B Title' })] }));

  // empty summary survives (publisher shipped none) but is normalised
  {
    const c = cats(); c[0].entries[0].summary = undefined;
    const r = C.sanitizeIssue(c, {});
    check('sanitize: missing summary kept as empty string',
      r.categories[0].entries[0].summary, '');
    check('sanitize: entry not dropped for missing summary',
      r.categories[0].entries.length, 2);
  }
  // bad URL dropped
  {
    const c = cats(); c[0].entries[0].url = 'not-a-url';
    const r = C.sanitizeIssue(c, {});
    check('sanitize: invalid URL dropped', r.categories[0].entries.length, 1);
    ok('sanitize: reports the drop', r.dropped.some((d) => d.includes('no usable URL')));
  }
  // placeholder URL dropped
  {
    const c = cats(); c[0].entries[0].url = 'https://example.com/x';
    const r = C.sanitizeIssue(c, {});
    check('sanitize: placeholder URL dropped', r.categories[0].entries.length, 1);
  }
  // cross-category duplicate URL dropped (a publication mapped to 2 categories)
  {
    const c = cats(); c[1].entries[0].url = c[0].entries[0].url;
    const r = C.sanitizeIssue(c, {});
    const urls = r.categories.flatMap((x) => x.entries.map((e) => e.url));
    check('sanitize: no duplicate URL across the issue',
      new Set(urls).size, urls.length);
  }
  // duplicate title across categories dropped
  {
    const c = cats(); c[1].entries[0].title = c[0].entries[0].title;
    const r = C.sanitizeIssue(c, {});
    const ts = r.categories.flatMap((x) => x.entries.map((e) => e.title.toLowerCase()));
    check('sanitize: no duplicate title across the issue', new Set(ts).size, ts.length);
  }
  // already-published URL dropped
  {
    const c = cats();
    const r = C.sanitizeIssue(c, { seenUrls: new Set(['https://real.example/a']) });
    ok('sanitize: previously published URL dropped',
      !r.categories.flatMap((x) => x.entries).some((e) => e.url === 'https://real.example/a'));
  }
  // missing title / source dropped
  {
    const c = cats(); c[0].entries[0].title = '   '; c[0].entries[1].source = '';
    const r = C.sanitizeIssue(c, {});
    check('sanitize: untitled and sourceless entries dropped',
      r.categories[0].entries.length, 0);
  }
  // verified is forced true
  {
    const c = cats(); c[0].entries[0].verified = false;
    const r = C.sanitizeIssue(c, {});
    check('sanitize: verified normalised to true',
      r.categories[0].entries[0].verified, true);
  }
}

// --- four entries per category -------------------------------------------
// The newsletter moved to 4 per category on 19 Sept 2026. The
// one-publication-per-category rule must still hold at the higher count,
// and a category with too few distinct publications must degrade rather
// than repeat a masthead.
{
  const wide = {};
  for (const cat of C.CATEGORIES) {
    wide[cat] = [1, 2, 3, 4, 5, 6].map((n) => ({ ...cand(cat, n), source: `${cat} Pub ${n}` }));
  }
  const { withIds: wIds, index: wIdx } = C.assignIds(wide);
  const res = C.resolvePicks(
    { picks: Object.fromEntries(C.CATEGORIES.map((c) => [c, wIds[c].slice(0, 4).map((x) => x.id)])) },
    wIds, wIdx, { perCategory: 4 },
  );
  check('four: every category has four entries',
    res.categories.map((c) => c.entries.length), [4, 4, 4, 4, 4, 4, 4]);
  for (const c of res.categories) {
    const srcs = c.entries.map((e) => e.source);
    ok(`four: ${c.key} has four distinct publications`,
      new Set(srcs).size === 4, srcs.join(', '));
  }

  // Only three distinct publications available -> three entries, not a repeat.
  const thin3 = {};
  for (const cat of C.CATEGORIES) thin3[cat] = [];
  thin3.art = [1, 2, 3, 4].map((n) => ({ ...cand('art', n), source: `Pub ${Math.min(n, 3)}` }));
  const { withIds: tIds, index: tIdx } = C.assignIds(thin3);
  const tRes = C.resolvePicks(null, tIds, tIdx, { perCategory: 4 });
  const tSrc = tRes.categories.find((c) => c.key === 'art').entries.map((e) => e.source);
  check('four: thin category yields distinct publications only', new Set(tSrc).size, tSrc.length);
  check('four: thin category yields three, not four', tSrc.length, 3);

  const p4 = C.buildPrompt(wIds, { date: '2026-09-20', perCategory: 4 });
  ok('four: prompt asks for four', p4.includes('exactly 4 id(s) per'));
}

// --- report --------------------------------------------------------------

console.log('');
if (failed) {
  console.log(`FAILED: ${failed} of ${passed + failed}\n`);
  for (const f of failures) console.log('  \u2717 ' + f);
  console.log('');
  process.exit(1);
}
console.log(`All ${passed} assertions passed.`);
