#!/usr/bin/env node
/**
 * Troller — static site builder.
 *
 * Reads every issues/NNNN.json (a zero-padded issue number, not a date —
 * multiple issues can share a calendar date) and every music/NNNN.json
 * batch, and deterministically renders:
 *   index.html                 (most recent issue)
 *   archive/NNNN.html          (one permanent page per issue)
 *   archive/index.html         (browsable list, newest first)
 *   assets/search-index.json   (search data across all issues)
 *   music/index.html           (the New Music tab)
 *
 * The design lives HERE, not in any model's output. It is the design of the
 * "Fresh this week" new-music page this site absorbed: warm paper, one
 * yellow highlight, big tight type, square buttons. Light only.
 *
 * Issues are titled plainly, by number and week. Old issue files still carry
 * the tabloid cover lines the automated versions wrote; they are not shown.
 */

const fs = require('fs');
const path = require('path');

const ROOT = path.resolve(__dirname, '..');
const ISSUES_DIR = path.join(ROOT, 'issues');
const ARCHIVE_DIR = path.join(ROOT, 'archive');
const ASSETS_DIR = path.join(ROOT, 'assets');
const MUSIC_DIR = path.join(ROOT, 'music');

const SITE = 'Troller';

// The Song Troll refresh is a manual-only GitHub workflow; the button on the
// Song Troll page opens it. Only the repo owner can press Run.
const REPO = 'mikeanderson0101/algorithm-newsletter';
const REFRESH_URL = `https://github.com/${REPO}/actions/workflows/song-troll.yml`;

/** Category order is fixed by the design. */
const CATEGORY_ORDER = [
  { key: 'art',     title: 'Fine Art' },
  { key: 'film',    title: 'Film' },
  { key: 'tech',    title: 'Tech & AI' },
  { key: 'lit',     title: 'Books' },
  { key: 'music',   title: 'Music Criticism' },
  { key: 'design',  title: 'Design' },
  { key: 'fashion', title: "Men's Fashion" },
];

function esc(s) {
  return String(s == null ? '' : s).replace(/[&<>"']/g, (c) => (
    { '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' }[c]
  ));
}

const MONTHS = ['January', 'February', 'March', 'April', 'May', 'June', 'July', 'August', 'September', 'October', 'November', 'December'];

function formatDate(iso) {
  const [y, m, d] = iso.split('-').map(Number);
  return `${d} ${MONTHS[m - 1]} ${y}`;
}

const pad = (n) => String(n).padStart(2, '0');
const plural = (n, one, many) => `${n} ${n === 1 ? one : many}`;

// ---------------------------------------------------------------------------
// Design
// ---------------------------------------------------------------------------

