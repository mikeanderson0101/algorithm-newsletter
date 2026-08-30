#!/usr/bin/env node
/**
 * Algorithm — static site builder.
 *
 * Reads every issues/YYYY-MM-DD.json and deterministically renders:
 *   index.html                 (most recent issue)
 *   archive/YYYY-MM-DD.html    (one permanent page per issue)
 *   archive/index.html         (browsable list, newest first)
 *   assets/search-index.json   (search data across all issues)
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

function head(title) {
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
<style>${STYLES}
</style>
</head>`;
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
      <p>${esc(entry.summary)}</p>
      <p class="why">${esc(entry.why)}</p>
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
      <a class="issue-card" href="${iss.date}.html">
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
          page: `archive/${issue.date}.html`,
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
    .filter((f) => /^\d{4}-\d{2}-\d{2}\.json$/.test(f))
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

  // Newest first.
  issues.sort((a, b) => (a.date < b.date ? 1 : a.date > b.date ? -1 : 0));

  fs.mkdirSync(ARCHIVE_DIR, { recursive: true });
  fs.mkdirSync(ASSETS_DIR, { recursive: true });

  for (const issue of issues) {
    fs.writeFileSync(
      path.join(ARCHIVE_DIR, `${issue.date}.html`),
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

  // GitHub Pages otherwise runs the site through Jekyll, which ignores some files.
  fs.writeFileSync(path.join(ROOT, '.nojekyll'), '');

  const entryCount = buildSearchIndex(issues).length;
  console.log(`Built ${issues.length} issue(s), ${entryCount} entries indexed.`);
  console.log(`Latest: Issue No. ${issues[0].issue} (${issues[0].date})`);
}

main();
