#!/usr/bin/env node
/**
 * Algorithm — tests for feed-lib.js.
 *
 * Run: node scripts/test-feed-lib.js
 * Exits non-zero on any failure, so it can gate the workflow.
 *
 * Every fixture here is modelled on a shape that occurs in the real source
 * list: WordPress RSS 2.0 (the majority), Atom (GitHub, Ghost, several
 * European outlets), RDF/RSS 1.0 (a few older academic journals), CDATA
 * bodies, double-encoded entities, relative or missing links, undated
 * items, and future-dated items. Each of those has broken a naive parser
 * at some point, which is why they are pinned here rather than discovered
 * in production.
 */

'use strict';

const L = require('./feed-lib.js');

let passed = 0;
let failed = 0;
const failures = [];

function check(name, actual, expected) {
  const a = JSON.stringify(actual);
  const e = JSON.stringify(expected);
  if (a === e) {
    passed++;
  } else {
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

// ===========================================================================
// Text handling
// ===========================================================================

check('decodeEntities: named', L.decodeEntities('Art &amp; Design'), 'Art & Design');
check('decodeEntities: numeric', L.decodeEntities('caf&#233;'), 'caf\u00E9');
check('decodeEntities: hex', L.decodeEntities('&#x2014;dash'), '\u2014dash');
check('decodeEntities: double-encoded', L.decodeEntities('A &amp;amp; B'), 'A & B');
check('decodeEntities: unknown left alone', L.decodeEntities('&zzz; x'), '&zzz; x');
check('decodeEntities: empty', L.decodeEntities(''), '');
check('decodeEntities: null-safe', L.decodeEntities(null), '');

check('stripHtml: tags', L.stripHtml('<p>Hello <b>world</b></p>'), 'Hello world');
check('stripHtml: script removed', L.stripHtml('a<script>var x=1<2;</script>b'), 'a b');
check('stripHtml: style removed', L.stripHtml('a<style>p{}</style>b'), 'a b');
check('stripHtml: br becomes space', L.stripHtml('a<br/>b'), 'a b');
check('stripHtml: collapses whitespace', L.stripHtml('a\n\n   b\t c'), 'a b c');
check('stripHtml: entities after tags', L.stripHtml('<p>Tom &amp; Jerry</p>'), 'Tom & Jerry');

check('truncate: under limit untouched', L.truncate('short', 20), 'short');
ok('truncate: cuts long input', L.truncate('a'.repeat(500), 100).length <= 101);
// Must not end mid-word: the last character before the ellipsis should
// complete a word present in the input.
{
  const src = 'the quick brown fox jumps over the lazy dog again and again';
  const t = L.truncate(src, 30);
  const body = t.replace(/\u2026$/, '');
  ok('truncate: ends on a word boundary',
    src.startsWith(body) && (src[body.length] === ' ' || src.length === body.length),
    `got: "${t}"`);
  ok('truncate: appends ellipsis when cut', t.endsWith('\u2026'), `got: "${t}"`);
}

// ===========================================================================
// Feed parsing — RSS 2.0
// ===========================================================================

const RSS2 = `<?xml version="1.0" encoding="UTF-8"?>
<rss version="2.0" xmlns:dc="http://purl.org/dc/elements/1.1/"
     xmlns:content="http://purl.org/rss/1.0/modules/content/">
  <channel>
    <title>Example Review</title>
    <link>https://example.org</link>
    <item>
      <title>On the Uses of &amp; Misuses of Colour</title>
      <link>https://example.org/colour</link>
      <pubDate>Wed, 10 Sep 2026 09:00:00 +0000</pubDate>
      <dc:creator>Jane Doe</dc:creator>
      <description><![CDATA[<p>A <em>close</em> reading of pigment.</p>]]></description>
    </item>
    <item>
      <title>Second Piece</title>
      <link>https://example.org/second</link>
      <pubDate>Mon, 08 Sep 2026 12:30:00 GMT</pubDate>
      <content:encoded><![CDATA[<p>Longer body text here.</p>]]></content:encoded>
    </item>
  </channel>
</rss>`;

const rss2 = L.parseFeed(RSS2);
check('RSS2: item count', rss2.length, 2);
check('RSS2: entity in title', rss2[0].title, 'On the Uses of & Misuses of Colour');
check('RSS2: link', rss2[0].link, 'https://example.org/colour');
check('RSS2: dc:creator as author', rss2[0].author, 'Jane Doe');
check('RSS2: CDATA description stripped', rss2[0].summary, 'A close reading of pigment.');
ok('RSS2: date parsed to ISO', rss2[0].published === '2026-09-10T09:00:00.000Z', rss2[0].published);
check('RSS2: content:encoded fallback', rss2[1].summary, 'Longer body text here.');
check('RSS2: missing author is null', rss2[1].author, null);

// ===========================================================================
// Feed parsing — Atom
// ===========================================================================

const ATOM = `<?xml version="1.0" encoding="utf-8"?>
<feed xmlns="http://www.w3.org/2005/Atom">
  <title>Atom Journal</title>
  <entry>
    <title type="html">Cinema &amp;amp; the Archive</title>
    <link rel="edit" href="https://atom.example/edit/1"/>
    <link rel="alternate" type="text/html" href="https://atom.example/post/1"/>
    <published>2026-09-11T08:00:00Z</published>
    <updated>2026-09-12T08:00:00Z</updated>
    <author><name>Ada Lovelace</name></author>
    <summary type="html">&lt;p&gt;On found footage.&lt;/p&gt;</summary>
  </entry>
  <entry>
    <title>Bare Link Entry</title>
    <link href="https://atom.example/post/2"/>
    <updated>2026-09-09T00:00:00Z</updated>
    <content type="html">Body via content.</content>
  </entry>
</feed>`;

const atom = L.parseFeed(ATOM);
check('Atom: item count', atom.length, 2);
check('Atom: double-encoded title', atom[0].title, 'Cinema & the Archive');
check('Atom: prefers rel=alternate link', atom[0].link, 'https://atom.example/post/1');
check('Atom: nested author name', atom[0].author, 'Ada Lovelace');
check('Atom: escaped-html summary', atom[0].summary, 'On found footage.');
ok('Atom: published preferred over updated',
  atom[0].published === '2026-09-11T08:00:00.000Z', atom[0].published);
check('Atom: bare href link', atom[1].link, 'https://atom.example/post/2');
ok('Atom: falls back to updated', atom[1].published === '2026-09-09T00:00:00.000Z', atom[1].published);
check('Atom: content as summary', atom[1].summary, 'Body via content.');

// ===========================================================================
// Feed parsing — RDF / RSS 1.0
// ===========================================================================

const RDF = `<?xml version="1.0"?>
<rdf:RDF xmlns:rdf="http://www.w3.org/1999/02/22-rdf-syntax-ns#"
         xmlns="http://purl.org/rss/1.0/" xmlns:dc="http://purl.org/dc/elements/1.1/">
  <item rdf:about="https://rdf.example/a">
    <title>An Older Journal Piece</title>
    <link>https://rdf.example/a</link>
    <dc:date>2026-09-05T00:00:00Z</dc:date>
    <description>Summary text.</description>
  </item>
</rdf:RDF>`;

const rdf = L.parseFeed(RDF);
check('RDF: item count', rdf.length, 1);
check('RDF: title', rdf[0].title, 'An Older Journal Piece');
ok('RDF: dc:date parsed', rdf[0].published === '2026-09-05T00:00:00.000Z', rdf[0].published);

// ===========================================================================
// Feed parsing — malformed and hostile input
// ===========================================================================

check('malformed: empty string', L.parseFeed(''), []);
check('malformed: null', L.parseFeed(null), []);
check('malformed: not xml', L.parseFeed('<html><body>nope</body></html>'), []);
check('malformed: truncated mid-item',
  L.parseFeed('<rss><channel><item><title>x</title>'), []);

const NOLINK = `<rss><channel>
  <item><title>No Link At All</title><pubDate>Wed, 10 Sep 2026 09:00:00 +0000</pubDate></item>
  <item><title>Relative Link</title><link>/relative/path</link></item>
  <item><title>Good One</title><link>https://ok.example/x</link></item>
</channel></rss>`;
const nolink = L.parseFeed(NOLINK);
check('malformed: drops item with no link and relative link', nolink.length, 1);
check('malformed: keeps the valid one', nolink[0].title, 'Good One');

const NODATE = `<rss><channel>
  <item><title>Undated</title><link>https://ok.example/u</link></item>
</channel></rss>`;
check('malformed: undated item parses with null date', L.parseFeed(NODATE)[0].published, null);

const BADDATE = `<rss><channel>
  <item><title>Bad Date</title><link>https://ok.example/b</link><pubDate>not a date</pubDate></item>
</channel></rss>`;
check('malformed: unparseable date becomes null', L.parseFeed(BADDATE)[0].published, null);

// ===========================================================================
// URL canonicalisation
// ===========================================================================

check('canonicalUrl: strips trailing slash',
  L.canonicalUrl('https://a.example/x/'), 'https://a.example/x');
check('canonicalUrl: lowercases',
  L.canonicalUrl('https://A.Example/X'), 'https://a.example/x');
check('canonicalUrl: strips utm params',
  L.canonicalUrl('https://a.example/x?utm_source=rss&utm_medium=feed'), 'https://a.example/x');
check('canonicalUrl: strips hash',
  L.canonicalUrl('https://a.example/x#section'), 'https://a.example/x');
check('canonicalUrl: keeps meaningful query',
  L.canonicalUrl('https://a.example/x?id=7'), 'https://a.example/x?id=7');
check('canonicalUrl: empty', L.canonicalUrl(''), '');

check('normaliseTitle: punctuation and case',
  L.normaliseTitle('The  Machine\u2019s "Archive"!'), 'the machine\'s archive');

// ===========================================================================
// Candidate selection
// ===========================================================================

const NOW = Date.parse('2026-09-14T12:00:00Z');
const iso = (daysAgo) => new Date(NOW - daysAgo * 86400000).toISOString();

const bySource = [
  {
    source: 'Alpha Review', category: 'art',
    items: [
      { title: 'Fresh A1', link: 'https://alpha.example/1', published: iso(1), summary: 's', author: 'x' },
      { title: 'Fresh A2', link: 'https://alpha.example/2', published: iso(3), summary: 's', author: null },
      { title: 'Stale A3', link: 'https://alpha.example/3', published: iso(60), summary: 's', author: null },
      { title: 'Undated A4', link: 'https://alpha.example/4', published: null, summary: 's', author: null },
      { title: 'Future A5', link: 'https://alpha.example/5', published: iso(-5), summary: 's', author: null },
    ],
  },
  {
    source: 'Beta Quarterly', category: 'art',
    items: [
      { title: 'Fresh B1', link: 'https://beta.example/1', published: iso(2), summary: 's', author: null },
      { title: 'Already Published', link: 'https://old.example/seen', published: iso(2), summary: 's', author: null },
    ],
  },
  {
    source: 'Rested Press', category: 'art',
    items: [
      { title: 'Should Not Appear', link: 'https://rested.example/1', published: iso(1), summary: 's', author: null },
    ],
  },
  {
    source: 'Gamma Film', category: 'film',
    items: [
      { title: 'Film G1', link: 'https://gamma.example/1', published: iso(4), summary: 's', author: null },
      { title: 'Film G2', link: 'https://gamma.example/2', published: iso(5), summary: 's', author: null },
      { title: 'Film G3', link: 'https://gamma.example/3', published: iso(6), summary: 's', author: null },
      { title: 'Film G4', link: 'https://gamma.example/4', published: iso(7), summary: 's', author: null },
    ],
  },
];

const sel = L.selectCandidates({
  bySource,
  now: NOW,
  windowDays: 21,
  seenUrls: new Set([L.canonicalUrl('https://old.example/seen')]),
  seenTitles: new Set(),
  rotationCounts: { art: { 'rested press': 2 } },
  rotationMax: 2,
  maxPerSource: 3,
});

const titles = sel.candidates.map((c) => c.title);
ok('select: keeps fresh items', titles.includes('Fresh A1') && titles.includes('Fresh A2'));
ok('select: drops stale', !titles.includes('Stale A3'));
ok('select: drops undated when required', !titles.includes('Undated A4'));
ok('select: drops future-dated', !titles.includes('Future A5'));
ok('select: drops already-published URL', !titles.includes('Already Published'));
ok('select: drops rested source entirely', !titles.includes('Should Not Appear'));
check('select: per-source cap applied', titles.filter((t) => t.startsWith('Film G')).length, 3);
check('select: drop tally stale', sel.dropped.stale, 1);
check('select: drop tally undated', sel.dropped.undated, 1);
check('select: drop tally future', sel.dropped.future, 1);
check('select: drop tally duplicate', sel.dropped.duplicate, 1);
check('select: drop tally rested', sel.dropped.rested, 1);
check('select: drop tally capped', sel.dropped.capped, 1);

// Title-based dedup (same piece syndicated at a different URL)
const dupTitle = L.selectCandidates({
  bySource: [{
    source: 'Alpha Review', category: 'art',
    items: [{ title: 'Fresh A1', link: 'https://elsewhere.example/x', published: iso(1), summary: 's', author: null }],
  }],
  now: NOW,
  seenTitles: new Set([L.normaliseTitle('Fresh A1')]),
});
check('select: dedups by normalised title', dupTitle.candidates.length, 0);

// Undated items admitted when the rule is relaxed
const undatedOk = L.selectCandidates({
  bySource: [{
    source: 'Alpha Review', category: 'art',
    items: [{ title: 'Undated', link: 'https://a.example/u', published: null, summary: 's', author: null }],
  }],
  now: NOW,
  requireDate: false,
});
check('select: undated kept when requireDate=false', undatedOk.candidates.length, 1);

// Rotation boundary: a source at max-1 is still eligible
const atBoundary = L.selectCandidates({
  bySource: [{
    source: 'Edge Press', category: 'art',
    items: [{ title: 'Edge', link: 'https://edge.example/1', published: iso(1), summary: 's', author: null }],
  }],
  now: NOW,
  rotationCounts: { art: { 'edge press': 1 } },
  rotationMax: 2,
});
check('select: source below cap still eligible', atBoundary.candidates.length, 1);

// Rotation must never empty a category -------------------------------------
// fashion hit exactly this on 14 Sept 2026: two feeds, both at the cap, the
// category came out empty and the run failed validation post-payment.
{
  const rested = L.selectCandidates({
    bySource: [
      { source: 'Only A', category: 'fashion', items: [
        { title: 'A1', link: 'https://a.example/1', published: iso(1), summary: 's', author: null }] },
      { source: 'Only B', category: 'fashion', items: [
        { title: 'B1', link: 'https://b.example/1', published: iso(2), summary: 's', author: null }] },
    ],
    now: NOW,
    rotationCounts: { fashion: { 'only a': 2, 'only b': 2 } },
    rotationMax: 2,
  });
  ok('rotation: lifted rather than leaving a category empty',
    rested.candidates.length > 0, JSON.stringify(rested.dropped));
  check('rotation: relaxation recorded', rested.dropped.rotationRelaxed, 1);

  const off = L.selectCandidates({
    bySource: [{ source: 'Only A', category: 'fashion', items: [
      { title: 'A1', link: 'https://a.example/1', published: iso(1), summary: 's', author: null }] }],
    now: NOW,
    rotationCounts: { fashion: { 'only a': 2 } },
    rotationMax: 2,
    relaxRotationWhenEmpty: false,
  });
  check('rotation: still enforced when relaxation is disabled', off.candidates.length, 0);

  // A category that still has options must NOT get relaxed entries.
  const healthy = L.selectCandidates({
    bySource: [
      { source: 'Rested', category: 'art', items: [
        { title: 'R1', link: 'https://r.example/1', published: iso(1), summary: 's', author: null }] },
      { source: 'Fresh', category: 'art', items: [
        { title: 'F1', link: 'https://f.example/1', published: iso(1), summary: 's', author: null }] },
    ],
    now: NOW,
    rotationCounts: { art: { rested: 2 } },
    rotationMax: 2,
  });
  check('rotation: healthy category keeps its cap',
    healthy.candidates.map((c) => c.source), ['Fresh']);
}

// Junk-title filter ---------------------------------------------------------
// Every "drop" case below is a title that was actually selected into a
// published issue or a live run. Every "keep" case is a title that shipped
// and was good — false positives silently delete real writing, so they
// matter more than misses.
{
  const drops = [
    'S13E2 DB|BD at Aspen: Judy Samuelson is Still Thinking About the Purpose',
    'Nicer Tuesdays London: Get tickets for our September event',
    'The Hayley Williams Show is coming to a stage near you',
    'New Book Releases Video: September 15, 2026',
    "If you like Sandy Liang, you'll love these local labels",
    '10 Things You Missed At Milan Design Week',
    'Watch: the new trailer for Dune 3',
    'Call for Submissions: 2027 Prize',
    'Episode 42: talking shop',
    'Shop the collection now',
  ];
  const keeps = [
    'The meaning of fake marble',
    'Chandigarh at 73: How a City Outgrew Its Utopia',
    'The Secret Life of the Hardanger Fiddle',
    'Nigeria 80: The Explosive Sound World of 1980s Nigeria',
    'Shoplifters (2018) Review: A Family Made From Stolen Time',
    'A country between being and nothing',
    'South Africa joins the global resistance against American data centers',
    'Sculptures that Bewitch: Unbound Forms at the Hepworth Wakefield',
    'Songs You Can See: How Latin American Artists Build a Visual World',
    'The Vivisectors by Missouri Williams',
    'The video art of Nam June Paik reconsidered',
    'A Video Essay on Chantal Akerman',
    'Rehearsals for a Revolution Offers a Personal Act of Resistance',
  ];
  for (const t of drops) ok(`junk: drops "${t.slice(0, 34)}"`, L.isJunkTitle(t), t);
  for (const t of keeps) ok(`junk: keeps "${t.slice(0, 34)}"`, !L.isJunkTitle(t), t);
  ok('junk: empty title is junk', L.isJunkTitle(''));

  // The filter must be active inside selectCandidates, and countable.
  const r = L.selectCandidates({
    bySource: [{ source: 'S', category: 'art', items: [
      { title: 'Watch: a trailer drops today', link: 'https://a.example/1', published: iso(1), summary: 's', author: null },
      { title: 'A real essay about something', link: 'https://a.example/2', published: iso(1), summary: 's', author: null },
    ] }],
    now: NOW,
  });
  check('junk: filtered inside selectCandidates', r.candidates.length, 1);
  check('junk: counted in the drop tally', r.dropped.junk, 1);

  const off = L.selectCandidates({
    bySource: [{ source: 'S', category: 'art', items: [
      { title: 'Watch: a trailer drops today', link: 'https://a.example/1', published: iso(1), summary: 's', author: null },
    ] }],
    now: NOW,
    dropJunk: false,
  });
  check('junk: can be disabled', off.candidates.length, 1);
}

// Tier ordering -------------------------------------------------------------
// Essay sources must sort above news wires, because both the model and the
// backfill read from the top of the list.
{
  const g = L.groupForPrompt([
    { title: 'news item', url: 'https://n.example/1', source: 'Wire', category: 'art', tier: 'news', published: iso(0) },
    { title: 'essay item', url: 'https://e.example/1', source: 'Journal', category: 'art', tier: 'essay', published: iso(5) },
  ]);
  check('tier: essay sorts above a newer news item',
    g.art.map((x) => x.source), ['Journal', 'Wire']);
}

// ===========================================================================
// Prompt grouping
// ===========================================================================

const grouped = L.groupForPrompt(sel.candidates, { maxPerCategory: 2 });
check('group: categories present', Object.keys(grouped).sort(), ['art', 'film']);
check('group: respects per-category cap', grouped.film.length, 2);
ok('group: newest first',
  grouped.film[0].published >= grouped.film[1].published,
  `${grouped.film[0].published} vs ${grouped.film[1].published}`);

// ===========================================================================
// History extraction
// ===========================================================================

const issues = [
  { issue: 1, categories: [{ key: 'art', entries: [
    { source: 'Momus', url: 'https://m.example/a/', title: 'Piece One' },
  ] }] },
  { issue: 2, categories: [{ key: 'art', entries: [
    { source: 'Momus', url: 'https://m.example/b', title: 'Piece Two' },
  ] }] },
  { issue: 3, categories: [{ key: 'art', entries: [
    { source: 'Frieze', url: 'https://f.example/c', title: 'Piece Three' },
  ] }] },
];
const hist = L.historyFromIssues(issues, { rotationWindow: 4 });
ok('history: url canonicalised into seen set',
  hist.seenUrls.has('https://m.example/a'), [...hist.seenUrls].join(','));
ok('history: titles normalised', hist.seenTitles.has('piece one'));
check('history: rotation counts Momus', hist.rotationCounts.art.momus, 2);
check('history: rotation counts Frieze', hist.rotationCounts.art.frieze, 1);

// Rotation window only looks at the most recent N issues
const many = [];
for (let i = 1; i <= 6; i++) {
  many.push({ issue: i, categories: [{ key: 'art', entries: [
    { source: i <= 2 ? 'OldPress' : 'NewPress', url: `https://x.example/${i}`, title: `T${i}` },
  ] }] });
}
const windowed = L.historyFromIssues(many, { rotationWindow: 4 });
check('history: rotation window excludes older issues',
  windowed.rotationCounts.art.oldpress, undefined);
check('history: rotation counts within window', windowed.rotationCounts.art.newpress, 4);
ok('history: dedup set still spans ALL issues, not just the window',
  windowed.seenUrls.size === 6, String(windowed.seenUrls.size));

// ===========================================================================
// Report
// ===========================================================================

console.log('');
if (failed) {
  console.log(`FAILED: ${failed} of ${passed + failed}\n`);
  for (const f of failures) console.log('  \u2717 ' + f);
  console.log('');
  process.exit(1);
}
console.log(`All ${passed} assertions passed.`);