const STYLES = `
:root {
  --bg: #F1EEE9;
  --surface: #FFFFFF;
  --ink: #3C3C3C;
  --muted: #6B665F;
  --line: #D7D1C7;
  --sand: #CDC0B0;
  --yellow: #FFE500;
  --yellow-ink: #1E1E1E;
  --btn: #3C3C3C;
  --btn-ink: #FFFFFF;
  --sleeve-s: 26%;
  --sleeve-l: 78%;
  --font: "Switzer", "Hanken Grotesk", "Helvetica Neue", Arial, sans-serif;
  color-scheme: light;
}
html { scroll-behavior: smooth; }
*, *::before, *::after { box-sizing: border-box; }
body { margin: 0; background: var(--bg); color: var(--ink); font-family: var(--font); font-size: 17px; line-height: 1.55; -webkit-font-smoothing: antialiased; }
.wrap { max-width: 1120px; margin: 0 auto; padding: 0 24px; }
a { color: inherit; }
:focus-visible { outline: 3px solid var(--ink); outline-offset: 3px; }

/* calm mode: no motion */
:root[data-calm] *, :root[data-calm] *::before, :root[data-calm] *::after { transition: none !important; animation: none !important; scroll-behavior: auto !important; }
:root[data-calm] mark { background-size: 100% 100% !important; }
@media (prefers-reduced-motion: reduce) { * { transition: none !important; animation: none !important; scroll-behavior: auto !important; } mark { background-size: 100% 100% !important; } }

/* top bar */
.bar { display: flex; align-items: center; justify-content: space-between; gap: 16px; flex-wrap: wrap; padding: 22px 0; }
.mark { display: inline-flex; align-items: center; gap: 10px; font-weight: 700; font-size: 1.15rem; letter-spacing: -0.02em; text-decoration: none; }
.mark i { width: 14px; height: 14px; background: var(--yellow); display: inline-block; }
.nav { display: flex; align-items: center; gap: 22px; flex-wrap: wrap; font-size: 0.95rem; }
.nav a { text-decoration: none; }
.nav a:hover, .nav a[aria-current] { text-decoration: underline; text-underline-offset: 4px; }
.nav a[aria-current] { text-decoration-thickness: 2px; text-decoration-color: var(--ink); }
.sw { display: inline-flex; align-items: center; gap: 8px; padding: 0; border: 0; background: none; color: var(--ink); font: 500 0.88rem var(--font); cursor: pointer; }
.sw .box { width: 34px; height: 18px; border: 1.5px solid var(--ink); position: relative; flex: none; }
.sw .box::after { content: ""; position: absolute; top: 2px; left: 2px; width: 11px; height: 11px; background: var(--ink); transition: transform 0.18s ease; }
.sw[aria-pressed="true"] .box { background: var(--yellow); border-color: var(--yellow-ink); }
.sw[aria-pressed="true"] .box::after { transform: translateX(16px); background: var(--yellow-ink); }

/* hero */
.hero { padding: 72px 0 56px; border-top: 1px solid var(--line); }
.eyebrow { margin: 0 0 22px; color: var(--muted); font-size: 0.95rem; }
h1 { margin: 0 0 28px; font-weight: 500; font-size: clamp(3.6rem, 13vw, 9rem); line-height: 0.95; letter-spacing: -0.045em; }
mark {
  background-image: linear-gradient(var(--yellow), var(--yellow)); background-repeat: no-repeat; background-size: 100% 100%;
  background-color: transparent; color: var(--yellow-ink); padding: 0 0.12em;
  animation: sweep 0.9s 0.45s cubic-bezier(.2,.7,.2,1) both;
}
@keyframes sweep { from { background-size: 0% 100%; } to { background-size: 100% 100%; } }
@keyframes rise { from { opacity: 0; transform: translateY(18px); } to { opacity: 1; transform: none; } }
.hero > * { animation: rise 0.75s cubic-bezier(.2,.7,.2,1) both; animation-delay: calc(var(--i, 0) * 90ms); }
.hero > :nth-child(1) { --i: 0; } .hero > :nth-child(2) { --i: 1; } .hero > :nth-child(3) { --i: 2; } .hero > :nth-child(4) { --i: 3; } .hero > :nth-child(5) { --i: 4; }
.hero p.sub { max-width: 52ch; color: var(--muted); font-size: 1.1rem; margin: 0 0 32px; }
.hero-actions { display: flex; flex-wrap: wrap; gap: 12px; }
.btn {
  display: inline-block; padding: 14px 24px; border: 1.5px solid var(--btn);
  background: var(--btn); color: var(--btn-ink);
  font: 600 0.95rem var(--font); text-decoration: none; cursor: pointer; border-radius: 0;
  transition: background 0.15s ease, color 0.15s ease;
}
.btn:hover { background: transparent; color: var(--ink); }
.btn.alt { background: var(--surface); color: var(--ink); border-color: var(--ink); }
.btn.alt:hover { background: var(--ink); color: var(--bg); }
.btn:disabled { opacity: 0.5; cursor: default; }
.stats { display: grid; grid-template-columns: repeat(3, 1fr); gap: 0; margin-top: 56px; border-top: 1px solid var(--ink); }
.stat { padding: 18px 0 0; }
.stat b { display: block; font-size: clamp(2rem, 5vw, 3.2rem); font-weight: 500; letter-spacing: -0.03em; line-height: 1.05; }
.stat span { color: var(--muted); font-size: 0.92rem; }

/* sections */
section { padding: 64px 0; border-top: 1px solid var(--line); }
h2 { margin: 0 0 32px; font-weight: 500; font-size: clamp(2rem, 5vw, 3.4rem); line-height: 1.02; letter-spacing: -0.035em; }
h2 small { display: block; margin-top: 10px; font-size: 0.95rem; letter-spacing: 0; color: var(--muted); font-weight: 400; }

/* rows: issue entries, archive issues, music sources */
.rows { list-style: none; margin: 0; padding: 0; border-top: 1px solid var(--ink); }
.row { display: grid; grid-template-columns: 56px 1fr auto; gap: 8px 20px; align-items: center; padding: 22px 0; border-bottom: 1px solid var(--line); animation: rise 0.6s cubic-bezier(.2,.7,.2,1) both; animation-delay: calc(var(--i, 0) * 50ms); scroll-margin-top: 24px; }
.row .n { color: var(--muted); font-size: 0.95rem; }
.row h3 { margin: 0; font-weight: 500; font-size: 1.5rem; line-height: 1.2; letter-spacing: -0.02em; }
.row h3 a { text-decoration: none; }
.row h3 a:hover { text-decoration: underline; text-underline-offset: 4px; }
.row p { margin: 4px 0 0; color: var(--muted); font-size: 0.95rem; }
.row p.note { color: var(--ink); max-width: 64ch; }
.row .btn { padding: 9px 18px; font-size: 0.88rem; }

/* search */
.search-wrap { position: relative; margin: 0 0 28px; }
.search { width: 100%; min-width: 0; padding: 12px 14px; border: 1.5px solid var(--line); border-radius: 0; background: var(--surface); color: var(--ink); font: 400 0.95rem var(--font); }
.search:focus { border-color: var(--ink); outline: none; }
.search-results { position: absolute; top: calc(100% + 6px); left: 0; right: 0; background: var(--surface); border: 1.5px solid var(--ink); max-height: 420px; overflow-y: auto; z-index: 20; display: none; }
.search-results.active { display: block; }
.search-result { display: block; padding: 12px 14px; border-bottom: 1px solid var(--line); text-decoration: none; }
.search-result:last-child { border-bottom: none; }
.search-result:hover { background: var(--bg); }
.sr-tag { font-size: 0.8rem; color: var(--muted); }
.sr-title { display: block; font-weight: 500; margin: 2px 0; }
.sr-meta { font-size: 0.85rem; color: var(--muted); }
.search-empty { padding: 14px; color: var(--muted); font-size: 0.95rem; }

/* footer */
footer { padding: 56px 0 40px; border-top: 1px solid var(--line); }
.fine { display: flex; flex-wrap: wrap; justify-content: space-between; gap: 24px; color: var(--muted); font-size: 0.9rem; }
.fine p { margin: 0 0 8px; max-width: 58ch; }
.fine a { text-underline-offset: 3px; }
.big { margin: 40px 0 0; font-weight: 500; font-size: clamp(3rem, 15vw, 11rem); line-height: 0.9; letter-spacing: -0.05em; color: var(--sand); user-select: none; }

@media (max-width: 640px) {
  .wrap { padding: 0 16px; }
  .hero { padding: 48px 0 40px; }
  section { padding: 48px 0; }
  .row { grid-template-columns: 36px 1fr; }
  .row .btn { grid-column: 2; justify-self: start; }
  .row h3 { font-size: 1.25rem; }
}`;

