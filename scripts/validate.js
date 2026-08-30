#!/usr/bin/env node
/**
 * Algorithm — issue validator.
 *
 * Runs BEFORE the build, and fails the workflow on any violation. This exists
 * because the first hand-made issue shipped two articles duplicated from a
 * sample template and one summary written from a headline without reading the
 * article. These checks make both of those failures impossible to merge.
 *
 * Usage: node scripts/validate.js [issues/YYYY-MM-DD.json]
 *        (with no argument, validates every issue file)
 */

const fs = require('fs');
const path = require('path');

const ROOT = path.resolve(__dirname, '..');
const ISSUES_DIR = path.join(ROOT, 'issues');

const REQUIRED_CATEGORIES = ['art', 'film', 'tech', 'lit', 'music', 'design', 'fashion'];
const ENTRIES_PER_CATEGORY = 2;

/**
 * Rotation: a publication may hold a given category in at most
 * MAX_PER_ROLLING_WINDOW of any ROLLING_WINDOW consecutive issues.
 * At four issues a week that is roughly "no more than every other issue".
 */
const ROLLING_WINDOW = 4;
const MAX_PER_ROLLING_WINDOW = 2;

const errors = [];
const warnings = [];

function err(msg) { errors.push(msg); }
function warn(msg) { warnings.push(msg); }

function countSentences(text) {
  return (String(text).match(/[.!?](\s|$)/g) || []).length;
}

function validateIssue(issue, filename, priorUrls, priorTitles, recentHistory) {
  const where = `issues/${filename}`;

  if (typeof issue.issue !== 'number' || issue.issue < 1) {
    err(`${where}: "issue" must be a positive number.`);
  }
  if (!/^\d{4}-\d{2}-\d{2}$/.test(issue.date || '')) {
    err(`${where}: "date" must be YYYY-MM-DD.`);
  } else if (`${issue.date}.json` !== filename) {
    err(`${where}: filename must match the "date" field (expected ${issue.date}.json).`);
  }

  if (!issue.headline || String(issue.headline).trim().length < 3) {
    err(`${where}: missing "headline".`);
  } else {
    const words = String(issue.headline).replace(/\*/g, '').trim().split(/\s+/).length;
    if (words < 3 || words > 6) {
      warn(`${where}: headline is ${words} words; the format calls for 3-6.`);
    }
    if (!/\*[^*]+\*/.test(issue.headline)) {
      warn(`${where}: headline has no *accent* markers, so nothing renders in red.`);
    }
  }

  if (!issue.intro || countSentences(issue.intro) < 2) {
    err(`${where}: "intro" must be 2-3 sentences.`);
  }

  // The Pulse was retired on 30 Aug 2026. It never had a real data source —
  // live social trends are not reachable from the research tools — so it was
  // either hedged prose or dressed-up guesswork. A stray `pulse` key in an old
  // issue file is harmless history; the builder simply ignores it.

  const cats = issue.categories || [];
  const seenKeys = new Set();

  for (const key of REQUIRED_CATEGORIES) {
    const block = cats.find((c) => c.key === key);
    if (!block) {
      err(`${where}: missing required category "${key}".`);
      continue;
    }
    seenKeys.add(key);
    const entries = block.entries || [];
    if (entries.length !== ENTRIES_PER_CATEGORY) {
      err(`${where}: category "${key}" has ${entries.length} entries; must have exactly ${ENTRIES_PER_CATEGORY}.`);
    }

    entries.forEach((e, i) => {
      const at = `${where} [${key} #${i + 1}]`;

      if (!e.title || !String(e.title).trim()) err(`${at}: missing "title".`);
      if (!e.source || !String(e.source).trim()) err(`${at}: missing "source".`);
      if (!e.summary || !String(e.summary).trim()) err(`${at}: missing "summary".`);
      if (!e.why || !String(e.why).trim()) err(`${at}: missing "why".`);

      // Link integrity: a URL is optional (cite by name if unverified) but if
      // present it must be a real absolute http(s) URL.
      if (e.url != null) {
        if (typeof e.url !== 'string' || !/^https?:\/\/[^\s]+$/i.test(e.url)) {
          err(`${at}: "url" is not a valid absolute http(s) URL: ${JSON.stringify(e.url)}`);
        }
        if (/example\.com|lorem|placeholder|TODO/i.test(e.url)) {
          err(`${at}: "url" looks like a placeholder: ${e.url}`);
        }
      }

      // The verification gate: an entry must record that the article was read.
      if (e.verified !== true) {
        err(`${at}: "verified" must be true — set it only after fetching and reading the article itself.`);
      }

      const sentences = countSentences(e.summary || '');
      if (sentences < 2 || sentences > 3) {
        warn(`${at}: summary is ${sentences} sentences; the format calls for 2.`);
      }
      if (countSentences(e.why || '') > 2) {
        warn(`${at}: "why" should be a single sentence.`);
      }
    });
  }

  for (const block of cats) {
    if (!REQUIRED_CATEGORIES.includes(block.key)) {
      err(`${where}: unknown category key "${block.key}".`);
    }
  }

  // Duplicate detection — within this issue and against every prior issue.
  const allEntries = cats.flatMap((c) => (c.entries || []).map((e) => ({ ...e, key: c.key })));
  const seenUrl = new Map();
  const seenTitle = new Map();

  for (const e of allEntries) {
    const at = `${where} [${e.key}]`;

    if (e.url) {
      const u = e.url.replace(/\/+$/, '').toLowerCase();
      if (seenUrl.has(u)) {
        err(`${at}: duplicate URL within this issue — "${e.title}" repeats ${seenUrl.get(u)}.`);
      }
      seenUrl.set(u, e.title);
      if (priorUrls.has(u)) {
        err(`${at}: "${e.title}" was already featured in ${priorUrls.get(u)}. Every issue must be new.`);
      }
    }

    if (e.title) {
      const t = String(e.title).trim().toLowerCase();
      if (seenTitle.has(t)) {
        err(`${at}: duplicate title within this issue: "${e.title}".`);
      }
      seenTitle.set(t, true);
      if (priorTitles.has(t)) {
        err(`${at}: title "${e.title}" was already featured in ${priorTitles.get(t)}.`);
      }
    }
  }

  // ---- Source concentration ----
  //
  // Three rules, each traceable to something that actually shipped.

  // (a) Whole-issue cap. The first hand-made draft drew both picks in five of
  //     seven categories from one publication.
  const sourceCounts = {};
  for (const e of allEntries) {
    const s = String(e.source || '').trim().toLowerCase();
    if (s) sourceCounts[s] = (sourceCounts[s] || 0) + 1;
  }
  for (const [source, n] of Object.entries(sourceCounts)) {
    if (n > 2) {
      err(`${where}: ${n} entries come from the same publication ("${source}"). Maximum is 2 per issue.`);
    }
  }

  // (b) Both picks in ONE category from one outlet. This was only a warning
  //     until 30 Aug 2026, which is precisely how that issue shipped a men's
  //     fashion section where both entries were Highsnobiety. Now it fails.
  for (const block of cats) {
    const counts = {};
    for (const e of block.entries || []) {
      const s = String(e.source || '').trim().toLowerCase();
      if (s) counts[s] = (counts[s] || 0) + 1;
    }
    for (const [source, n] of Object.entries(counts)) {
      if (n > 1) {
        err(`${where}: category "${block.key}" takes both picks from "${source}". The two entries must come from different publications.`);
      }
    }
  }

  // (c) Rolling-window rotation. Nothing above can see yesterday, so across
  //     issues 1-3 Highsnobiety took four of six fashion slots and Bandcamp
  //     Daily two of six music slots while every per-issue rule passed. A
  //     publication may now hold a category in at most 2 of any 4 consecutive
  //     issues.
  const historyCounts = {};
  for (const past of recentHistory) {
    for (const [key, sources] of Object.entries(past.byCategory)) {
      for (const source of new Set(sources)) {
        const id = `${key}::${source}`;
        historyCounts[id] = (historyCounts[id] || 0) + 1;
      }
    }
  }
  for (const block of cats) {
    for (const source of new Set((block.entries || []).map((e) => String(e.source || '').trim().toLowerCase()).filter(Boolean))) {
      const id = `${block.key}::${source}`;
      const priorAppearances = historyCounts[id] || 0;
      if (priorAppearances + 1 > MAX_PER_ROLLING_WINDOW) {
        err(
          `${where}: "${source}" would appear in ${priorAppearances + 1} of the last ${ROLLING_WINDOW} issues under "${block.key}". ` +
          `Maximum is ${MAX_PER_ROLLING_WINDOW}. Rest it and use another publication from sources.md.`
        );
      } else if (priorAppearances + 1 === MAX_PER_ROLLING_WINDOW) {
        warn(`${where}: "${source}" is now at the rotation limit for "${block.key}" (${MAX_PER_ROLLING_WINDOW} of ${ROLLING_WINDOW} issues). It must sit out the next one.`);
      }
    }
  }
}

