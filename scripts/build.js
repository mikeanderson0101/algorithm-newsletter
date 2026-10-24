#!/usr/bin/env node
/**
 * Algorithm — static site builder.
 *
 * Reads every issues/NNNN.json (a zero-padded issue number, not a date —
 * multiple issues can share a calendar date) and deterministically renders:
 *   index.html                 (most recent issue)
 *   archive/NNNN.html          (one permanent page per issue)
 *   archive/index.html         (browsable list, newest first)
 *   assets/search-index.json   (search data across all issues)
 *   music/index.html           (the New Music tab, from every music/NNNN.json batch)
 *
 * The design lives HERE, not in the model's output. The daily job only writes
 * an issue JSON; this script owns all HTML. That keeps the look stable.
 */

const fs = require('fs');
const path = require('path');

const ROOT = path.resolve(__dirname, '..');
const ISSUES_DIR = path.join(ROOT, 'issues');
const ARCHIVE_DIR = path.join(ROOT, 'archive');
const ASSETS_DIR = path.join(ROOT, 'assets');
const MUSIC_DIR = path.join(ROOT, 'music');

/** Category order and colour keys are fixed by the design. */
const CATEGORY_ORDER = [
  { key: 'art',     tag: 'Art',          title: 'Fine Art' },
  { key: 'film',    tag: 'Film',         title: 'Film Criticism' },
  { key: 'tech',    tag: 'Tech & AI',    title: 'Tech & AI' },
  { key: 'lit',     tag: 'Sci-Fi / Fantasy', title: 'Literary Reviews' },
  { key: 'music',   tag: 'Music',        title: 'Music Criticism' },
  { key: 'design',  tag: 'Design',       title: 'Design' },
  { key: 'fashion', tag: "Men's Fashion", title: "Men's Fashion" },
];

function esc(s) {
  return String(s == null ? '' : s).replace(/[&<>"']/g, (c) => (
    { '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' }[c]
  ));
}

/** Headline convention: text wrapped in *asterisks* renders in the accent colour. */
function renderHeadline(raw) {
  const parts = String(raw).split(/(\*[^*]+\*)/g).filter(Boolean);
  return parts.map((p) => (
    p.startsWith('*') && p.endsWith('*')
      ? `<span class="pop">${esc(p.slice(1, -1))}</span>`
      : esc(p)
  )).join('').replace(/\n/g, '<br>');
}

function formatDate(iso) {
  const [y, m, d] = iso.split('-').map(Number);
  const months = ['Jan','Feb','Mar','Apr','May','Jun','Jul','Aug','Sep','Oct','Nov','Dec'];
  return `${d} ${months[m - 1]} ${y}`;
}