const MUSIC_STYLES = `
.filters { display: grid; gap: 12px; margin-bottom: 8px; }
.frow { display: flex; flex-wrap: wrap; align-items: center; gap: 8px; }
.flabel { width: 72px; flex: none; color: var(--muted); font-size: 0.85rem; }
.chip {
  padding: 7px 14px; border: 1.5px solid var(--line); border-radius: 0;
  background: var(--surface); color: var(--ink); font: 500 0.88rem var(--font); cursor: pointer;
  transition: background 0.15s ease, border-color 0.15s ease;
}
.chip:hover { border-color: var(--ink); }
.chip[aria-pressed="true"] { background: var(--ink); color: var(--bg); border-color: var(--ink); }
.filters .search { flex: 1 1 240px; width: auto; padding: 10px 14px; }
.listbar { display: flex; flex-wrap: wrap; align-items: center; justify-content: space-between; gap: 10px 16px; margin: 22px 0 0; padding: 14px 0; border-top: 1px solid var(--ink); }
.count { margin: 0; color: var(--muted); font-size: 0.95rem; }
.listbar .btns { display: flex; gap: 8px; flex-wrap: wrap; }
.listbar .btn { padding: 10px 16px; font-size: 0.88rem; }

.track { display: grid; grid-template-columns: 64px 1fr; gap: 20px; padding: 26px 0; border-top: 1px solid var(--line); animation: rise 0.6s cubic-bezier(.2,.7,.2,1) both; animation-delay: var(--d, 0ms); }
.sleeve {
  width: 64px; height: 64px; display: flex; align-items: flex-end; padding: 6px 8px;
  background: hsl(var(--h) var(--sleeve-s) var(--sleeve-l)); color: var(--ink);
  font-weight: 600; font-size: 1.1rem; letter-spacing: -0.02em; line-height: 1; user-select: none;
}
.head { display: flex; justify-content: space-between; align-items: flex-start; gap: 16px; }
.title { margin: 0; font-weight: 500; font-size: clamp(1.3rem, 3.2vw, 1.75rem); line-height: 1.12; letter-spacing: -0.025em; }
.artist { margin: 4px 0 10px; color: var(--muted); font-size: 1rem; }
.track .note { margin: 0 0 6px; max-width: 62ch; }
.unheard { margin: 0 0 6px; color: var(--muted); font-size: 0.9rem; font-style: italic; }
.srcline { margin: 8px 0 14px; color: var(--muted); font-size: 0.88rem; }
.srcline a { text-underline-offset: 3px; }
.tag { display: inline-block; margin-left: 8px; padding: 1px 8px; font-size: 0.75rem; font-weight: 600; background: var(--line); color: var(--ink); }
.tag.new { background: var(--yellow); color: var(--yellow-ink); }
.react { display: flex; gap: 6px; flex: none; }
.react button {
  width: 40px; height: 40px; padding: 0; display: grid; place-items: center;
  border: 1.5px solid var(--line); border-radius: 0; background: var(--surface); color: var(--ink); cursor: pointer;
  transition: background 0.15s ease, border-color 0.15s ease;
}
.react button:hover { border-color: var(--ink); }
.react .up[aria-pressed="true"] { background: var(--yellow); border-color: var(--yellow-ink); color: var(--yellow-ink); }
.react .down[aria-pressed="true"] { background: var(--ink); border-color: var(--ink); color: var(--bg); }
.track.is-disliked .sleeve { opacity: 0.4; }
.track.is-disliked .title, .track.is-disliked .artist, .track.is-disliked .note { opacity: 0.5; }
.links { display: flex; flex-wrap: wrap; gap: 8px; }
.links a, .links button {
  display: inline-block; padding: 8px 16px; border: 1.5px solid var(--ink); border-radius: 0;
  background: var(--surface); color: var(--ink); font: 500 0.88rem/1.3 var(--font); text-decoration: none; cursor: pointer;
  transition: background 0.15s ease, color 0.15s ease;
}
.links a:hover, .links button:hover { background: var(--ink); color: var(--bg); }
.empty { padding: 48px 0; color: var(--muted); border-top: 1px solid var(--line); }

@media (max-width: 640px) {
  .track { grid-template-columns: 48px 1fr; gap: 14px; }
  .sleeve { width: 48px; height: 48px; font-size: 0.95rem; padding: 4px 6px; }
  .flabel { width: 100%; }
}`;

/** Applies the reduce-animation choice before first paint, so nothing flickers. */
const UI_HEAD_SCRIPT = `try{var u=JSON.parse(localStorage.getItem('troller-ui')||'{}');if(u.calm)document.documentElement.setAttribute('data-calm','');}catch(e){}`;

const UI_SCRIPT = String.raw`
(function(){
  var sw = document.getElementById('sw-calm');
  if (!sw) return;
  function load(){ try { return JSON.parse(localStorage.getItem('troller-ui') || '{}') || {}; } catch (e) { return {}; } }
  function paint(){ var on = document.documentElement.hasAttribute('data-calm'); sw.setAttribute('aria-pressed', on ? 'true' : 'false'); }
  sw.addEventListener('click', function(){
    var ui = load(); ui.calm = !document.documentElement.hasAttribute('data-calm');
    if (ui.calm) document.documentElement.setAttribute('data-calm', ''); else document.documentElement.removeAttribute('data-calm');
    try { localStorage.setItem('troller-ui', JSON.stringify(ui)); } catch (e) {}
    paint();
  });
  paint();
})();`;

const SEARCH_SCRIPT = String.raw`
(function(){
  var root = document.body.getAttribute('data-root') || '';
  var input = document.getElementById('searchInput');
  var results = document.getElementById('searchResults');
  if (!input) return;
  var indexData = null;
  function loadIndex(){
    if (indexData) return Promise.resolve(indexData);
    return fetch(root + 'assets/search-index.json')
      .then(function(r){ return r.json(); })
      .then(function(d){ indexData = d; return d; })
      .catch(function(){ return []; });
  }
  function escapeHtml(s){
    return String(s).replace(/[&<>"']/g, function(c){
      return {'&':'&amp;','<':'&lt;','>':'&gt;','"':'&quot;',"'":'&#39;'}[c];
    });
  }
  function render(matches, q){
    if (!q) { results.classList.remove('active'); results.innerHTML = ''; return; }
    if (!matches.length) {
      results.innerHTML = '<div class="search-empty">Nothing matches “' + escapeHtml(q) + '”.</div>';
      results.classList.add('active');
      return;
    }
    results.innerHTML = matches.slice(0, 20).map(function(m){
      return '<a class="search-result" href="' + root + m.page + '#' + m.anchor + '">' +
        '<span class="sr-tag">' + escapeHtml(m.category) + ' · Issue ' + escapeHtml(m.issue) + ' · ' + escapeHtml(m.date) + '</span>' +
        '<span class="sr-title">' + escapeHtml(m.title) + '</span>' +
        '<span class="sr-meta">' + escapeHtml([m.author, m.source].filter(Boolean).join(' · ')) + '</span>' +
      '</a>';
    }).join('');
    results.classList.add('active');
  }
  input.addEventListener('input', function(){
    var q = input.value.trim().toLowerCase();
    if (!q) { render([], ''); return; }
    loadIndex().then(function(data){
      render(data.filter(function(e){
        return (e.title + ' ' + e.author + ' ' + e.source + ' ' + e.category).toLowerCase().indexOf(q) !== -1;
      }), q);
    });
  });
  document.addEventListener('click', function(e){
    if (!e.target.closest('.search-wrap')) results.classList.remove('active');
  });
})();`;

