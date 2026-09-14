#!/usr/bin/env node
/**
 * Algorithm — feed parsing and candidate selection. PURE FUNCTIONS ONLY.
 *
 * Nothing here touches the network, the filesystem, or the clock (the
 * current time is always passed in). That is deliberate: every rule that
 * decides what ends up in an issue lives in this file and can be tested
 * offline against fixtures, which is the opposite of the agentic pipeline
 * this replaces — where the only way to find out what it would do was to
 * spend several dollars and wait twenty-six minutes.
 *
 * The network wrapper lives in compose-from-feeds.js and is kept as thin
 * as possible for exactly that reason.
 */

'use strict';

// ---------------------------------------------------------------------------
// XML / HTML text handling
// ---------------------------------------------------------------------------

const NAMED_ENTITIES = {
  amp: '&', lt: '<', gt: '>', quot: '"', apos: "'", nbsp: ' ',
  ldquo: '\u201C', rdquo: '\u201D', lsquo: '\u2018', rsquo: '\u2019',
  mdash: '\u2014', ndash: '\u2013', hellip: '\u2026', eacute: '\u00E9',
  egrave: '\u00E8', agrave: '\u00E0', ccedil: '\u00E7', uuml: '\u00FC',
  ouml: '\u00F6', auml: '\u00E4', oslash: '\u00F8', aring: '\u00E5',
  szlig: '\u00DF', ntilde: '\u00F1', iexcl: '\u00A1', laquo: '\u00AB',
  raquo: '\u00BB', deg: '\u00B0', middot: '\u00B7', bull: '\u2022',
};

