#!/usr/bin/env node
/**
 * Algorithm — RSS/Atom feed audit.
 *
 * One-off diagnostic. Answers a single question: of the publications in
 * sources.md, how many expose a machine-readable feed?
 *
 * That number decides whether the newsletter can be rebuilt around feeds
 * (cheap, deterministic, no agentic loop) or whether a search-based
 * fallback is still needed for a meaningful share of the list.
 *
 * Writes nothing except a report to stdout and, optionally, a JSON map to
 * assets/feeds.json for a later build to consume. It never touches issues/.
 *
 * Domain resolution, in order of confidence:
 *   1. A domain written into sources.md itself, e.g. "Momus (CA, momus.ca)".
 *   2. The domain of a real URL this publication has already appeared under
 *      in a published issue. This is the most reliable signal available —
 *      it is a URL that actually worked.
 *   3. A guess from the publication name (lowercase, strip punctuation,
 *      + ".com"). Low confidence, flagged as such in the report.
 *
 * Feed discovery, in order:
 *   1. Fetch the homepage and read <link rel="alternate"> tags. This is the
 *      correct way and works regardless of the site's URL conventions.
 *   2. Fall back to common paths (/feed/, /rss.xml, ...) if the homepage
 *      can't be fetched or advertises nothing.
 *
 * Usage: node scripts/audit-feeds.js [--write]
 *        --write also saves assets/feeds.json
 *
 * Must run somewhere with open internet — a GitHub Actions runner is fine.
 */

const fs = require('fs');
const path = require('path');

const ROOT = path.resolve(__dirname, '..');
const SOURCES_FILE = path.join(ROOT, 'sources.md');
const ISSUES_DIR = path.join(ROOT, 'issues');

const UA =
  'Mozilla/5.0 (Macintosh; Intel Mac OS X 10_15_7) AppleWebKit/537.36 ' +
  '(KHTML, like Gecko) Chrome/124.0 Safari/537.36';

const TIMEOUT_MS = 12000;
const CONCURRENCY = 16;

// Trimmed from nine paths to four. The first run took 40+ minutes because
// every wrong guessed domain burned the full sequence before giving up.
// These four cover the overwhelming majority of real-world feeds; anything
// exotic is found via the homepage's declared <link> tag anyway, which is
// tried first and is the more reliable route regardless.
const CANDIDATE_PATHS = ['/feed/', '/rss.xml', '/feed.xml', '/atom.xml'];

const HEADER_TO_KEY = {
  'Fine Art': 'art',
  'Film Criticism': 'film',
  'Tech & AI': 'tech',
  'Literary Reviews': 'lit',
  'Music Criticism': 'music',
  'Design': 'design',
  'Menswear': 'fashion',
};