// ---------------------------------------------------------------------------
// Page shell
// ---------------------------------------------------------------------------

function page({ title, root, active, extraStyles = '', body, scripts = [], farewell, fine }) {
  const navLink = (href, label, key) =>
    `<a href="${root}${href}"${active === key ? ' aria-current="page"' : ''}>${label}</a>`;
  return `<!DOCTYPE html>
<html lang="en">
<head>
<meta charset="UTF-8">
<meta name="viewport" content="width=device-width, initial-scale=1">
<meta name="color-scheme" content="light">
<meta name="theme-color" content="#F1EEE9">
<title>${esc(title)}</title>
<link rel="preconnect" href="https://fonts.googleapis.com">
<link rel="preconnect" href="https://fonts.gstatic.com" crossorigin>
<link href="https://fonts.googleapis.com/css2?family=Hanken+Grotesk:wght@400;500;600;700&display=swap" rel="stylesheet">
<script>${UI_HEAD_SCRIPT}</script>
<style>${STYLES}${extraStyles}
</style>
</head>
<body data-root="${root}">
<div class="wrap">
  <header class="bar">
    <a class="mark" href="${root}index.html"><i aria-hidden="true"></i>${SITE}</a>
    <nav class="nav" aria-label="Site">
      ${navLink('index.html', 'News Troll', 'issue')}
      ${navLink('music/index.html', 'Song Troll', 'music')}
      ${navLink('archive/index.html', 'Archive', 'archive')}
      <button class="sw" id="sw-calm" type="button" aria-pressed="false"><span class="box" aria-hidden="true"></span>Reduce animation</button>
    </nav>
  </header>
${body}
  <footer>
    <div class="fine">
      <div>${fine}</div>
      <p><a href="#top">Back to top</a></p>
    </div>
    <p class="big" aria-hidden="true">${esc(farewell)}</p>
  </footer>
</div>
<script>${UI_SCRIPT}</script>
${scripts.map((s) => `<script>${s}</script>`).join('\n')}
</body>
</html>
`;
}

function searchBox(placeholder) {
  return `    <div class="search-wrap">
      <input type="search" id="searchInput" class="search" placeholder="${esc(placeholder)}" autocomplete="off" aria-label="Search every issue">
      <div id="searchResults" class="search-results"></div>
    </div>`;
}

// ---------------------------------------------------------------------------
// Issues
// ---------------------------------------------------------------------------

/**
 * One link: title, writer, publication. Older issue files carry summaries
 * (written by the agentic version, or feed excerpts in the RSS version);
 * they are deliberately not shown. Troller is links only.
 */
function renderEntry(entry, anchor, i) {
  const title = entry.url
    ? `<a href="${esc(entry.url)}" target="_blank" rel="noopener">${esc(entry.title)}</a>`
    : esc(entry.title);
  const by = [entry.author, entry.source].filter(Boolean).map(esc).join(' · ');
  const read = entry.url
    ? `\n      <a class="btn alt" href="${esc(entry.url)}" target="_blank" rel="noopener" aria-label="Read ${esc(entry.title)}">Read</a>`
    : '';
  return `    <li class="row" id="${esc(anchor)}" style="--i:${i}">
      <span class="n">${pad(i + 1)}</span>
      <div>
        <h3>${title}</h3>
        <p>${by}</p>
      </div>${read}
    </li>`;
}

function issueStats(issue) {
  const entries = (issue.categories || []).flatMap((c) => c.entries || []);
  const outlets = new Set(entries.map((e) => String(e.source || '').toLowerCase()).filter(Boolean)).size;
  const sections = (issue.categories || []).filter((c) => (c.entries || []).length).length;
  return { links: entries.length, outlets, sections };
}

function renderIssue(issue, { root, isLatest }) {
  const sections = CATEGORY_ORDER.map((cat) => {
    const block = (issue.categories || []).find((c) => c.key === cat.key);
    if (!block || !block.entries || !block.entries.length) return '';
    const rows = block.entries.map((e, j) => renderEntry(e, `${cat.key}-${j + 1}`, j)).join('\n');
    return `  <section id="${cat.key}" aria-labelledby="h-${cat.key}">
    <h2 id="h-${cat.key}">${esc(cat.title)}</h2>
    <ol class="rows">
${rows}
    </ol>
  </section>`;
  }).filter(Boolean).join('\n');

  const s = issueStats(issue);
  const first = CATEGORY_ORDER.find((c) => (issue.categories || []).some((b) => b.key === c.key && (b.entries || []).length));
  const body = `  <div class="hero" id="top">
    <p class="eyebrow">News Troll · week of ${formatDate(issue.date)}</p>
    <h1>Issue <mark>${esc(issue.issue)}.</mark></h1>
    ${issue.intro ? `<p class="sub">${esc(issue.intro)}</p>` : ''}
    <div class="hero-actions">
      ${first ? `<a class="btn" href="#${first.key}">Start reading</a>` : ''}
      <a class="btn alt" href="${root}music/index.html">Song Troll</a>
    </div>
    <div class="stats">
      <div class="stat"><b>${s.links}</b><span>links</span></div>
      <div class="stat"><b>${s.outlets}</b><span>publications</span></div>
      <div class="stat"><b>${s.sections}</b><span>sections</span></div>
    </div>
  </div>
${isLatest ? `  <section aria-label="Search">\n${searchBox('Search every issue: title, writer or publication')}\n  </section>` : ''}
${sections}`;

  return page({
    title: `${SITE} — Issue ${issue.issue}`,
    root,
    active: isLatest ? 'issue' : 'archive',
    body,
    scripts: isLatest ? [SEARCH_SCRIPT] : [],
    farewell: 'happy reading',
    fine: `<p>${SITE}, Issue ${esc(issue.issue)}, week of ${formatDate(issue.date)}. Every link was read in full before it was picked.</p>
        <p><a href="${root}archive/index.html">Every issue</a></p>`,
  });
}