function main() {
  const arg = process.argv[2];
  const files = fs.readdirSync(ISSUES_DIR)
    .filter((f) => /^\d{4}-\d{2}-\d{2}\.json$/.test(f))
    .sort();

  if (!files.length) {
    console.error('No issue files found in issues/.');
    process.exit(1);
  }

  const target = arg ? path.basename(arg) : null;
  if (target && !files.includes(target)) {
    console.error(`Issue file not found: issues/${target}`);
    process.exit(1);
  }

  // Everything published before the file(s) under test.
  const priorUrls = new Map();
  const priorTitles = new Map();

  // Per-issue record of which publication covered which category, in date
  // order. The rotation rule reads the tail of this.
  const history = [];

  for (const f of files) {
    const issue = JSON.parse(fs.readFileSync(path.join(ISSUES_DIR, f), 'utf8'));

    if (!target || f === target) {
      validateIssue(issue, f, priorUrls, priorTitles, history.slice(-(ROLLING_WINDOW - 1)));
    }

    const byCategory = {};
    for (const c of issue.categories || []) {
      byCategory[c.key] = (c.entries || [])
        .map((e) => String(e.source || '').trim().toLowerCase())
        .filter(Boolean);
      for (const e of c.entries || []) {
        if (e.url) priorUrls.set(e.url.replace(/\/+$/, '').toLowerCase(), f);
        if (e.title) priorTitles.set(String(e.title).trim().toLowerCase(), f);
      }
    }
    history.push({ file: f, byCategory });
  }

  for (const w of warnings) console.warn(`  warning  ${w}`);
  for (const e of errors) console.error(`  ERROR    ${e}`);

  if (errors.length) {
    console.error(`\nValidation failed: ${errors.length} error(s), ${warnings.length} warning(s).`);
    process.exit(1);
  }
  console.log(`\nValidation passed${warnings.length ? ` with ${warnings.length} warning(s)` : ''}.`);
}

main();