const STYLES = `
  html, body{ margin:0; padding:0; height:100%; background-color:#0A0A0A; }
  *{box-sizing:border-box;}
  body{
    min-height:100dvh;
    color:#FAFAF7;
    font-family:'Source Serif 4', Georgia, serif;
    line-height:1.6;
    -webkit-font-smoothing:antialiased;
  }
  .page{ background-color:#0A0A0A; min-height:100dvh; }
  a{ color:inherit; }
  .wrap{max-width:720px; margin:0 auto; padding:44px 24px 90px; position:relative;}
  .masthead{
    display:flex; justify-content:space-between; align-items:flex-end;
    border-bottom:4px solid #FAFAF7;
    padding-bottom:14px; margin-bottom:24px;
  }
  .mast-title{
    font-family:'Archivo Black', sans-serif;
    font-size:clamp(26px,6vw,34px);
    letter-spacing:-0.01em;
    text-transform:uppercase;
    color:#FAFAF7;
    text-decoration:none;
  }
  .stamp{
    font-family:'IBM Plex Mono', monospace;
    font-size:11px; letter-spacing:0.1em; text-transform:uppercase;
    color:#0A0A0A; background:#FF1F3D;
    padding:5px 10px; border-radius:2px;
    transform:rotate(-3deg); display:inline-block; font-weight:600;
    white-space:nowrap;
  }
  .tabs{display:flex; gap:22px; margin:-8px 0 26px; font-family:'IBM Plex Mono', monospace; font-size:12px; letter-spacing:0.1em; text-transform:uppercase;}
  .tab{color:#A6A29A; text-decoration:none; padding-bottom:6px; border-bottom:2px solid transparent;}
  .tab:hover{color:#FAFAF7;}
  .tab.is-active{color:#FAFAF7; border-bottom-color:#FF1F3D;}
  .nav{display:flex; justify-content:space-between; align-items:center; gap:16px; margin-bottom:40px; flex-wrap:wrap;}
  .nav-link{font-family:'IBM Plex Mono', monospace; font-size:12px; letter-spacing:0.08em; text-transform:uppercase; color:#FAFAF7; text-decoration:none; border:1px solid rgba(250,250,247,0.35); padding:9px 14px; border-radius:2px; white-space:nowrap;}
  .nav-link:hover{border-color:#FF1F3D; color:#FF1F3D;}
  .search-wrap{position:relative; flex:1; min-width:220px;}
  .search-input{width:100%; background:#151513; border:1px solid rgba(250,250,247,0.3); color:#FAFAF7; font-family:'IBM Plex Mono', monospace; font-size:13px; padding:10px 12px; border-radius:2px; outline:none;}
  .search-input::placeholder{color:#6B6860;}
  .search-input:focus{border-color:#FF1F3D;}
  .search-results{position:absolute; top:calc(100% + 6px); left:0; right:0; background:#111110; border:1px solid rgba(250,250,247,0.25); border-radius:4px; max-height:380px; overflow-y:auto; z-index:20; display:none;}
  .search-results.active{display:block;}
  .search-result{display:block; padding:10px 12px; border-bottom:1px solid rgba(250,250,247,0.12); text-decoration:none;}
  .search-result:last-child{border-bottom:none;}
  .search-result:hover{background:rgba(255,31,61,0.08);}
  .sr-tag{font-family:'IBM Plex Mono', monospace; font-size:10px; letter-spacing:0.08em; text-transform:uppercase; color:#A6A29A;}
  .sr-title{display:block; font-style:italic; color:#FAFAF7; margin:2px 0; font-size:14px;}
  .sr-meta{font-family:'IBM Plex Mono', monospace; font-size:10.5px; color:#A6A29A;}
  .search-empty{padding:14px 12px; font-family:'IBM Plex Mono', monospace; font-size:12.5px; color:#A6A29A;}
  h1.hero{
    font-family:'Anton', sans-serif;
    font-weight:400;
    font-size:clamp(42px,10vw,72px);
    line-height:0.94;
    text-transform:uppercase;
    margin:0 0 22px;
    color:#FAFAF7;
  }
  h1.hero .pop{color:#FF1F3D;}
  .intro{font-size:17px; color:#EDEAE2; max-width:56ch; margin-bottom:10px;}
  .intro-byline{
    font-family:'IBM Plex Mono', monospace;
    font-size:11px; letter-spacing:0.08em; text-transform:uppercase;
    color:#A6A29A;
    margin-top:16px; margin-bottom:54px; display:block;
    border-left:2px solid #FF1F3D; padding-left:10px;
  }
  .section{position:relative; margin-bottom:50px; padding-left:56px;}
  .section:last-of-type{margin-bottom:0;}
  .stampnum{
    position:absolute; left:0; top:0;
    width:42px; height:42px;
    border:2px solid #FAFAF7;
    border-radius:50%;
    display:flex; align-items:center; justify-content:center;
    font-family:'Archivo Black', sans-serif;
    font-size:15px; color:#FAFAF7;
    transform:rotate(-6deg);
  }
  .art .stampnum{border-color:#C9A24B; color:#C9A24B;}
  .film .stampnum{border-color:#FF5B4A; color:#FF5B4A;}
  .tech .stampnum{border-color:#3FE0D0; color:#3FE0D0;}
  .lit .stampnum{border-color:#B39DFF; color:#B39DFF;}
  .music .stampnum{border-color:#FF5FA8; color:#FF5FA8;}
  .design .stampnum{border-color:#FFD23F; color:#FFD23F;}
  .fashion .stampnum{border-color:#FAFAF7; color:#FAFAF7;}
  .section-head{display:flex; align-items:center; gap:12px; margin-bottom:18px; flex-wrap:wrap;}
  .section-tag{
    font-family:'IBM Plex Mono', monospace;
    font-size:12px; font-weight:600; letter-spacing:0.1em; text-transform:uppercase;
    color:#0A0A0A;
    padding:6px 11px; border-radius:2px;
  }
  .art .section-tag{background:#C9A24B;}
  .film .section-tag{background:#FF5B4A;}
  .tech .section-tag{background:#3FE0D0;}
  .lit .section-tag{background:#B39DFF;}
  .music .section-tag{background:#FF5FA8;}
  .design .section-tag{background:#FFD23F;}
  .fashion .section-tag{background:#FAFAF7;}
  .section-title{
    font-family:'Archivo Black', sans-serif;
    font-size:24px; text-transform:uppercase; letter-spacing:0.01em;
    color:#FAFAF7;
  }
  .entry{margin-bottom:24px; padding-bottom:24px; border-bottom:1px solid rgba(250,250,247,0.16); scroll-margin-top:24px;}
  .entry:last-child{border-bottom:none; margin-bottom:0; padding-bottom:0;}
  .entry-byline{font-family:'IBM Plex Mono', monospace; font-size:12px; color:#A6A29A; margin-bottom:8px;}
  .entry-title{font-weight:500; font-style:italic; color:#FAFAF7; text-decoration:underline; text-decoration-color:rgba(250,250,247,0.35); text-underline-offset:3px;}
  .entry-title:hover{text-decoration-color:#FF1F3D;}
  .entry p{margin:0 0 10px; font-size:16px; color:#EDEAE2;}
  .entry .why{font-size:14.5px; color:#A6A29A; font-style:italic;}
  .entry .why::before{content:"— ";}
  .issue-list{list-style:none; margin:0; padding:0;}
  .issue-card{display:block; text-decoration:none; padding:22px 0; border-bottom:1px solid rgba(250,250,247,0.16);}
  .issue-card:first-child{padding-top:0;}
  .issue-card:hover .issue-headline{ text-decoration-color:#FF1F3D; }
  .issue-meta{font-family:'IBM Plex Mono', monospace; font-size:11px; letter-spacing:0.08em; text-transform:uppercase; color:#A6A29A; margin-bottom:8px;}
  .issue-meta .num{color:#FF1F3D;}
  .issue-headline{font-family:'Archivo Black', sans-serif; font-size:22px; text-transform:uppercase; letter-spacing:0.01em; color:#FAFAF7; text-decoration:underline; text-decoration-color:rgba(250,250,247,0.35); text-underline-offset:4px; display:inline-block; margin-bottom:8px;}
  .issue-desc{font-size:15px; color:#A6A29A; max-width:60ch; margin:0;}
  footer{
    margin-top:64px; padding-top:20px; border-top:1px solid rgba(250,250,247,0.16);
    display:flex; justify-content:space-between; gap:12px;
    font-family:'IBM Plex Mono', monospace; font-size:10.5px;
    letter-spacing:0.06em; color:#A6A29A; text-transform:uppercase;
  }
  @media (max-width:520px){
    .wrap{padding:30px 16px 70px;}
    .section{padding-left:48px;}
    .stampnum{width:36px; height:36px; font-size:13px;}
    .section-title{font-size:20px;}
    .nav{flex-direction:column; align-items:stretch;}
  }`;