function renderArchiveIndex(issues) {
  const rows = issues.map((iss, i) => {
    const s = issueStats(iss);
    return `    <li class="row" style="--i:${Math.min(i, 12)}">
      <span class="n">${esc(iss.issue)}</span>
      <div>
        <h3><a href="${String(iss.issue).padStart(4, '0')}.html">Issue ${esc(iss.issue)}</a></h3>
        <p>Week of ${formatDate(iss.date)} · ${plural(s.links, 'link', 'links')} from ${plural(s.outlets, 'publication', 'publications')}</p>
      </div>
      <a class="btn alt" href="${String(iss.issue).padStart(4, '0')}.html" aria-label="Open Issue ${esc(iss.issue)}">Open</a>
    </li>`;
  }).join('\n');

  const totalLinks = issues.reduce((n, iss) => n + issueStats(iss).links, 0);
  const outlets = new Set(issues.flatMap((iss) => (iss.categories || []).flatMap((c) => (c.entries || []).map((e) => String(e.source || '').toLowerCase())))).size;

  const body = `  <div class="hero" id="top">
    <p class="eyebrow">Archive</p>
    <h1>Every <mark>issue.</mark></h1>
    <p class="sub">Every past issue, newest first. Search finds any link by title, writer or publication.</p>
    <div class="stats">
      <div class="stat"><b>${issues.length}</b><span>issues</span></div>
      <div class="stat"><b>${totalLinks}</b><span>links</span></div>
      <div class="stat"><b>${outlets}</b><span>publications</span></div>
    </div>
  </div>
  <section aria-labelledby="h-issues">
${searchBox('Search every issue: title, writer or publication')}
    <h2 id="h-issues">The issues</h2>
    <ol class="rows">
${rows}
    </ol>
  </section>`;

  return page({
    title: `${SITE} — Archive`,
    root: '../',
    active: 'archive',
    body,
    scripts: [SEARCH_SCRIPT],
    farewell: 'happy reading',
    fine: `<p>${SITE} archive: ${plural(issues.length, 'issue', 'issues')}.</p>`,
  });
}

// ---------------------------------------------------------------------------
// New Music
//
// Folded in from the standalone "Fresh this week" page, whose design the
// whole site now uses. Thumbs are kept in the reader's browser; "Copy my
// thumbs" hands them back for music/taste.json, which steers the next batch.
// ---------------------------------------------------------------------------

