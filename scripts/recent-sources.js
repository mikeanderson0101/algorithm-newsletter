#!/usr/bin/env node
/**
 * Algorithm — recently-used and never-used publications.
 *
 * Prints a per-category list of publications that have run recently (to
 * rest), AND publications that have never run at all (to reach for), for
 * injection into the composing prompt.
 *
 * This exists because of two related failures, both the same underlying
 * cause: a model with no memory of yesterday reaches for the same obvious
 * outlet every time.
 *
 * 1. Issues 1-3: four of six menswear slots went to Highsnobiety, two of
 *    six music slots to Bandcamp Daily. Fixed by surfacing recently-used
 *    outlets so the model rests them.
 * 2. Issues 1-4: the art category drew from only 5 of its ~19 verified
 *    outlets, with Momus, ART AFRICA and ArtAsiaPacific all sitting at the
 *    rotation ceiling simultaneously — while ArtReview, Frieze, Burlington
 *    Contemporary, Studio International, Mousse, Spike, Hyperallergic and
 *    e-flux Criticism, all verified and available, were never touched. The
 *    "rest list" alone doesn't fix this: an outlet below the rotation limit
 *    is never flagged, so the model has no signal that better options exist
 *    beyond the two or three it already reached for. Hence the "never used"
 *    section below — resting outlets stops repetition, but only naming
 *    untouched ones fixes actual under-use of an otherwise healthy pool.
 *
 * Usage: node scripts/recent-sources.js [windowSize]
 */

const fs = require('fs');
const path = require('path');

const ROOT = path.resolve(__dirname, '..');
const ISSUES_DIR = path.join(ROOT, 'issues');
const SOURCES_FILE = path.join(ROOT, 'sources.md');

/** How many recent issues to consider for the "rest" list. */
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

// Maps sources.md section headers to the same category keys used in issue
// JSON and validate.js. Update this if a header in sources.md changes.
const HEADER_TO_KEY = {
  'Fine Art': 'art',
  'Film Criticism': 'film',
  'Tech & AI': 'tech',
  'Literary Reviews': 'lit',
  'Music Criticism': 'music',
  'Design': 'design',
  'Menswear': 'fashion',
};

/**
 * Parses sources.md into { categoryKey: Set<publicationName> }.
 *
 * Works on whole numbered sections rather than line-by-line, because the
 * "**Region** — Name (X) · Name (Y) · ..." bullet lists wrap across several
 * physical lines in the file. A per-line regex only ever saw the first
 * physical line of each region and silently dropped the rest — caught by
 * testing this against the real file, where it returned 6 "never used" art
 * outlets instead of the correct ~14.
 *
 * Excludes entries marked PAYWALLED or UNVERIFIED — a name in the prompt's
 * "never used, reach for these" list has to be something the model can
 * actually fetch and read. Excludes "Dead, do not retry" / "Rejected" lists
 * entirely by cutting the section text there before parsing.
 */