const SEARCH_SCRIPT = `
(function(){
  var root = document.body.getAttribute('data-root') || '';
  var input = document.getElementById('searchInput');
  var results = document.getElementById('searchResults');
  if(!input) return;
  var indexData = null;
  function loadIndex(){
    if(indexData) return Promise.resolve(indexData);
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
    if(!q){ results.classList.remove('active'); results.innerHTML=''; return; }
    if(matches.length===0){
      results.innerHTML = '<div class="search-empty">No entries match &ldquo;'+escapeHtml(q)+'&rdquo;.</div>';
      results.classList.add('active');
      return;
    }
    results.innerHTML = matches.slice(0,20).map(function(m){
      return '<a class="search-result" href="'+root+m.page+'#'+m.anchor+'">'+
        '<span class="sr-tag">'+escapeHtml(m.category)+' — '+escapeHtml(m.date)+'</span>'+
        '<span class="sr-title">'+escapeHtml(m.title)+'</span>'+
        '<span class="sr-meta">'+escapeHtml(m.author)+' &middot; '+escapeHtml(m.source)+'</span>'+
      '</a>';
    }).join('');
    results.classList.add('active');
  }
  input.addEventListener('input', function(){
    var q = input.value.trim().toLowerCase();
    if(!q){ render([], ''); return; }
    loadIndex().then(function(data){
      render(data.filter(function(e){
        return (e.title+' '+e.author+' '+e.source+' '+e.category+' '+e.summary)
          .toLowerCase().indexOf(q) !== -1;
      }), q);
    });
  });
  document.addEventListener('click', function(e){
    if(!e.target.closest('.search-wrap')){ results.classList.remove('active'); }
  });
})();`;