const MUSIC_SCRIPT = String.raw`
(function(){
  var ITEMS = JSON.parse(document.getElementById('music-data').textContent);
  var K_TASTE = 'troller-music-taste', K_VIEW = 'troller-music-view';
  function load(k, f){ try { var v = JSON.parse(localStorage.getItem(k) || 'null'); return v == null ? f : v; } catch (e) { return f; } }
  function save(k, v){ try { localStorage.setItem(k, JSON.stringify(v)); } catch (e) {} }
  // Thumbs given on the old "Fresh this week" page carry over by song id.
  var taste = load(K_TASTE, null) || load('fwt-app-taste', {});
  var state = { batch: 'all', year: 'all', site: 'all', rating: 'all', q: '' };
  var saved = load(K_VIEW, {});
  ['batch', 'year', 'site', 'rating'].forEach(function(k){ if (typeof saved[k] === 'string') state[k] = saved[k]; });
  var BATCHES = Array.from(new Set(ITEMS.map(function(i){ return i.batch; }))).sort(function(a, b){ return b - a; });
  var SITES = Array.from(new Set(ITEMS.map(function(i){ return i.site; })));
  var YEARS = Array.from(new Set(ITEMS.map(function(i){ return i.year; }).filter(Boolean))).sort(function(a, b){ return b - a; });
  if (state.year !== 'all' && YEARS.indexOf(Number(state.year)) === -1) state.year = 'all';
  if (state.batch !== 'all' && BATCHES.indexOf(Number(state.batch)) === -1) state.batch = 'all';
  if (state.site !== 'all' && SITES.indexOf(state.site) === -1) state.site = 'all';
  var $ = function(id){ return document.getElementById(id); };
  var calm = function(){ return document.documentElement.hasAttribute('data-calm'); };

  var ICON_UP = '<svg viewBox="0 0 24 24" width="18" height="18" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round" aria-hidden="true"><path d="M14 9V5a3 3 0 0 0-3-3l-4 9v11h11.28a2 2 0 0 0 2-1.7l1.38-9a2 2 0 0 0-2-2.3zM7 22H4a2 2 0 0 1-2-2v-7a2 2 0 0 1 2-2h3"/></svg>';
  var ICON_DOWN = '<svg viewBox="0 0 24 24" width="18" height="18" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round" aria-hidden="true"><path d="M10 15v4a3 3 0 0 0 3 3l4-9V2H5.72a2 2 0 0 0-2 1.7l-1.38 9a2 2 0 0 0 2 2.3zm7-13h2.67A2.31 2.31 0 0 1 22 4v7a2.31 2.31 0 0 1-2.33 2H17"/></svg>';

  function hue(str){ var h = 0; for (var i = 0; i < str.length; i++) h = (h * 31 + str.charCodeAt(i)) % 360; return h; }
  function copy(text, btn, done){
    var finish = function(){ var l = btn.textContent; btn.textContent = done; setTimeout(function(){ btn.textContent = l; }, 2200); };
    var fallback = function(){ var t = document.createElement('textarea'); t.value = text; t.style.position = 'fixed'; t.style.opacity = '0'; document.body.appendChild(t); t.select(); try { document.execCommand('copy'); } catch (e) {} document.body.removeChild(t); finish(); };
    if (navigator.clipboard && navigator.clipboard.writeText) navigator.clipboard.writeText(text).then(finish, fallback); else fallback();
  }
  function matches(i){
    if (state.batch !== 'all' && i.batch !== Number(state.batch)) return false;
    if (state.year !== 'all' && i.year !== Number(state.year)) return false;
    if (state.site !== 'all' && i.site !== state.site) return false;
    if (state.rating === 'liked' && !(taste[i.id] && taste[i.id].v === 1)) return false;
    if (state.q && [i.artist, i.title, i.note, i.site].join(' ').toLowerCase().indexOf(state.q.toLowerCase()) === -1) return false;
    return true;
  }
  function visible(){
    return ITEMS.map(function(i, idx){ return { i: i, idx: idx }; })
      .filter(function(x){ return matches(x.i); })
      .sort(function(a, b){ return (b.i.batch - a.i.batch) || (a.idx - b.idx); })
      .map(function(x){ return x.i; });
  }

  function chip(parent, value, label, key){
    var b = document.createElement('button'); b.type = 'button'; b.className = 'chip'; b.textContent = label; b.dataset.value = String(value);
    b.addEventListener('click', function(){ state[key] = String(value); save(K_VIEW, { batch: state.batch, year: state.year, site: state.site, rating: state.rating }); sync(); render(); });
    parent.appendChild(b);
  }
  function sync(){
    [['f-batch', 'batch'], ['f-year', 'year'], ['f-site', 'site'], ['f-rating', 'rating']].forEach(function(p){
      Array.prototype.forEach.call($(p[0]).children, function(b){ b.setAttribute('aria-pressed', b.dataset.value === String(state[p[1]]) ? 'true' : 'false'); });
    });
  }

  function build(item){
    var q = encodeURIComponent(item.search || (item.title + ' ' + item.artist));
    var row = document.createElement('article'); row.className = 'track';
    var sleeve = document.createElement('div'); sleeve.className = 'sleeve'; sleeve.setAttribute('aria-hidden', 'true');
    sleeve.style.setProperty('--h', hue(item.artist));
    sleeve.textContent = item.artist.replace(/^the\s+/i, '').replace(/^FFO:\s*/i, '').slice(0, 2);

    var body = document.createElement('div');
    var head = document.createElement('div'); head.className = 'head';
    var titles = document.createElement('div');
    var t = document.createElement('h3'); t.className = 'title'; t.textContent = item.title;
    var a = document.createElement('p'); a.className = 'artist'; a.textContent = item.artist;
    titles.appendChild(t); titles.appendChild(a);

    var react = document.createElement('div'); react.className = 'react';
    var up = document.createElement('button'); up.type = 'button'; up.className = 'up'; up.innerHTML = ICON_UP; up.setAttribute('aria-label', 'Like ' + item.title + ' by ' + item.artist);
    var down = document.createElement('button'); down.type = 'button'; down.className = 'down'; down.innerHTML = ICON_DOWN; down.setAttribute('aria-label', 'Dislike ' + item.title + ' by ' + item.artist);
    react.appendChild(up); react.appendChild(down);
    head.appendChild(titles); head.appendChild(react);
    function paint(){ var v = taste[item.id] ? taste[item.id].v : 0; up.setAttribute('aria-pressed', v === 1 ? 'true' : 'false'); down.setAttribute('aria-pressed', v === -1 ? 'true' : 'false'); row.classList.toggle('is-disliked', v === -1); }
    function choose(v){
      if (taste[item.id] && taste[item.id].v === v) delete taste[item.id];
      else taste[item.id] = { v: v, artist: item.artist, title: item.title, site: item.site, batch: item.batch };
      save(K_TASTE, taste);
      if (state.rating === 'liked') render(); else { paint(); count(); }
    }
    up.addEventListener('click', function(){ choose(1); }); down.addEventListener('click', function(){ choose(-1); });
    paint();
    body.appendChild(head);

    if (item.note) { var n = document.createElement('p'); n.className = 'note'; n.textContent = item.note; body.appendChild(n); }
    if (item.unheard) { var u = document.createElement('p'); u.className = 'unheard'; u.textContent = 'No write-up found, so this one rests on the editors’ pick alone.'; body.appendChild(u); }

    var src = document.createElement('p'); src.className = 'srcline';
    src.appendChild(document.createTextNode(item.site + ' · '));
    var sa = document.createElement('a'); sa.href = item.src.url; sa.target = '_blank'; sa.rel = 'noopener'; sa.textContent = item.src.label; src.appendChild(sa);
    var tag = document.createElement('span'); tag.className = 'tag' + (item.batch === BATCHES[0] ? ' new' : ''); tag.textContent = 'Batch ' + item.batch; src.appendChild(tag);
    body.appendChild(src);

    var links = document.createElement('div'); links.className = 'links';
    function addLink(href, text){ var l = document.createElement('a'); l.href = href; l.target = '_blank'; l.rel = 'noopener'; l.textContent = text; links.appendChild(l); }
    addLink(item.yt ? 'https://www.youtube.com/watch?v=' + item.yt : 'https://www.youtube.com/results?search_query=' + q, 'YouTube');
    addLink('https://open.spotify.com/search/' + q, 'Spotify');
    addLink(item.bc || ('https://bandcamp.com/search?q=' + q + '&item_type=t'), item.bc ? (item.bc.indexOf('/track/') > -1 ? 'Bandcamp' : 'Bandcamp album') : 'Bandcamp');
    var cb = document.createElement('button'); cb.type = 'button'; cb.textContent = 'Copy name'; cb.title = 'Copy the song and artist to paste into any search box';
    cb.addEventListener('click', function(){ copy(item.search || (item.title + ' ' + item.artist), cb, 'Copied'); });
    links.appendChild(cb);
    body.appendChild(links);

    row.appendChild(sleeve); row.appendChild(body);
    return row;
  }
  function count(){
    var vis = visible();
    var likes = Object.keys(taste).filter(function(k){ return taste[k].v === 1; }).length;
    var dislikes = Object.keys(taste).filter(function(k){ return taste[k].v === -1; }).length;
    var s = vis.length + (vis.length === 1 ? ' song' : ' songs') + (vis.length !== ITEMS.length ? ' of ' + ITEMS.length : '');
    if (likes + dislikes) s += ' · ' + likes + ' liked, ' + dislikes + ' disliked';
    $('count').textContent = s;
    $('thumbs-status').textContent = (likes + dislikes)
      ? 'This browser holds ' + likes + (likes === 1 ? ' like' : ' likes') + ' and ' + dislikes + (dislikes === 1 ? ' dislike' : ' dislikes') + '. Refresh copies them for you to paste.'
      : 'No thumbs yet in this browser. Thumbs up or down any song and the next refresh can lean your way.';
    $('copylist').textContent = 'Copy list (' + vis.length + ')';
    $('copylist').disabled = vis.length === 0;
  }
  function render(){
    var vis = visible(), list = $('list');
    list.textContent = '';
    if (!vis.length) {
      var e = document.createElement('p'); e.className = 'empty';
      e.textContent = state.rating === 'liked' && !state.q ? 'Nothing liked yet. Tap the thumbs up on a song and it will show up here.' : 'No songs match. Try clearing the search or a filter.';
      list.appendChild(e);
    }
    vis.forEach(function(i, n){ var r = build(i); if (!calm()) r.style.setProperty('--d', Math.min(n, 10) * 45 + 'ms'); list.appendChild(r); });
    count();
  }

  chip($('f-batch'), 'all', 'All', 'batch');
  BATCHES.forEach(function(n){ chip($('f-batch'), n, 'Batch ' + n, 'batch'); });
  chip($('f-year'), 'all', 'All', 'year');
  YEARS.forEach(function(y){ chip($('f-year'), y, String(y), 'year'); });
  chip($('f-site'), 'all', 'All', 'site');
  SITES.forEach(function(s){ chip($('f-site'), s, s, 'site'); });
  chip($('f-rating'), 'all', 'All', 'rating');
  chip($('f-rating'), 'liked', 'Liked', 'rating');
  $('q').addEventListener('input', function(){ state.q = this.value.trim(); render(); });
  function listText(arr){ return arr.map(function(i){ return i.artist + ' – ' + i.title; }).join('\n'); }
  $('copylist').addEventListener('click', function(){ copy(listText(visible()), this, 'Copied'); });
  $('copyall').addEventListener('click', function(){ copy(listText(ITEMS.slice().sort(function(a, b){ return b.batch - a.batch; })), this, 'Copied all ' + ITEMS.length); });
  function thumbsJson(){
    var liked = [], disliked = [];
    Object.keys(taste).forEach(function(k){ (taste[k].v === 1 ? liked : disliked).push(taste[k].artist + ' – ' + taste[k].title); });
    // One line: it is pasted into a single-line field on GitHub.
    return JSON.stringify({ liked: liked, disliked: disliked });
  }
  $('copytaste').addEventListener('click', function(){ copy(thumbsJson(), this, 'Copied'); });
  // The refresh button is a plain link to the manual GitHub workflow, so it
  // opens even if copying fails; the click also puts the thumbs on the
  // clipboard for the workflow's "taste" box.
  $('refresh-btn').addEventListener('click', function(){
    var t = JSON.parse(thumbsJson());
    var msg = (t.liked.length + t.disliked.length)
      ? 'Copied ' + t.liked.length + ' likes and ' + t.disliked.length + ' dislikes. Paste them into the taste box.'
      : 'No thumbs yet. Opening GitHub…';
    copy(thumbsJson(), this, msg);
  });
  sync(); render();
})();`;