function parseSourcesFile() {
  const text = fs.readFileSync(SOURCES_FILE, 'utf8');

  // Split into numbered sections: "## 1. Fine Art" ... up to the next "## ".
  const sectionRe = /^##\s+\d+\.\s+(.+?)(\s*⚠.*)?$/gm;
  const matches = [...text.matchAll(sectionRe)];

  const result = {};

  matches.forEach((m, i) => {
    const headerText = m[1].trim();
    const mapped = Object.entries(HEADER_TO_KEY).find(([h]) =>
      headerText.startsWith(h)
    );
    if (!mapped) return;
    const key = mapped[1];

    const start = m.index + m[0].length;
    const end = i + 1 < matches.length ? matches[i + 1].index : text.length;
    let section = text.slice(start, end);

    // Cut off dead/rejected lists — they're not usable sources.
    const cutMarkers = ['Dead, do not retry', 'Rejected:'];
    for (const marker of cutMarkers) {
      const idx = section.indexOf(marker);
      if (idx !== -1) section = section.slice(0, idx);
    }

    // Drop region bold-labels ("**Americas** — " etc.) so what remains is
    // just "Name (X) · Name (Y) · ..." blocks separated by blank lines.
    section = section.replace(/\*\*[^*]+\*\*\s*—/g, '');

    const parts = section.split('·');
    for (const part of parts) {
      const trimmed = part.replace(/\s+/g, ' ').trim();
      if (!trimmed) continue;
      if (/PAYWALLED|UNVERIFIED/.test(trimmed)) continue;
      const nameMatch = trimmed.match(/^([^(]+?)\s*\(/);
      const name = nameMatch ? nameMatch[1].trim() : trimmed;
      if (!name) continue;
      // Guard against picking up stray prose that leaked past the dash
      // strip (e.g. a trailing sentence). Publication names in this file
      // are short; anything absurdly long is almost certainly not one.
      if (name.length > 60) continue;
      result[key] = result[key] || new Set();
      result[key].add(name);
    }
  });

  return result;
}

function main() {
  const allSources = parseSourcesFile();

  if (!fs.existsSync(ISSUES_DIR)) {
    console.log('(no issues yet — nothing to rest)');
    return;
  }

  const allFiles = fs
    .readdirSync(ISSUES_DIR)
    .filter((f) => /^\d{4}-\d{2}-\d{2}\.json$/.test(f))
    .sort();

  if (!allFiles.length) {
    console.log('(no issues yet — nothing to rest)');
    return;
  }

  const windowFiles = allFiles.slice(-WINDOW);

  const byCategoryWindow = {};
  const usedEver = {};

  const loadIssue = (f) => {
    try {
      return JSON.parse(fs.readFileSync(path.join(ISSUES_DIR, f), 'utf8'));
    } catch {
      return null;
    }
  };

  allFiles.forEach((f) => {
    const issue = loadIssue(f);
    if (!issue) return;
    for (const c of issue.categories || []) {
      const key = CATEGORY_LABEL[c.key] || c.key;
      usedEver[key] = usedEver[key] || new Set();
      for (const e of c.entries || []) {
        const s = String(e.source || '').trim();
        if (s) usedEver[key].add(s);
      }
    }
  });

  windowFiles.forEach((f, index) => {
    const issue = loadIssue(f);
    if (!issue) return;
    for (const c of issue.categories || []) {
      const key = CATEGORY_LABEL[c.key] || c.key;
      byCategoryWindow[key] = byCategoryWindow[key] || {};
      for (const e of c.entries || []) {
        const s = String(e.source || '').trim();
        if (!s) continue;
        const rec = byCategoryWindow[key][s] || { count: 0, last: -1 };
        rec.count += 1;
        rec.last = Math.max(rec.last, index);
        byCategoryWindow[key][s] = rec;
      }
    }
  });

  const mostRecent = windowFiles.length - 1;
  const restLines = [];
  const freshLines = [];

  for (const key of Object.keys(CATEGORY_LABEL)) {
    const sources = byCategoryWindow[key];
    if (sources && Object.keys(sources).length) {
      const entries = Object.entries(sources).sort((a, b) => {
        if (b[1].count !== a[1].count) return b[1].count - a[1].count;
        return b[1].last - a[1].last;
      });
      const rendered = entries.map(([name, rec]) => {
        const marks = [];
        if (rec.count >= 3) marks.push('BLOCKED — at the limit, will fail validation');
        else if (rec.count === 2) marks.push('used twice');
        if (rec.last === mostRecent) marks.push('ran last issue');
        return marks.length ? `${name} (${marks.join('; ')})` : name;
      });
      restLines.push(`- ${key}: ${rendered.join(' · ')}`);
    }

    const verified = allSources[key];
    if (verified && verified.size) {
      const used = usedEver[key] || new Set();
      const never = [...verified].filter((name) => !used.has(name));
      if (never.length) {
        freshLines.push(`- ${key}: ${never.join(' · ')}`);
      }
    }
  }

  if (restLines.length) {
    console.log(`Publications used in the last ${windowFiles.length} issue(s):`);
    console.log(restLines.join('\n'));
  } else {
    console.log('(no issues yet — nothing to rest)');
  }

  if (freshLines.length) {
    console.log('');
    console.log(
      `Verified outlets never yet used, across all ${allFiles.length} issue(s) published so far:`
    );
    console.log(freshLines.join('\n'));
  }
}

main();