function head(title, extraStyles = '') {
  return `<!DOCTYPE html>
<html lang="en">
<head>
<meta charset="UTF-8">
<meta name="viewport" content="width=device-width, initial-scale=1.0">
<meta name="color-scheme" content="dark">
<meta name="theme-color" content="#0A0A0A">
<title>${esc(title)}</title>
<link rel="preconnect" href="https://fonts.googleapis.com">
<link rel="preconnect" href="https://fonts.gstatic.com" crossorigin>
<link href="https://fonts.googleapis.com/css2?family=Anton&family=Archivo+Black&family=Source+Serif+4:ital,wght@0,400;0,500;1,400&family=IBM+Plex+Mono:wght@400;500;600&display=swap" rel="stylesheet">
<style>${STYLES}${extraStyles}
</style>
</head>`;
}

/** The two sections of the site. Shown on every page so New Music is one tap away. */
function tabs(root, active) {
  const tab = (href, label, key) =>
    `<a class="tab${active === key ? ' is-active' : ''}" href="${root}${href}"${active === key ? ' aria-current="page"' : ''}>${label}</a>`;
  return `  <nav class="tabs" aria-label="Sections">
    ${tab('index.html', 'Criticism', 'issues')}
    ${tab('music/index.html', 'New Music', 'music')}
  </nav>`;
}

/** An entry links out only when a verified URL exists — otherwise plain text. */
function renderEntry(entry, anchor) {
  const titleHtml = entry.url
    ? `<a class="entry-title" href="${esc(entry.url)}" target="_blank" rel="noopener">${esc(entry.title)}</a>`
    : `<span class="entry-title">${esc(entry.title)}</span>`;
  const byline = [
    titleHtml,
    entry.author ? ` by ${esc(entry.author)}` : '',
    entry.source ? ` — ${esc(entry.source)}` : '',
  ].join('');
  return `    <div class="entry" id="${esc(anchor)}">
      <div class="entry-byline">${byline}</div>
${
        entry.summary && String(entry.summary).trim()
          ? `\n      <p>${esc(entry.summary)}</p>`
          : ''
      }${
        entry.why && String(entry.why).trim()
          ? `\n      <p class="why">${esc(entry.why)}</p>`
          : ''
      }
    </div>`;
}

function renderIssue(issue, { root, isLatest }) {
  const sections = CATEGORY_ORDER.map((cat, i) => {
    const block = (issue.categories || []).find((c) => c.key === cat.key);
    if (!block || !block.entries || !block.entries.length) return '';
    const num = String(i + 1).padStart(2, '0');
    const entries = block.entries
      .map((e, j) => renderEntry(e, `${cat.key}-${j + 1}`))
      .join('\n');
    return `  <section class="section ${cat.key}">
    <span class="stampnum">${num}</span>
    <div class="section-head">
      <span class="section-tag">${esc(cat.tag)}</span>
      <h2 class="section-title">${esc(cat.title)}</h2>
    </div>
${entries}
  </section>`;
  }).filter(Boolean).join('\n');

  const nav = isLatest
    ? `  <div class="nav">
    <div class="search-wrap">
      <input type="text" id="searchInput" class="search-input" placeholder="Search past entries…" autocomplete="off">
      <div id="searchResults" class="search-results"></div>
    </div>
    <a class="nav-link" href="${root}archive/index.html">Browse Archive</a>
  </div>`
    : `  <div class="nav">
    <a class="nav-link" href="${root}index.html">&larr; Latest Issue</a>
    <a class="nav-link" href="${root}archive/index.html">Full Archive</a>
  </div>`;

  // The Pulse was retired on 30 Aug 2026 — it never had a real data source, so
  // it was inference presented as observation. Old issue files may still carry
  // a `pulse` key; it is deliberately not rendered, which retires the section
  // from the archive as well as the front page on the next build.

  return `${head(`Algorithm — Issue No. ${issue.issue}${isLatest ? '' : ` — ${formatDate(issue.date)}`}`)}
<body data-root="${root}">
<div class="page">
<div class="wrap">
  <div class="masthead">
    <a class="mast-title" href="${root}index.html">Algorithm</a>
    <span class="stamp">Issue No. ${esc(issue.issue)}</span>
  </div>
${tabs(root, 'issues')}
${nav}
  <h1 class="hero">${renderHeadline(issue.headline)}</h1>
  <p class="intro">${esc(issue.intro)}</p>
  <span class="intro-byline">${esc(issue.byline || `Issue No. ${issue.issue} — ${formatDate(issue.date)}`)}</span>
${sections}
  <footer>
    <span>Algorithm</span>
    <span>Issue No. ${esc(issue.issue)} — ${formatDate(issue.date)}</span>
  </footer>
</div>
</div>
${isLatest ? `<script>${SEARCH_SCRIPT}</script>` : ''}
</body>
</html>
`;
}