function renderMusicPage(batches, sources) {
  // Each song's year is the year of the list it came from; the first batches,
  // brought over from Fresh this week, fall back to the batch's own year.
  const items = batches.flatMap((b) => b.items.map((i) => ({ ...i, batch: b.batch, year: i.year || Number(String(b.date).slice(0, 4)) })));
  const latest = batches.length ? batches[batches.length - 1] : null;
  const sites = [...new Set(items.map((i) => i.site))];
  // JSON inside a <script> tag: escaping "<" keeps a stray "</script>" in a
  // song note from ending the block early.
  const data = JSON.stringify(items).replace(/</g, '\\u003c');
  const sourceRows = sites.map((s, i) => {
    const n = items.filter((x) => x.site === s).length;
    return `    <li class="row" style="--i:${i}">
      <span class="n">${pad(i + 1)}</span>
      <div>
        <h3>${esc(s)}</h3>
        <p>${esc((sources[s] && sources[s].blurb) || '')} ${plural(n, 'song', 'songs')}.</p>
      </div>
    </li>`;
  }).join('\n');

  const body = `  <div class="hero" id="top">
    <p class="eyebrow">Song Troll · new music${latest ? ` · updated ${formatDate(latest.date)}` : ''}</p>
    <h1>Song <mark>Troll.</mark></h1>
    <p class="sub">Every week, a handful of music sites name the new songs they can’t stop playing. This page gathers them in one place, with a link back to the article behind each pick.</p>
    <div class="hero-actions">
      <a class="btn" href="#songs">Browse the songs</a>
      <button class="btn alt" id="copyall" type="button">Copy the full list</button>
      <a class="btn alt" href="#refresh">Refresh Song Troll</a>
    </div>
    <div class="stats">
      <div class="stat"><b>${items.length}</b><span>songs</span></div>
      <div class="stat"><b>${sites.length}</b><span>sources</span></div>
      <div class="stat"><b>${batches.length}</b><span>batches</span></div>
    </div>
  </div>

  <section id="songs" aria-labelledby="h-songs">
    <h2 id="h-songs">The songs</h2>
    <div class="filters">
      <div class="frow"><span class="flabel" id="l-batch">Batch</span><div class="frow" id="f-batch" role="group" aria-labelledby="l-batch"></div></div>
      <div class="frow"><span class="flabel" id="l-year">Year</span><div class="frow" id="f-year" role="group" aria-labelledby="l-year"></div></div>
      <div class="frow"><span class="flabel" id="l-src">Source</span><div class="frow" id="f-site" role="group" aria-labelledby="l-src"></div></div>
      <div class="frow"><span class="flabel" id="l-show">Show</span><div class="frow" id="f-rating" role="group" aria-labelledby="l-show"></div>
        <input id="q" class="search" type="search" placeholder="Search artist, song or sound" aria-label="Search songs"></div>
    </div>
    <div class="listbar">
      <p id="count" class="count" role="status" aria-live="polite"></p>
      <div class="btns">
        <button id="copylist" class="btn alt" type="button">Copy list</button>
        <button id="copytaste" class="btn alt" type="button">Copy my thumbs</button>
      </div>
    </div>
    <div id="list"></div>
  </section>

  <section id="refresh" aria-labelledby="h-refresh">
    <h2 id="h-refresh">Refresh Song Troll<small>Song Troll refreshes on its own, whenever you want, separately from News Troll. Each refresh adds 10 songs, picked from an archive of music sites’ weekly lists back to 2025. A few cents a batch.</small></h2>
    <ol class="rows">
      <li class="row"><span class="n">01</span><div><h3>Press the button</h3><p>It copies your thumbs and opens the refresh on GitHub, in a new tab.</p></div></li>
      <li class="row"><span class="n">02</span><div><h3>Paste and run</h3><p>Click <b>Run workflow</b>. Choose which years to pick from (all, or a single year like 2026). Paste into the taste box so the batch leans your way; your thumbs are kept from then on. Then click the green <b>Run workflow</b> button.</p></div></li>
      <li class="row"><span class="n">03</span><div><h3>Come back in a few minutes</h3><p>The new batch appears here at the top, tagged New.</p></div></li>
    </ol>
    <p id="thumbs-status" class="count" style="margin-top:24px"></p>
    <p class="hero-actions" style="margin-top:12px"><a class="btn" id="refresh-btn" href="${REFRESH_URL}" target="_blank" rel="noopener">Refresh Song Troll</a></p>
  </section>

  <section id="sources" aria-labelledby="h-sources">
    <h2 id="h-sources">Where the picks come from</h2>
    <ol class="rows">
${sourceRows}
    </ol>
  </section>
  <script type="application/json" id="music-data">${data}</script>`;

  return page({
    title: `${SITE} — Song Troll`,
    root: '../',
    active: 'music',
    extraStyles: MUSIC_STYLES,
    body,
    scripts: [MUSIC_SCRIPT],
    farewell: 'happy listening',
    fine: `<p>Sources: ${sites.map(esc).join(', ')}. Every song links to the post it was picked from.</p>
        <p>Thumbs are saved in this browser only. “Refresh Song Troll” copies them for the next batch, so it leans your way.</p>`,
  });
}