/** Decodes named and numeric XML/HTML entities, including double-encoded. */
function decodeEntities(str) {
  if (!str) return '';
  let out = String(str);
  // Two passes: feeds frequently double-encode (&amp;amp; -> &amp; -> &).
  for (let pass = 0; pass < 2; pass++) {
    out = out.replace(/&#x([0-9a-f]+);/gi, (_, h) => safeCodePoint(parseInt(h, 16)));
    out = out.replace(/&#(\d+);/g, (_, d) => safeCodePoint(parseInt(d, 10)));
    out = out.replace(/&([a-z]+[0-9]*);/gi, (m, name) => {
      const key = name.toLowerCase();
      return Object.prototype.hasOwnProperty.call(NAMED_ENTITIES, key)
        ? NAMED_ENTITIES[key]
        : m;
    });
  }
  return out;
}

function safeCodePoint(n) {
  if (!Number.isFinite(n) || n < 0 || n > 0x10ffff) return '';
  try {
    return String.fromCodePoint(n);
  } catch {
    return '';
  }
}

function removeTags(s) {
  return s
    .replace(/<script\b[\s\S]*?<\/script>/gi, ' ')
    .replace(/<style\b[\s\S]*?<\/style>/gi, ' ')
    .replace(/<br\s*\/?>/gi, ' ')
    .replace(/<\/p>/gi, ' ')
    .replace(/<[^>]+>/g, '');
}

/**
 * Strips tags and collapses whitespace. Feed summaries are full of markup.
 *
 * Decodes BEFORE stripping, then again after. Atom feeds routinely escape
 * their HTML (`&lt;p&gt;text&lt;/p&gt;` rather than `<p>text</p>`), so a
 * strip-then-decode order leaves literal tags sitting in the output and
 * they end up rendered on the site. Decoding first turns escaped markup
 * into real markup so the same stripper removes it; the second decode
 * handles entities that were only revealed once tags were gone.
 */
function stripHtml(str) {
  if (!str) return '';
  let s = String(str);
  s = decodeEntities(s);
  s = removeTags(s);
  s = decodeEntities(s);
  s = removeTags(s);
  return s.replace(/\s+/g, ' ').trim();
}

/** Trims to a whole word near `max`, adding an ellipsis only if cut. */
function truncate(str, max) {
  const s = String(str || '').trim();
  if (s.length <= max) return s;
  const cut = s.slice(0, max);
  const lastSpace = cut.lastIndexOf(' ');
  return (lastSpace > max * 0.6 ? cut.slice(0, lastSpace) : cut).trimEnd() + '\u2026';
}

// ---------------------------------------------------------------------------
// Feed parsing
// ---------------------------------------------------------------------------

/**
 * Pulls the inner text of the first <tag> in `xml`.
 * Handles CDATA and self-closing tags, and ignores namespace prefixes when
 * `anyNs` is set (Atom feeds vary wildly on prefixes).
 */
function tagText(xml, tag, { anyNs = false } = {}) {
  const name = anyNs ? `(?:[a-z0-9]+:)?${tag}` : tag;
  const re = new RegExp(`<${name}(?:\\s[^>]*)?>([\\s\\S]*?)<\\/${name}>`, 'i');
  const m = xml.match(re);
  if (!m) return '';
  const raw = m[1];
  const cdata = raw.match(/<!\[CDATA\[([\s\S]*?)\]\]>/);
  return (cdata ? cdata[1] : raw).trim();
}

/** Reads an attribute off the first matching tag. */
function tagAttr(xml, tag, attr, { where = null } = {}) {
  const re = new RegExp(`<(?:[a-z0-9]+:)?${tag}\\b([^>]*)>`, 'gi');
  let m;
  while ((m = re.exec(xml))) {
    const attrs = m[1];
    if (where && !where(attrs)) continue;
    const a = attrs.match(new RegExp(`${attr}\\s*=\\s*["']([^"']*)["']`, 'i'));
    if (a) return a[1].trim();
  }
  return '';
}

/**
 * Parses an RSS 2.0, RDF/RSS 1.0 or Atom document into normalised items.
 *
 * Returns [] rather than throwing on malformed input: one broken feed among
 * sixty must never take down the whole issue.
 */
function parseFeed(xml) {
  if (!xml || typeof xml !== 'string') return [];

  const blocks = [];
  const itemRe = /<(item|entry)\b[^>]*>([\s\S]*?)<\/\1>/gi;
  let m;
  while ((m = itemRe.exec(xml))) blocks.push(m[2]);

  const items = [];
  for (const b of blocks) {
    const title = stripHtml(tagText(b, 'title', { anyNs: true }));

    // Link: RSS puts it in <link>text</link>; Atom uses <link href="..."/>,
    // preferring rel="alternate" when several are present.
    let link = stripHtml(tagText(b, 'link'));
    if (!link || /^\s*$/.test(link)) {
      link =
        tagAttr(b, 'link', 'href', { where: (a) => /rel\s*=\s*["']?alternate/i.test(a) }) ||
        tagAttr(b, 'link', 'href', { where: (a) => !/rel\s*=/i.test(a) }) ||
        tagAttr(b, 'link', 'href');
    }
    if (!link) link = stripHtml(tagText(b, 'guid'));
    link = decodeEntities(link).trim();

    const dateRaw =
      tagText(b, 'pubDate') ||
      tagText(b, 'published', { anyNs: true }) ||
      tagText(b, 'updated', { anyNs: true }) ||
      tagText(b, 'date', { anyNs: true }) ||
      tagText(b, 'modified', { anyNs: true });

    const summaryRaw =
      tagText(b, 'description') ||
      tagText(b, 'summary', { anyNs: true }) ||
      tagText(b, 'encoded', { anyNs: true }) ||
      tagText(b, 'content', { anyNs: true });

    let author =
      stripHtml(tagText(b, 'creator', { anyNs: true })) ||
      stripHtml(tagText(b, 'author', { anyNs: true }));
    // Atom wraps the name: <author><name>X</name></author>
    const nameInAuthor = author && tagText(author, 'name');
    if (nameInAuthor) author = stripHtml(nameInAuthor);
    author = author.replace(/<[^>]*>/g, '').trim();

    if (!title || !link) continue;
    if (!/^https?:\/\//i.test(link)) continue;

    items.push({
      title,
      link,
      published: normaliseDate(dateRaw),
      summary: truncate(stripHtml(summaryRaw), 400),
      author: author || null,
    });
  }
  return items;
}

/** Normalises a feed date to ISO, or null when absent/unparseable. */
function normaliseDate(raw) {
  if (!raw) return null;
  const cleaned = stripHtml(raw);
  if (!cleaned) return null;
  const t = Date.parse(cleaned);
  if (Number.isNaN(t)) return null;
  return new Date(t).toISOString();
}

// ---------------------------------------------------------------------------
// Candidate selection
// ---------------------------------------------------------------------------

/** Normalises a URL for comparison: no trailing slash, no tracking params. */
function canonicalUrl(url) {
  if (!url) return '';
  let s = String(url).trim();
  try {
    const u = new URL(s);
    u.hash = '';
    for (const p of [...u.searchParams.keys()]) {
      if (/^(utm_|fbclid|gclid|mc_cid|mc_eid|ref|source)/i.test(p)) {
        u.searchParams.delete(p);
      }
    }
    s = u.toString();
  } catch {
    /* not a parseable URL; fall through to string handling */
  }
  return s.replace(/\/+$/, '').toLowerCase();
}

function normaliseTitle(t) {
  return String(t || '')
    .toLowerCase()
    .replace(/[\u2018\u2019\u201C\u201D]/g, "'")
    .replace(/[^a-z0-9']+/g, ' ')
    .trim();
}

/**
 * Filters raw per-source items into eligible candidates.
 *
 * Drops, in order: undated items when `requireDate`, anything outside the
 * freshness window, anything already published (by URL or by title), and
 * anything from a source that has hit its rotation cap. Returns candidates
 * plus a tally of why things were dropped — the tally exists so a thin
 * issue can be diagnosed from the log without rerunning anything.
 */
function selectCandidates({
  bySource,
  now,
  windowDays = 21,
  seenUrls = new Set(),
  seenTitles = new Set(),
  rotationCounts = {},
  rotationMax = 2,
  requireDate = true,
  maxPerSource = 3,
}) {
  const nowMs = typeof now === 'number' ? now : new Date(now).getTime();
  const cutoff = nowMs - windowDays * 86400000;
  const dropped = { undated: 0, stale: 0, future: 0, duplicate: 0, rested: 0, capped: 0 };
  const out = [];

  for (const entry of bySource) {
    const { source, category, items } = entry;

    const used = rotationCounts[category]?.[source.toLowerCase()] || 0;
    if (used >= rotationMax) {
      dropped.rested += (items || []).length;
      continue;
    }

    let takenFromSource = 0;
    const fresh = (items || [])
      .slice()
      .sort((a, b) => (b.published || '').localeCompare(a.published || ''));

    for (const it of fresh) {
      if (!it.published) {
        if (requireDate) {
          dropped.undated++;
          continue;
        }
      } else {
        const t = Date.parse(it.published);
        // Tolerate an hour of clock skew before calling something future-dated.
        if (t > nowMs + 3600000) {
          dropped.future++;
          continue;
        }
        if (t < cutoff) {
          dropped.stale++;
          continue;
        }
      }

      if (seenUrls.has(canonicalUrl(it.link)) || seenTitles.has(normaliseTitle(it.title))) {
        dropped.duplicate++;
        continue;
      }

      if (takenFromSource >= maxPerSource) {
        dropped.capped++;
        continue;
      }

      takenFromSource++;
      out.push({
        title: it.title,
        url: it.link,
        source,
        category,
        author: it.author,
        published: it.published,
        summary: it.summary,
      });
    }
  }

  return { candidates: out, dropped };
}

/** Groups candidates by category, newest first, capped for prompt size. */
function groupForPrompt(candidates, { maxPerCategory = 40 } = {}) {
  const byCat = {};
  for (const c of candidates) {
    (byCat[c.category] = byCat[c.category] || []).push(c);
  }
  for (const k of Object.keys(byCat)) {
    byCat[k].sort((a, b) => (b.published || '').localeCompare(a.published || ''));
    byCat[k] = byCat[k].slice(0, maxPerCategory);
  }
  return byCat;
}

/** Reads prior URLs/titles and rotation counts out of published issues. */
function historyFromIssues(issues, { rotationWindow = 4 } = {}) {
  const seenUrls = new Set();
  const seenTitles = new Set();
  const rotationCounts = {};

  const ordered = issues.slice().sort((a, b) => (a.issue || 0) - (b.issue || 0));
  for (const issue of ordered) {
    for (const c of issue.categories || []) {
      for (const e of c.entries || []) {
        if (e.url) seenUrls.add(canonicalUrl(e.url));
        if (e.title) seenTitles.add(normaliseTitle(e.title));
      }
    }
  }

  for (const issue of ordered.slice(-rotationWindow)) {
    for (const c of issue.categories || []) {
      const key = c.key;
      rotationCounts[key] = rotationCounts[key] || {};
      for (const e of c.entries || []) {
        const s = String(e.source || '').trim().toLowerCase();
        if (!s) continue;
        rotationCounts[key][s] = (rotationCounts[key][s] || 0) + 1;
      }
    }
  }

  return { seenUrls, seenTitles, rotationCounts };
}

module.exports = {
  decodeEntities,
  stripHtml,
  truncate,
  parseFeed,
  normaliseDate,
  canonicalUrl,
  normaliseTitle,
  selectCandidates,
  groupForPrompt,
  historyFromIssues,
};