function renderArchiveIndex(issues) {
  const cards = issues.map((iss) => `    <li>
      <a class="issue-card" href="${String(iss.issue).padStart(4, '0')}.html">
        <div class="issue-meta"><span class="num">Issue No. ${esc(iss.issue)}</span> — ${formatDate(iss.date)}</div>
        <span class="issue-headline">${esc(String(iss.headline).replace(/\*/g, '').replace(/\n/g, ' '))}</span>
        <p class="issue-desc">${esc(iss.intro)}</p>
      </a>
    </li>`).join('\n');

  return `${head('Algorithm — Archive')}
<body data-root="../">
<div class="page">
<div class="wrap">
  <div class="masthead">
    <a class="mast-title" href="../index.html">Algorithm</a>
    <span class="stamp">Archive</span>
  </div>
${tabs('../', 'issues')}
  <div class="nav">
    <div class="search-wrap">
      <input type="text" id="searchInput" class="search-input" placeholder="Search past entries…" autocomplete="off">
      <div id="searchResults" class="search-results"></div>
    </div>
    <a class="nav-link" href="../index.html">Latest Issue</a>
  </div>
  <h1 class="hero">Every <span class="pop">issue.</span></h1>
  <p class="intro">Every past edition, newest first. Search above to find a specific piece, or browse the full run below.</p>
  <span class="intro-byline">${issues.length} issue${issues.length === 1 ? '' : 's'} archived</span>
  <ul class="issue-list">
${cards}
  </ul>
  <footer>
    <span>Algorithm</span>
    <span>Archive</span>
  </footer>
</div>
</div>
<script>${SEARCH_SCRIPT}</script>
</body>
</html>
`;
}

// ---------------------------------------------------------------------------
// New Music
//
// Folded in from the standalone "Fresh this week" page. Songs come from the
// weekly lists at the sites that cover new music full time; every song links
// to the post it was picked from. Thumbs are kept in the reader's browser and
// "Copy my thumbs" hands them back for music/taste.json, which steers the
// next batch.
// ---------------------------------------------------------------------------

const MUSIC_STYLES = `
  .mfilters{display:grid; gap:10px; margin-bottom:8px;}
  .mrow{display:flex; flex-wrap:wrap; align-items:center; gap:8px;}
  .mlabel{width:64px; flex:none; font-family:'IBM Plex Mono', monospace; font-size:11px; letter-spacing:0.08em; text-transform:uppercase; color:#A6A29A;}
  .chip{font-family:'IBM Plex Mono', monospace; font-size:12px; color:#FAFAF7; background:#151513; border:1px solid rgba(250,250,247,0.3); padding:6px 11px; border-radius:2px; cursor:pointer;}
  .chip:hover{border-color:#FF5FA8;}
  .chip[aria-pressed="true"]{background:#FF5FA8; border-color:#FF5FA8; color:#0A0A0A;}
  .mbar{display:flex; flex-wrap:wrap; align-items:center; justify-content:space-between; gap:10px; margin:22px 0 6px; padding:12px 0; border-top:2px solid #FAFAF7;}
  .mcount{font-family:'IBM Plex Mono', monospace; font-size:12px; color:#A6A29A; margin:0;}
  .mbtns{display:flex; gap:8px; flex-wrap:wrap;}
  .mbtn{font-family:'IBM Plex Mono', monospace; font-size:11.5px; letter-spacing:0.06em; text-transform:uppercase; color:#FAFAF7; background:none; border:1px solid rgba(250,250,247,0.35); padding:8px 12px; border-radius:2px; cursor:pointer; text-decoration:none; display:inline-block;}
  .mbtn:hover{border-color:#FF5FA8; color:#FF5FA8;}
  .song{display:grid; grid-template-columns:1fr auto; gap:6px 16px; padding:22px 0; border-bottom:1px solid rgba(250,250,247,0.16);}
  .song-title{font-family:'Archivo Black', sans-serif; font-size:21px; text-transform:uppercase; line-height:1.1; margin:0; color:#FAFAF7;}
  .song-artist{font-style:italic; color:#EDEAE2; margin:4px 0 8px; font-size:16px;}
  .song-note{margin:0 0 8px; font-size:15.5px; color:#EDEAE2; max-width:60ch;}
  .song-src{font-family:'IBM Plex Mono', monospace; font-size:11px; color:#A6A29A; margin:0 0 12px;}
  .song-src a{color:#A6A29A; text-underline-offset:3px;}
  .song-src .new{color:#0A0A0A; background:#FF5FA8; padding:1px 6px; border-radius:2px; margin-left:6px;}
  .song .links{grid-column:1 / -1; display:flex; flex-wrap:wrap; gap:8px;}
  .react{display:flex; gap:6px; align-self:start;}
  .react button{width:38px; height:38px; display:grid; place-items:center; background:#151513; color:#FAFAF7; border:1px solid rgba(250,250,247,0.3); border-radius:2px; cursor:pointer; font-size:16px;}
  .react button:hover{border-color:#FF5FA8;}
  .react .up[aria-pressed="true"]{background:#FF5FA8; border-color:#FF5FA8; color:#0A0A0A;}
  .react .down[aria-pressed="true"]{background:#FAFAF7; border-color:#FAFAF7; color:#0A0A0A;}
  .song.is-disliked .song-title, .song.is-disliked .song-artist, .song.is-disliked .song-note{opacity:0.45;}
  .mempty{font-family:'IBM Plex Mono', monospace; font-size:13px; color:#A6A29A; padding:32px 0;}
  .sources{list-style:none; margin:0; padding:0;}
  .sources li{padding:14px 0; border-bottom:1px solid rgba(250,250,247,0.16);}
  .sources b{font-family:'Archivo Black', sans-serif; text-transform:uppercase; font-weight:400; font-size:16px;}
  .sources span{display:block; color:#A6A29A; font-size:14.5px;}
  h2.mhead{font-family:'Archivo Black', sans-serif; font-size:24px; text-transform:uppercase; margin:56px 0 14px; color:#FAFAF7;}
  @media (max-width:520px){ .mlabel{width:100%;} .song-title{font-size:18px;} }`;