function loadMusic() {
  if (!fs.existsSync(MUSIC_DIR)) return [];
  return fs.readdirSync(MUSIC_DIR)
    .filter((f) => /^\d{4}\.json$/.test(f))
    .sort()
    .map((f) => {
      try {
        return JSON.parse(fs.readFileSync(path.join(MUSIC_DIR, f), 'utf8'));
      } catch (err) {
        console.error(`Invalid JSON in music/${f}: ${err.message}`);
        process.exit(1);
      }
    });
}

// ---------------------------------------------------------------------------
// Search index and main
// ---------------------------------------------------------------------------

function buildSearchIndex(issues) {
  const out = [];
  for (const issue of issues) {
    for (const cat of CATEGORY_ORDER) {
      const block = (issue.categories || []).find((c) => c.key === cat.key);
      if (!block) continue;
      (block.entries || []).forEach((e, j) => {
        out.push({
          date: issue.date,
          issue: issue.issue,
          category: cat.title,
          tag: cat.key,
          title: e.title,
          author: e.author || '',
          source: e.source || '',
          summary: e.summary || '',
          url: e.url || null,
          page: `archive/${String(issue.issue).padStart(4, '0')}.html`,
          anchor: `${cat.key}-${j + 1}`,
        });
      });
    }
  }
  return out;
}

function main() {
  if (!fs.existsSync(ISSUES_DIR)) {
    console.error(`No issues/ directory at ${ISSUES_DIR}`);
    process.exit(1);
  }
  const files = fs.readdirSync(ISSUES_DIR)
    .filter((f) => /^\d{4}\.json$/.test(f))
    .sort();

  if (!files.length) {
    console.error('No issue JSON files found in issues/. Nothing to build.');
    process.exit(1);
  }

  const issues = files.map((f) => {
    const raw = fs.readFileSync(path.join(ISSUES_DIR, f), 'utf8');
    try {
      return JSON.parse(raw);
    } catch (err) {
      console.error(`Invalid JSON in issues/${f}: ${err.message}`);
      process.exit(1);
    }
  });

  // Newest first. Two issues can share a date, so date alone is not a total
  // order — break ties by issue number (higher = more recent).
  issues.sort((a, b) => {
    if (a.date !== b.date) return a.date < b.date ? 1 : -1;
    return b.issue - a.issue;
  });

  fs.mkdirSync(ARCHIVE_DIR, { recursive: true });
  fs.mkdirSync(ASSETS_DIR, { recursive: true });

  for (const issue of issues) {
    fs.writeFileSync(
      path.join(ARCHIVE_DIR, `${String(issue.issue).padStart(4, '0')}.html`),
      renderIssue(issue, { root: '../', isLatest: false }),
    );
  }

  fs.writeFileSync(path.join(ROOT, 'index.html'), renderIssue(issues[0], { root: '', isLatest: true }));
  fs.writeFileSync(path.join(ARCHIVE_DIR, 'index.html'), renderArchiveIndex(issues));
  fs.writeFileSync(path.join(ASSETS_DIR, 'search-index.json'), JSON.stringify(buildSearchIndex(issues), null, 2) + '\n');

  const batches = loadMusic();
  let sources = {};
  try {
    sources = JSON.parse(fs.readFileSync(path.join(ASSETS_DIR, 'music-sources.json'), 'utf8'));
  } catch {
    /* blurbs are optional */
  }
  fs.mkdirSync(MUSIC_DIR, { recursive: true });
  fs.writeFileSync(path.join(MUSIC_DIR, 'index.html'), renderMusicPage(batches, sources));

  // GitHub Pages otherwise runs the site through Jekyll, which ignores some files.
  fs.writeFileSync(path.join(ROOT, '.nojekyll'), '');

  const entryCount = buildSearchIndex(issues).length;
  console.log(`Built ${issues.length} issue(s), ${entryCount} entries indexed.`);
  console.log(`Built New Music: ${batches.reduce((n, b) => n + b.items.length, 0)} songs in ${batches.length} batch(es).`);
  console.log(`Latest: Issue ${issues[0].issue} (${issues[0].date})`);
}

main();
