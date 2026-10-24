#!/usr/bin/env node
/**
 * Algorithm — turning an article page into readable text. PURE FUNCTIONS.
 *
 * This is what lets a cheap model actually read a piece: the page is fetched
 * in code (free), cut down to the article body here (free), and only then
 * sent to the model. A raw page is mostly navigation, scripts and ads; the
 * body of a 2,000-word essay is about 3K tokens.
 *
 * It also answers three questions for nothing, before any model is paid:
 * is there enough text to be a real piece, is it in English, and does it
 * look like a paywall teaser.
 */

'use strict';

const L = require('./feed-lib.js');

const DROP_BLOCKS = ['script', 'style', 'noscript', 'svg', 'nav', 'header', 'footer', 'aside', 'form', 'figure', 'button', 'select'];

function dropBlocks(html, { keep = [] } = {}) {
  let s = String(html || '');
  for (const tag of DROP_BLOCKS.filter((t) => !keep.includes(t))) {
    s = s.replace(new RegExp(`<${tag}\\b[\\s\\S]*?<\\/${tag}>`, 'gi'), ' ');
  }
  return s.replace(/<!--[\s\S]*?-->/g, ' ');
}

/** Every <tag>...</tag> region's inner HTML, outermost first. */
function regions(html, tag) {
  const out = [];
  const re = new RegExp(`<${tag}\\b[^>]*>([\\s\\S]*?)<\\/${tag}>`, 'gi');
  let m;
  while ((m = re.exec(html))) out.push(m[1]);
  return out;
}

/**
 * Inlines the links New Music needs as plain-text markers, so they survive
 * tag stripping and the extractor can attach them to the right song:
 * "Song Title (youtube:abc123)" or "(bandcamp:https://x.bandcamp.com/track/y)".
 */
function inlineMediaLinks(html) {
  // Embeds become their own short paragraph, carrying the player's title —
  // usually the song name — so the marker survives paragraph extraction.
  // Stereogum's five weekly songs are all embeds inside <figure> blocks.
  return String(html || '')
    .replace(/<iframe\b([^>]*)src=["'][^"']*youtube(?:-nocookie)?\.com\/embed\/([\w-]{6,})[^"']*["']([^>]*)>/gi, (whole, before, id, after) => {
      const title = (`${before} ${after}`.match(/title=["']([^"']*)["']/i) || [])[1] || '';
      return `<p>Embedded video: "${title}" (youtube:${id})</p>`;
    })
    .replace(/<a\b[^>]*href=["']([^"']+)["'][^>]*>([\s\S]*?)<\/a>/gi, (whole, href, inner) => {
      const yt = href.match(/(?:youtube\.com\/watch\?v=|youtu\.be\/)([\w-]{6,})/i);
      if (yt) return `${inner} (youtube:${yt[1]})`;
      if (/^https?:\/\/[a-z0-9-]+\.bandcamp\.com\/(track|album)\//i.test(href)) {
        return `${inner} (bandcamp:${href.split(/[?#]/)[0]})`;
      }
      return inner;
    });
}

function paragraphsText(html) {
  const paras = regions(html, 'p')
    .concat(regions(html, 'h2'), regions(html, 'h3'), regions(html, 'li'))
    .map((p) => L.stripHtml(p))
    .filter((p) => p.split(/\s+/).length >= 4);
  return paras.join('\n\n');
}

/**
 * The article body as plain text. Prefers the largest <article>, then
 * <main>, then the whole body, measured by paragraph text actually found.
 */
function extractText(html, { media = false } = {}) {
  const s = media
    ? dropBlocks(inlineMediaLinks(html), { keep: ['figure'] })
    : dropBlocks(html);
  const candidates = [...regions(s, 'article'), ...regions(s, 'main')];
  let best = '';
  for (const c of candidates) {
    const t = paragraphsText(c);
    if (t.length > best.length) best = t;
  }
  if (best.split(/\s+/).length < 150) {
    const body = regions(s, 'body')[0] || s;
    const t = paragraphsText(body);
    if (t.length > best.length) best = t;
  }
  return best.trim();
}

function wordCount(text) {
  const t = String(text || '').trim();
  return t ? t.split(/\s+/).length : 0;
}

/** Trims to roughly `max` words on a paragraph boundary where possible. */
function capWords(text, max) {
  const words = String(text || '').split(/\s+/);
  if (words.length <= max) return String(text || '');
  const cut = words.slice(0, max).join(' ');
  const lastBreak = cut.lastIndexOf('\n\n');
  return (lastBreak > cut.length * 0.7 ? cut.slice(0, lastBreak) : cut) + '\n\n[…]';
}

const EN_STOPWORDS = new Set(
  'the and of to a in is that it for was on with as his her are be this by at from but not have they which you or an had were their has been its who will one would there what all so if more when'.split(' '),
);

/**
 * True when text reads as English. Counts common English function words;
 * real English prose runs at 30-45% of tokens, Spanish or Portuguese under
 * 8%. Short strings (a title alone) are given the benefit of the doubt.
 * Two Spanish-language pieces shipped in Issue 49 because nothing checked.
 */
function looksEnglish(text, { minWords = 25 } = {}) {
  const words = String(text || '').toLowerCase().match(/[a-zÀ-ɏ']+/g) || [];
  if (words.length < minWords) return true;
  const hits = words.filter((w) => EN_STOPWORDS.has(w)).length;
  return hits / words.length >= 0.15;
}

function declaredLanguage(html) {
  const m = String(html || '').match(/<html\b[^>]*\blang=["']?([a-z]{2})/i);
  return m ? m[1].toLowerCase() : null;
}

const PAYWALL_HINTS = /subscribe to (continue|read)|to continue reading|this (article|story) is for subscribers|subscribers only|already a subscriber|sign in to read|become a member to read/i;

function looksPaywalled(text) {
  return PAYWALL_HINTS.test(String(text || '').slice(-1500)) && wordCount(text) < 900;
}

module.exports = {
  extractText,
  inlineMediaLinks,
  wordCount,
  capWords,
  looksEnglish,
  declaredLanguage,
  looksPaywalled,
};
