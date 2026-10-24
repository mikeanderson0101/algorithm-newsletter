# Troller: working agreement for Claude Code

Troller (formerly Algorithm) is a weekly digest of **links** to the best criticism and long-form writing across 7 categories (fine art, film, tech & AI, literary/SFF, music criticism, design, menswear), in a **News Troll** tab, plus a **Song Troll** tab of new songs picked from the weekly lists of sites that cover new music. Mike Anderson is the editor. Live at https://mikeanderson0101.github.io/algorithm-newsletter/

**Nothing is automated.** Mike refreshes it by hand, once or twice a week. There is no schedule, no GitHub Action composing issues, and there must not be one again.

**News Troll and Song Troll refresh separately.** `scout`/`publish` make the News Troll issue and never touch songs. Song Troll refreshes on its own with `node scripts/weekly.js songs` (about $0.01–0.05), or from the "Refresh Song Troll" button on its page, which opens `.github/workflows/song-troll.yml`: a **manual-only** (`workflow_dispatch`) run that uses the `ANTHROPIC_API_KEY` repo secret and pushes the new batch. Never add a `schedule:` to it.

## The history, because it explains every rule
- v1 (Aug 2026): one long agentic loop read every article. Quality was great; cost $9.53 an issue, because each article stayed in context and was re-read on every later turn (26.4M cached tokens).
- v2 (Sept–Oct 2026): RSS feeds plus one model call over headlines. Cheap, and the quality collapsed: nothing was read, 100 of 116 feeds are whole-site feeds, and issues shipped casino SEO, exchange-rate news, job ads, iPhone deals and Spanish-language pieces, twice a day, with `verified: true` set by code.
- v3 (now): `scripts/weekly.js`. Every finalist is read in full, but each read is its own small request, so nothing accumulates. About $0.40 per refresh with a hard $1 cap.

## Making an issue
1. `git pull`. Make sure `ANTHROPIC_API_KEY` is set (Mike sets it himself; never ask for or type a key).
2. `node scripts/weekly.js scout`. Takes a few minutes, mostly waiting on the Sonnet batch. Prints the spend.
3. Show Mike `.work/<date>/shortlist.md`. Ticked entries are the default picks (5 per category, 20 songs). To swap a pick, flip `"pick"` in `.work/<date>/shortlist.json`.
4. `node scripts/weekly.js publish`. Writes `issues/NNNN.json` and `music/NNNN.json`, validates, builds.
5. Summarise for Mike, and **only commit and push after he says yes.** Never force-push.

Useful flags: `--date YYYY-MM-DD`, `--per-category 5`, `--songs 20`, `--read-per-category 12`, `--check-per-category 6`, `--cap 1`, `--no-batch` (full price, no wait), `--categories design,fashion` with `--work <folder>` (rerun only thin sections), and for `songs`: `--songs 20`, `--taste '<json from Copy my thumbs>'`. A rerun reuses every finished stage in `.work/<date>/`, so it never pays twice; delete a stage's JSON there to redo it.

## How the cost stays under $1
- Feeds, date window, dedupe, rotation, junk titles, English and word count are all code: $0.
- Haiku 5.5 shortlists from titles, then reads each shortlisted article (cut to its body, max 3,000 words) and returns a verdict. No summaries are written.
- Sonnet 5.5 re-reads only the top ~6 per category, through the Batch API (half price), and scores 1–10.
- New Music: Haiku pulls songs out of ~9 list posts; Sonnet picks the batch from `music/taste.json`.
- `scripts/llm.js` prices every response from its `usage` and refuses to start a stage that would cross the cap.

Never move article reading into this Claude Code conversation (WebFetch/WebSearch in the main context). That is exactly the v1 cost failure.

## Design and titles
- The whole site uses the design of the original "Fresh this week" / Song Troll page: warm paper (#F1EEE9), Hanken Grotesk, one yellow highlight (#FFE500), big tight headings, square buttons. **Light only, no dark mode.** All of it lives in `scripts/build.js`.
- Tabs: **News Troll** (the issue), **Song Troll** (new music), Archive.
- Issues are titled plainly: "Issue N", week of the date. **No catchy, publication-style headlines**, ever. The old cover lines in early issue files are ignored by the builder.

## Architecture
- The site is a pure function of `issues/*.json` and `music/*.json`. `scripts/build.js` renders every byte of HTML, including the New Music tab (`music/index.html`). Never hand-edit generated HTML.
- `scripts/validate.js` enforces the rules. `assets/feeds.json` is the feed map (from `sources.md`); `assets/music-sources.json` lists the music list sources.
- `music/taste.json`: `exclude` (artists Mike already knows), `liked`/`disliked`. The New Music page's "Copy my thumbs" button produces the liked/disliked JSON to paste in.
- GitHub Pages deploys from `main`, root folder. Workflows: `audit-feeds.yml` (manual, model-free) and `song-troll.yml` (manual, the Song Troll button). Both are `workflow_dispatch` only.

## Editorial rules
0. **New writing about new things.** Only pieces mainly about new work (roughly the last three months: releases, shows, buildings, books, comics, collections, labels, typefaces). Old subjects only when pegged to something new. Both judges test this (`NEW_RULE` in `weekly.js`), and code drops anything with `about_new: false`.
   - Design is a wide net: architecture, interiors, industrial/product, graphic design and branding, typography.
   - Men's Fashion leans American and draws on many US sources.
   - Books lean hard toward SFF, plus smart writing on comics, manga and graphic novels.
1. English only, published in English by the outlet. Never translate.
2. Links only. Every published entry was fetched and read in full by the pipeline; `verified: true` means that.
3. Every URL comes from a feed or fetch. Never construct one.
4. No repeats (checked against every issue). Rotation: an outlet holds a category in at most 2 of any 4 weekly issues; max 2 entries per outlet per issue; never two in one category from one outlet.
5. Better a short category than padding. If a section comes up thin, fix its sources (section feeds over whole-site feeds; see `sources.md`), never the bar.
6. Tech & AI attracts SEO spam. The reader prompt rejects it; keep it that way.
7. The Pulse is retired. Ignore old `pulse` keys.

`docs/archive/` holds the old build notes and source-list research; read them before changing sources.
