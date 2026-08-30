#!/usr/bin/env node
/**
 * Algorithm — recently-used publications.
 *
 * Prints a per-category list of publications that have run in the last few
 * issues, for injection into the composing prompt.
 *
 * This exists because of a real failure. Issues 1-3 drew four of six men's
 * fashion slots from Highsnobiety (both slots on 30 Aug), two of six music
 * slots from Bandcamp Daily, and two more fashion slots from Blackbird
 * Spyplane — so the whole fashion section came from two outlets. The validator
 * could not see it: its concentration rule only ever looked inside one issue.
 *
 * Rules are only half a fix. A model told "do not over-concentrate" with no
 * memory of yesterday will reach for the same obvious outlet every time. So
 * the model gets told, by name, which publications to leave alone today.
 *
 * Usage: node scripts/recent-sources.js [windowSize]
 */

const fs = require('fs');
const path = require('path');

const ROOT = path.resolve(__dirname, '..');
const ISSUES_DIR = path.join(ROOT, 'issues');

/** How many recent issues to consider. */
const WINDOW = Number(process.argv[2]) || 4;

const CATEGORY_LABEL = {
  art: 'art',
  film: 'film',
  tech: 'tech',
  lit: 'lit',
  music: 'music',
  design: 'design',
  fashion: 'fashion',
};

function main() {
  if (!fs.existsSync(ISSUES_DIR)) {
    console.log('(no issues yet — nothing to rest)');
    return;
  }

  const files = fs.readdirSync(ISSUES_DIR)
    .filter((f) => /^\d{4}-\d{2}-\d{2}\.json$/.test(f))
    .sort()
    .slice(-WINDOW);

  if (!files.length) {
    console.log('(no issues yet — nothing to rest)');
    return;
  }

  // category -> source -> { count, lastIssue }
  const byCategory = {};

  files.forEach((f, index) => {
    let issue;
    try {
      issue = JSON.parse(fs.readFileSync(path.join(ISSUES_DIR, f), 'utf8'));
    } catch {
      return;
    }
    for (const c of issue.categories || []) {
      const key = CATEGORY_LABEL[c.key] || c.key;
      byCategory[key] = byCategory[key] || {};
      for (const e of c.entries || []) {
        const s = String(e.source || '').trim();
        if (!s) continue;
        const rec = byCategory[key][s] || { count: 0, last: -1 };
        rec.count += 1;
        rec.last = Math.max(rec.last, index);
        byCategory[key][s] = rec;
      }
    }
  });

  const mostRecent = files.length - 1;
  const lines = [];

  for (const key of Object.keys(CATEGORY_LABEL)) {
    const sources = byCategory[key];
    if (!sources || !Object.keys(sources).length) continue;

    const entries = Object.entries(sources).sort((a, b) => {
      if (b[1].count !== a[1].count) return b[1].count - a[1].count;
      return b[1].last - a[1].last;
    });

    const rendered = entries.map(([name, rec]) => {
      const marks = [];
      // Three appearances in the window is already at the validator's limit;
      // a fourth fails the build.
      if (rec.count >= 3) marks.push('BLOCKED — at the limit, will fail validation');
      else if (rec.count === 2) marks.push('used twice');
      if (rec.last === mostRecent) marks.push('ran last issue');
      return marks.length ? `${name} (${marks.join('; ')})` : name;
    });

    lines.push(`- ${key}: ${rendered.join(' · ')}`);
  }

  if (!lines.length) {
    console.log('(no issues yet — nothing to rest)');
    return;
  }

  console.log(`Publications used in the last ${files.length} issue(s):`);
  console.log(lines.join('\n'));
}

main();