/** Parses sources.md into [{ name, category, domainHint }]. */
function parseSources() {
  const text = fs.readFileSync(SOURCES_FILE, 'utf8');
  const sectionRe = /^##\s+\d+\.\s+(.+?)(\s*⚠.*)?$/gm;
  const matches = [...text.matchAll(sectionRe)];
  const out = [];

  matches.forEach((m, i) => {
    const header = m[1].trim();
    const mapped = Object.entries(HEADER_TO_KEY).find(([h]) => header.startsWith(h));
    if (!mapped) return;
    const category = mapped[1];

    const start = m.index + m[0].length;
    const end = i + 1 < matches.length ? matches[i + 1].index : text.length;
    let section = text.slice(start, end);

    // Drop dead/rejected lists and the trailing prose notes.
    for (const marker of ['Dead, do not retry', 'Rejected:', '**Added ', '**Broadened']) {
      const idx = section.indexOf(marker);
      if (idx !== -1) section = section.slice(0, idx);
    }
    section = section.replace(/\*\*[^*]+\*\*\s*—/g, '');

    for (const part of section.split('·')) {
      const raw = part.replace(/\s+/g, ' ').trim();
      if (!raw) continue;
      if (/UNVERIFIED/i.test(raw)) continue; // known-unfetchable, skip

      const nameMatch = raw.match(/^([^(]+?)\s*\(/);
      const name = (nameMatch ? nameMatch[1] : raw).replace(/`/g, '').trim();
      if (!name || name.length > 60) continue;

      // A domain written inside the parentheses, if present.
      const paren = raw.match(/\(([^)]*)\)/);
      let domainHint = null;
      if (paren) {
        const d = paren[1].match(/([a-z0-9-]+(?:\.[a-z0-9-]+)+)(\/[^\s,]*)?/i);
        if (d) domainHint = d[0];
      }
      // A NEWS marker in the parentheses means the feed is a news wire:
      // usable to fill a thin category, never preferred over essay sources.
      const isNews = /\bNEWS\b/.test(raw);
      out.push({ name, category, domainHint, tier: isNews ? 'news' : 'essay' });
    }
  });

  // De-duplicate: a publication can legitimately appear in two categories
  // (032c shows up in three). Audit it once, remember every category.
  const byName = new Map();
  for (const s of out) {
    const existing = byName.get(s.name);
    if (existing) {
      existing.categories.add(s.category);
      if (!existing.domainHint && s.domainHint) existing.domainHint = s.domainHint;
      if (s.tier === 'essay') existing.tier = 'essay';
    } else {
      byName.set(s.name, {
        name: s.name,
        categories: new Set([s.category]),
        domainHint: s.domainHint,
        tier: s.tier,
      });
    }
  }
  return [...byName.values()];
}

/** Maps publication name -> domain, learned from URLs that actually worked. */
function domainsFromPublishedIssues() {
  const map = new Map();
  if (!fs.existsSync(ISSUES_DIR)) return map;
  const files = fs.readdirSync(ISSUES_DIR).filter((f) => /^\d{4}\.json$/.test(f));
  for (const f of files) {
    let issue;
    try {
      issue = JSON.parse(fs.readFileSync(path.join(ISSUES_DIR, f), 'utf8'));
    } catch {
      continue;
    }
    for (const c of issue.categories || []) {
      for (const e of c.entries || []) {
        if (!e.url || !e.source) continue;
        try {
          map.set(String(e.source).trim(), new URL(e.url).hostname);
        } catch {
          /* malformed URL in an old issue; ignore */
        }
      }
    }
  }
  return map;
}

function guessDomain(name) {
  const slug = name
    .toLowerCase()
    .replace(/&/g, 'and')
    .replace(/[^a-z0-9]/g, '');
  return slug ? `${slug}.com` : null;
}

async function get(url) {
  const ctrl = new AbortController();
  const timer = setTimeout(() => ctrl.abort(), TIMEOUT_MS);
  try {
    const res = await fetch(url, {
      redirect: 'follow',
      signal: ctrl.signal,
      headers: { 'User-Agent': UA, Accept: '*/*' },
    });
    const body = await res.text();
    return { ok: res.ok, status: res.status, body, url: res.url };
  } catch (err) {
    const name = String(err.name || err);
    const label =
      name === 'AbortError' ? 'timeout'
      : /ENOTFOUND|EAI_AGAIN|TypeError/.test(name) ? 'domain did not resolve'
      : name;
    return { ok: false, status: 0, body: '', error: label };
  } finally {
    clearTimeout(timer);
  }
}

function looksLikeFeed(body) {
  const head = body.slice(0, 2000).toLowerCase();
  return (
    head.includes('<rss') ||
    head.includes('<feed') ||
    head.includes('<rdf:rdf') ||
    (head.includes('<?xml') && (head.includes('<channel') || head.includes('atom')))
  );
}

/** Reads <link rel="alternate" type="application/rss+xml" href="..."> tags. */
function feedLinksFromHtml(html, baseUrl) {
  const out = [];
  const linkRe = /<link\b[^>]*>/gi;
  for (const tag of html.match(linkRe) || []) {
    if (!/rel\s*=\s*["']?alternate/i.test(tag)) continue;
    if (!/type\s*=\s*["']?application\/(rss|atom)\+xml/i.test(tag)) continue;
    const href = tag.match(/href\s*=\s*["']([^"']+)["']/i);
    if (!href) continue;
    try {
      out.push(new URL(href[1], baseUrl).toString());
    } catch {
      /* skip unparseable href */
    }
  }
  return out;
}

async function findFeed(domain) {
  const base = domain.startsWith('http') ? domain : `https://${domain}`;

  // 1. Ask the homepage what it advertises.
  const home = await get(base);
  if (home.ok && home.body) {
    if (looksLikeFeed(home.body)) return { feed: home.url, via: 'direct' };
    for (const candidate of feedLinksFromHtml(home.body, home.url)) {
      const r = await get(candidate);
      if (r.ok && looksLikeFeed(r.body)) return { feed: candidate, via: 'declared' };
    }
  }

  // 2. Try the usual paths — but only if something is actually served at
  //     this domain. If the homepage didn't resolve, guessing paths on a
  //     nonexistent host just burns one timeout per path for nothing. This
  //     is what made the first run take 40 minutes.
  if (!home.status) {
    return { feed: null, via: null, blocked: false, note: home.error || 'unreachable' };
  }

  const origin = (() => {
    try {
      return new URL(base).origin;
    } catch {
      return null;
    }
  })();
  if (origin) {
    for (const p of CANDIDATE_PATHS) {
      const r = await get(origin + p);
      if (r.ok && looksLikeFeed(r.body)) return { feed: origin + p, via: 'guessed-path' };
    }
  }

  const blocked = [401, 403, 405, 406, 429, 503].includes(home.status);
  return {
    feed: null,
    via: null,
    blocked,
    note: home.status
      ? `homepage HTTP ${home.status}${blocked ? ' — bot-blocked, feed may still exist' : ''}`
      : home.error || 'unreachable',
  };
}

async function mapLimit(items, limit, fn) {
  const results = new Array(items.length);
  let next = 0;
  await Promise.all(
    Array.from({ length: Math.min(limit, items.length) }, async () => {
      while (true) {
        const i = next++;
        if (i >= items.length) return;
        results[i] = await fn(items[i], i);
      }
    }),
  );
  return results;
}

async function main() {
  const sources = parseSources();
  const known = domainsFromPublishedIssues();

  for (const s of sources) {
    if (s.domainHint) {
      s.domain = s.domainHint;
      s.confidence = 'stated';
    } else if (known.has(s.name)) {
      s.domain = known.get(s.name);
      s.confidence = 'observed';
    } else {
      s.domain = guessDomain(s.name);
      s.confidence = 'guessed';
    }
  }

  // --dry resolves domains and prints them without touching the network.
  // Lets the parser be checked anywhere, including sandboxes with no egress.
  if (process.argv.includes('--dry')) {
    const counts = { stated: 0, observed: 0, guessed: 0 };
    for (const s of sources) counts[s.confidence]++;
    console.log(`Parsed ${sources.length} unique publications from sources.md\n`);
    console.log(`Domain resolution:`);
    console.log(`  stated in sources.md      ${counts.stated}`);
    console.log(`  observed in past issues   ${counts.observed}`);
    console.log(`  guessed from name         ${counts.guessed}\n`);
    for (const s of sources.slice(0, 15)) {
      console.log(`  ${s.confidence.padEnd(9)} ${s.name.padEnd(32)} ${s.domain}`);
    }
    console.log(`  ... and ${Math.max(0, sources.length - 15)} more`);
    return;
  }

  console.log(`Auditing ${sources.length} publications for RSS/Atom feeds...\n`);

  const results = await mapLimit(sources, CONCURRENCY, async (s) => {
    if (!s.domain) return { ...s, feed: null, note: 'no domain' };
    const r = await findFeed(s.domain);
    return { ...s, ...r };
  });

  const byCategory = {};
  for (const r of results) {
    for (const cat of r.categories) {
      (byCategory[cat] = byCategory[cat] || []).push(r);
    }
  }

  for (const cat of Object.keys(byCategory).sort()) {
    const rows = byCategory[cat];
    const hits = rows.filter((r) => r.feed);
    console.log(`## ${cat} — ${hits.length}/${rows.length} have feeds`);
    for (const r of rows.sort((a, b) => a.name.localeCompare(b.name))) {
      if (r.feed) {
        const flag = r.confidence === 'guessed' ? '  [domain guessed — verify]' : '';
        console.log(`  OK    ${r.name.padEnd(32)} ${r.feed}${flag}`);
      } else {
        console.log(`  ----  ${r.name.padEnd(32)} (${r.note || 'no feed found'})`);
      }
    }
    console.log('');
  }

  const total = results.length;
  const withFeed = results.filter((r) => r.feed).length;
  const guessedHits = results.filter((r) => r.feed && r.confidence === 'guessed').length;

  // A miss only means "no feed" if we were sure of the address. A miss on a
  // guessed domain usually means the guess was wrong — mousse.com is not
  // Mousse, spike.com is not Spike. Counting those as "no feed" would
  // understate feed coverage and could wrongly sink the whole approach.
  const blocked = results.filter((r) => !r.feed && r.blocked);
  const reliableMiss = results.filter(
    (r) => !r.feed && !r.blocked && r.confidence !== 'guessed',
  );
  const unknown = results.filter(
    (r) => !r.feed && !r.blocked && r.confidence === 'guessed',
  );

  console.log('='.repeat(60));
  console.log(`FOUND A FEED:  ${withFeed}/${total}  (${Math.round((withFeed / total) * 100)}%)`);
  if (guessedHits) {
    console.log(`               ${guessedHits} via a guessed domain — spot-check these.`);
  }
  console.log(`NO FEED:       ${reliableMiss.length}  (domain was known, so this is a real negative)`);
  console.log(`BOT-BLOCKED:   ${blocked.length}  (403/429 etc — a feed may well exist behind the block)`);
  console.log(`UNKNOWN:       ${unknown.length}  (domain was guessed and failed — likely wrong address, not missing feed)`);
  console.log('');
  console.log(`Best case if every UNKNOWN and BOT-BLOCKED resolves: ${withFeed + unknown.length + blocked.length}/${total} (${Math.round(((withFeed + unknown.length + blocked.length) / total) * 100)}%)`);
  console.log(`Worst case: ${withFeed}/${total} (${Math.round((withFeed / total) * 100)}%)`);
  if (unknown.length) {
    console.log('');
    console.log('To tighten the estimate, add correct domains to sources.md for:');
    console.log('  ' + unknown.slice(0, 20).map((r) => r.name).join(', ') + (unknown.length > 20 ? ', ...' : ''));
  }

  if (process.argv.includes('--write')) {
    const map = {};
    for (const r of results) {
      if (!r.feed) continue;
      // tier drives editorial preference: 'essay' feeds are preferred and
      // 'news' feeds are used only to fill a category that would otherwise
      // be thin. A feed's existence was never a good selection criterion;
      // what it publishes is.
      map[r.name] = {
        feed: r.feed,
        categories: [...r.categories],
        confidence: r.confidence,
        tier: r.tier || 'essay',
      };
    }
    const outPath = path.join(ROOT, 'assets', 'feeds.json');
    fs.mkdirSync(path.dirname(outPath), { recursive: true });
    fs.writeFileSync(outPath, JSON.stringify(map, null, 2) + '\n');
    console.log(`\nWrote ${Object.keys(map).length} feeds to assets/feeds.json`);
  }
}

main().catch((err) => {
  console.error('Audit failed:', err);
  process.exit(1);
});