const MUSIC_SCRIPT = `
(function(){
  var ITEMS = JSON.parse(document.getElementById('music-data').textContent);
  var K_TASTE = 'algorithm-music-taste', K_VIEW = 'algorithm-music-view';
  function load(k, f){ try { var v = JSON.parse(localStorage.getItem(k) || 'null'); return v == null ? f : v; } catch (e) { return f; } }
  function save(k, v){ try { localStorage.setItem(k, JSON.stringify(v)); } catch (e) {} }
  var taste = load(K_TASTE, {});
  var state = Object.assign({ batch: 'all', site: 'all', rating: 'all', q: '' }, load(K_VIEW, {}), { q: '' });
  var BATCHES = Array.from(new Set(ITEMS.map(function(i){ return i.batch; }))).sort(function(a,b){ return b-a; });
  var SITES = Array.from(new Set(ITEMS.map(function(i){ return i.site; })));
  if (state.batch !== 'all' && BATCHES.indexOf(Number(state.batch)) === -1) state.batch = 'all';
  if (state.site !== 'all' && SITES.indexOf(state.site) === -1) state.site = 'all';
  var $ = function(id){ return document.getElementById(id); };

  function copy(text, btn, done){
    var finish = function(){ var l = btn.textContent; btn.textContent = done; setTimeout(function(){ btn.textContent = l; }, 2000); };
    var fallback = function(){ var t = document.createElement('textarea'); t.value = text; t.style.position = 'fixed'; t.style.opacity = '0'; document.body.appendChild(t); t.select(); try { document.execCommand('copy'); } catch (e) {} document.body.removeChild(t); finish(); };
    if (navigator.clipboard && navigator.clipboard.writeText) navigator.clipboard.writeText(text).then(finish, fallback); else fallback();
  }
  function matches(i){
    if (state.batch !== 'all' && i.batch !== Number(state.batch)) return false;
    if (state.site !== 'all' && i.site !== state.site) return false;
    if (state.rating === 'liked' && !(taste[i.id] && taste[i.id].v === 1)) return false;
    if (state.q && [i.artist, i.title, i.note, i.site].join(' ').toLowerCase().indexOf(state.q.toLowerCase()) === -1) return false;
    return true;
  }
  function visible(){ return ITEMS.filter(matches).sort(function(a,b){ return b.batch - a.batch; }); }

  function chip(parent, value, label, key){
    var b = document.createElement('button'); b.type = 'button'; b.className = 'chip'; b.textContent = label; b.dataset.value = String(value);
    b.addEventListener('click', function(){ state[key] = String(value); save(K_VIEW, { batch: state.batch, site: state.site, rating: state.rating }); sync(); render(); });
    parent.appendChild(b);
  }
  function sync(){
    [['f-batch','batch'],['f-site','site'],['f-rating','rating']].forEach(function(p){
      Array.prototype.forEach.call($(p[0]).children, function(b){ b.setAttribute('aria-pressed', b.dataset.value === String(state[p[1]]) ? 'true' : 'false'); });
    });
  }

  function link(parent, href, text){ var a = document.createElement('a'); a.className = 'mbtn'; a.href = href; a.target = '_blank'; a.rel = 'noopener'; a.textContent = text; parent.appendChild(a); }
  function card(item){
    var q = encodeURIComponent(item.search || (item.title + ' ' + item.artist));
    var row = document.createElement('article'); row.className = 'song';
    var main = document.createElement('div');
    var t = document.createElement('h3'); t.className = 'song-title'; t.textContent = item.title;
    var a = document.createElement('p'); a.className = 'song-artist'; a.textContent = item.artist;
    main.appendChild(t); main.appendChild(a);
    if (item.note) { var n = document.createElement('p'); n.className = 'song-note'; n.textContent = item.note; main.appendChild(n); }
    var s = document.createElement('p'); s.className = 'song-src';
    s.appendChild(document.createTextNode(item.site + ' \\u00b7 '));
    var sa = document.createElement('a'); sa.href = item.src.url; sa.target = '_blank'; sa.rel = 'noopener'; sa.textContent = item.src.label; s.appendChild(sa);
    if (item.batch === BATCHES[0]) { var nw = document.createElement('span'); nw.className = 'new'; nw.textContent = 'New'; s.appendChild(nw); }
    main.appendChild(s);

    var react = document.createElement('div'); react.className = 'react';
    var up = document.createElement('button'); up.type = 'button'; up.className = 'up'; up.textContent = '\\u25B2'; up.setAttribute('aria-label', 'Like ' + item.title + ' by ' + item.artist);
    var down = document.createElement('button'); down.type = 'button'; down.className = 'down'; down.textContent = '\\u25BC'; down.setAttribute('aria-label', 'Dislike ' + item.title + ' by ' + item.artist);
    react.appendChild(up); react.appendChild(down);
    function paint(){ var v = taste[item.id] ? taste[item.id].v : 0; up.setAttribute('aria-pressed', v === 1 ? 'true' : 'false'); down.setAttribute('aria-pressed', v === -1 ? 'true' : 'false'); row.classList.toggle('is-disliked', v === -1); }
    function choose(v){ if (taste[item.id] && taste[item.id].v === v) delete taste[item.id]; else taste[item.id] = { v: v, artist: item.artist, title: item.title, site: item.site }; save(K_TASTE, taste); if (state.rating === 'liked') render(); else { paint(); count(); } }
    up.addEventListener('click', function(){ choose(1); }); down.addEventListener('click', function(){ choose(-1); });
    paint();

    var links = document.createElement('div'); links.className = 'links';
    link(links, item.yt ? 'https://www.youtube.com/watch?v=' + item.yt : 'https://www.youtube.com/results?search_query=' + q, 'YouTube');
    link(links, 'https://open.spotify.com/search/' + q, 'Spotify');
    link(links, item.bc || ('https://bandcamp.com/search?q=' + q + '&item_type=t'), 'Bandcamp');
    var cb = document.createElement('button'); cb.type = 'button'; cb.className = 'mbtn'; cb.textContent = 'Copy name';
    cb.addEventListener('click', function(){ copy(item.search || (item.title + ' ' + item.artist), cb, 'Copied'); });
    links.appendChild(cb);

    row.appendChild(main); row.appendChild(react); row.appendChild(links);
    return row;
  }
  function count(){
    var vis = visible();
    var likes = Object.keys(taste).filter(function(k){ return taste[k].v === 1; }).length;
    var dislikes = Object.keys(taste).filter(function(k){ return taste[k].v === -1; }).length;
    var s = vis.length + (vis.length === 1 ? ' song' : ' songs') + (vis.length !== ITEMS.length ? ' of ' + ITEMS.length : '');
    if (likes + dislikes) s += ' \\u00b7 ' + likes + ' liked, ' + dislikes + ' disliked';
    $('count').textContent = s;
  }
  function render(){
    var vis = visible(), list = $('list');
    list.textContent = '';
    if (!vis.length) { var e = document.createElement('p'); e.className = 'mempty'; e.textContent = state.rating === 'liked' ? 'Nothing liked yet. Tap \\u25B2 on a song and it shows up here.' : 'No songs match.'; list.appendChild(e); }
    vis.forEach(function(i){ list.appendChild(card(i)); });
    count();
  }

  chip($('f-batch'), 'all', 'All', 'batch');
  BATCHES.forEach(function(n){ chip($('f-batch'), n, 'Batch ' + n, 'batch'); });
  chip($('f-site'), 'all', 'All', 'site');
  SITES.forEach(function(s){ chip($('f-site'), s, s, 'site'); });
  chip($('f-rating'), 'all', 'All', 'rating');
  chip($('f-rating'), 'liked', 'Liked', 'rating');
  $('q').addEventListener('input', function(){ state.q = this.value.trim(); render(); });
  $('copylist').addEventListener('click', function(){ copy(visible().map(function(i){ return i.artist + ' \\u2013 ' + i.title; }).join('\\n'), this, 'Copied'); });
  $('copytaste').addEventListener('click', function(){
    var liked = [], disliked = [];
    Object.keys(taste).forEach(function(k){ (taste[k].v === 1 ? liked : disliked).push(taste[k].artist + ' \\u2013 ' + taste[k].title); });
    copy(JSON.stringify({ liked: liked, disliked: disliked }, null, 2), this, 'Copied. Paste it into music/taste.json or to Claude');
  });
  sync(); render();
})();`;

