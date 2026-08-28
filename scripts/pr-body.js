#!/usr/bin/env node
/** Renders a skimmable PR body from an issue JSON. Usage: node scripts/pr-body.js 2026-08-26 */

const fs = require('fs');
const path = require('path');

const NAMES = {
  art: 'Fine Art',
  film: 'Film Criticism',
  tech: 'Tech & AI',
  lit: 'Literary Reviews',
  music: 'Music Criticism',
  design: 'Design',
  fashion: 'Menswear',
};

const date = process.argv[2];
if (!date) {
  console.error('Usage: node scripts/pr-body.js YYYY-MM-DD');
  process.exit(1);
}

const file = path.resolve(__dirname, '..', 'issues', `${date}.json`);
const issue = JSON.parse(fs.readFileSync(file, 'utf8'));

const out = [];
out.push(`**${String(issue.headline).replace(/\*/g, '').replace(/\n/g, ' ')}**`);
out.push('');
out.push(issue.intro || '');
out.push('');

const sources = new Map();
let unlinked = 0;

for (const cat of issue.categories || []) {
  out.push(`### ${NAMES[cat.key] || cat.key}`);
  for (const e of cat.entries || []) {
    const title = e.url ? `[${e.title}](${e.url})` : `${e.title} — **no link**`;
    const author = e.author ? `${e.author}, ` : '';
    out.push(`- ${title}<br><sub>${author}${e.source || ''}</sub>`);
    if (!e.url) unlinked += 1;
    const s = String(e.source || '').trim();
    if (s) sources.set(s, (sources.get(s) || 0) + 1);
  }
  out.push('');
}

out.push('### The Pulse');
out.push('');
out.push(issue.pulse || '_No pulse section this issue._');
out.push('');

out.push('### At a glance');
out.push('');
out.push(`- ${sources.size} publications across ${(issue.categories || []).length} categories`);
if (unlinked) out.push(`- ⚠️ ${unlinked} entr${unlinked === 1 ? 'y has' : 'ies have'} no verified link`);
const repeated = [...sources.entries()].filter(([, n]) => n > 1);
if (repeated.length) {
  out.push(`- Publications used twice: ${repeated.map(([s]) => s).join(', ')}`);
}

console.log(out.join('\n'));
