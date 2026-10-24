# Troller

Formerly Algorithm. A weekly digest of links to the best criticism and long-form writing: five
pieces each across fine art, film, tech & AI, literary reviews, music, design
and menswear, from around 110 publications on six continents. Plus **Song
Troll**: new songs picked from the weekly lists of the sites that cover new
music full time.

Live at **https://mikeanderson0101.github.io/algorithm-newsletter/**

## How it works

Nothing runs on a schedule. The two tabs refresh separately, by hand.

**News Troll**, once or twice a week:

```bash
node scripts/weekly.js scout      # builds a shortlist, about $0.40, capped at $1
node scripts/weekly.js publish    # writes the issue, validates, builds
```

Then review, commit and push. GitHub Pages serves `main`.

**Song Troll**, whenever you like: press **Refresh Song Troll** on its page.
That opens a manual-only GitHub workflow (`song-troll.yml`); paste your
thumbs, press Run, and the new batch is published a few minutes later.
Locally, the same thing is `node scripts/weekly.js songs`.

`scout` fetches the feeds and filters them in code (dates, repeats, rotation,
junk titles, language, length). Claude Haiku 5.5 reads every shortlisted
article in full and gives a verdict; Claude Sonnet 5.5 re-reads the strongest
through the Batch API and scores them; the top five per category are picked.
No summaries are written. For Song Troll, Haiku pulls the songs out of each
site's weekly list post and Sonnet picks the batch using `music/taste.json`.

Each model request carries one article and nothing else, which is why this
costs cents rather than the $9.53 an issue the original agentic version did.

```
scripts/weekly.js         the pipeline (scout / publish)
scripts/llm.js            model calls and the cost ledger with its hard cap
scripts/page-text.js      article body extraction, English and paywall checks
scripts/feed-lib.js       feed parsing and candidate filtering (tested)
scripts/validate.js       fails on repeats, unread entries, rotation breaks
scripts/build.js          renders ALL the HTML, including the New Music tab
assets/feeds.json         the article feeds
assets/music-sources.json the music list sources
issues/NNNN.json          one file per issue
music/NNNN.json           one file per New Music batch; music/taste.json steers picks
```

## Setup

Needs Node 18+ and an Anthropic API key in `ANTHROPIC_API_KEY`.

```bash
npm install
```

## Rebuilding by hand

```bash
node scripts/validate.js      # check every issue
node scripts/build.js         # regenerate the whole site
node scripts/test-feed-lib.js # offline tests for feed parsing and filtering
```

## Known limitations

**Design and menswear skew Western.** Dedicated criticism outlets in those
fields barely exist outside the UK, US and Europe.

**Some strong publications block automated access**: Pitchfork, Die Workwear,
Business of Fashion, Cinema Scope. They are marked `UNVERIFIED` in
`sources.md`.