function renderMusicPage(batches, sources) {
  const items = batches.flatMap((b) => b.items.map((i) => ({ ...i, batch: b.batch })));
  const latest = batches.length ? batches[batches.length - 1] : null;
  const usedSites = [...new Set(items.map((i) => i.site))];
  // JSON inside a <script> tag: escaping "<" keeps a stray "</script>" in a
  // song note from ending the block early.
  const data = JSON.stringify(items).replace(/</g, '\\u003c');
  const sourceList = usedSites
    .map((s) => `    <li><b>${esc(s)}</b><span>${esc((sources[s] && sources[s].blurb) || '')}</span></li>`)
    .join('\n');

  return `${head('Algorithm — New Music', MUSIC_STYLES)}
<body data-root="../">
<div class="page">
<div class="wrap">
  <div class="masthead">
    <a class="mast-title" href="../index.html">Algorithm</a>
    <span class="stamp">New Music</span>
  </div>
${tabs('../', 'music')}
  <h1 class="hero">Song <span class="pop">Troll.</span></h1>
  <p class="intro">Every week a handful of music sites name the new songs they can’t stop playing. These are picked from their lists, and every song links back to the post it came from.</p>
  <span class="intro-byline">${items.length} songs · ${batches.length} batch${batches.length === 1 ? '' : 'es'}${latest ? ` · updated ${formatDate(latest.date)}` : ''}</span>
  <div class="mfilters">
    <div class="mrow"><span class="mlabel">Batch</span><div class="mrow" id="f-batch" role="group" aria-label="Batch"></div></div>
    <div class="mrow"><span class="mlabel">Source</span><div class="mrow" id="f-site" role="group" aria-label="Source"></div></div>
    <div class="mrow"><span class="mlabel">Show</span><div class="mrow" id="f-rating" role="group" aria-label="Show"></div></div>
    <input id="q" class="search-input" type="search" placeholder="Search artist, song or sound…" aria-label="Search songs">
  </div>
  <div class="mbar">
    <p id="count" class="mcount" role="status" aria-live="polite"></p>
    <div class="mbtns">
      <button id="copylist" class="mbtn" type="button">Copy list</button>
      <button id="copytaste" class="mbtn" type="button">Copy my thumbs</button>
    </div>
  </div>
  <div id="list"></div>
  <h2 class="mhead">Where the picks come from</h2>
  <ul class="sources">
${sourceList}
  </ul>
  <footer>
    <span>Algorithm — New Music</span>
    <span>${latest ? `Batch ${latest.batch} — ${formatDate(latest.date)}` : ''}</span>
  </footer>
</div>
</div>
<script type="application/json" id="music-data">${data}</script>
<script>${MUSIC_SCRIPT}</script>
</body>
</html>
`;
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

  // Newest first. Two issues can share a date now, so date alone is not a
  // total order — break ties by issue number (higher = more recent).
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

  fs.writeFileSync(
    path.join(ROOT, 'index.html'),
    renderIssue(issues[0], { root: '', isLatest: true }),
  );

  fs.writeFileSync(path.join(ARCHIVE_DIR, 'index.html'), renderArchiveIndex(issues));

  fs.writeFileSync(
    path.join(ASSETS_DIR, 'search-index.json'),
    JSON.stringify(buildSearchIndex(issues), null, 2) + '\n',
  );

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
  console.log(`Latest: Issue No. ${issues[0].issue} (${issues[0].date})`);
}

main();
