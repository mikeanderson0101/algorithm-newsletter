# Algorithm

A daily culture newsletter. Fourteen pieces of long-form criticism a day — two
each across fine art, film, tech & AI, literary reviews, music, design and
menswear — drawn from around 110 publications on six continents.

Live at **https://mikeanderson0101.github.io/algorithm-newsletter/**

## How it works

Every morning at 11:17 UTC a GitHub Action researches the day's issue and opens
a pull request. Nothing goes live until you merge it.

```
.github/workflows/daily-issue.yml   the schedule and the prompt
sources.md                          the curated source list
issues/YYYY-MM-DD.json              one file per issue — the only thing Claude writes
scripts/validate.js                 fails the build on repeats, fabrication, thin curation
scripts/build.js                    renders ALL the HTML — the design lives here
scripts/pr-body.js                  renders the PR summary
index.html, archive/, assets/       generated output; never edit by hand
```

The split matters. Claude writes **only** a JSON file of the day's picks. Every
piece of HTML is rendered deterministically by `build.js`, so the design cannot
drift, the archive and search index can never fall out of sync, and the whole
site can be rebuilt from `issues/*.json` at any time.

## What the validator enforces

These checks came out of real failures in the first hand-made draft, which
shipped two articles duplicated from a sample template and one summary written
from a headline without reading the article. The build fails on:

- an entry not marked `verified: true` — set only after fetching and reading the article
- any article already present in `assets/search-index.json`
- a malformed or placeholder URL (guards against URLs invented from naming patterns)
- a category with anything other than exactly 2 entries, or a missing category
- more than 2 entries from the same publication in one issue

Warnings (which don't fail the build) cover headline length, summary length, and
both picks in a category sharing a source.

## Setup

**1. Add your API key.** Settings → Secrets and variables → Actions → New
repository secret, named `ANTHROPIC_API_KEY`. Get one at
[platform.claude.com](https://platform.claude.com).

To use a Claude subscription instead of API billing, run `claude setup-token`
locally, store the result as `CLAUDE_CODE_OAUTH_TOKEN`, and swap that line in
the workflow for `claude_code_oauth_token: ${{ secrets.CLAUDE_CODE_OAUTH_TOKEN }}`.

**2. Turn on Pages.** Settings → Pages → Source: *Deploy from a branch* →
Branch `main`, folder `/ (root)` → Save.

**3. Run it once.** Actions → Daily Issue → *Run workflow*. That produces the
first issue as a PR. Merge it and the site goes live.

## Day to day

A PR appears each morning titled `Issue No. N — YYYY-MM-DD`. The body lists every
pick with its link and publication, flags any entry that has no verified link,
and notes any publication used twice. Skim it, then merge to publish.

To reject a pick, edit `issues/YYYY-MM-DD.json` on the branch and delete or
replace the entry — CI re-runs validation and rebuilds the HTML automatically.

To skip a day, just close the PR.

## Switching to auto-publish

Once you trust it, replace the last step of the workflow with a direct commit to
`main`:

```yaml
      - name: Publish
        run: |
          git config user.name  "algorithm-bot"
          git config user.email "41898282+github-actions[bot]@users.noreply.github.com"
          git add -A
          git commit -m "Issue No. ${{ steps.meta.outputs.issue }} — ${{ steps.meta.outputs.date }}"
          git push
```

Validation still runs first, so a bad issue fails rather than publishing.

## Rebuilding by hand

```bash
node scripts/validate.js      # check every issue
node scripts/build.js         # regenerate the whole site
```

Both need only Node — no dependencies, no install step.

## Known limitations

**The Pulse section has no reliable source.** Live social platform trends aren't
reachable from the research tools, so that section is the weakest part of the
format and is written conservatively. It's worth reconsidering or wiring to a
real feed.

**Design and menswear skew Western.** Three research passes confirmed that
dedicated criticism outlets in those fields barely exist outside the UK, US and
Europe. That's the media landscape, not a gap in the source list.

**Some strong publications block automated access** — Pitchfork, Die Workwear,
Business of Fashion, Cinema Scope. They're marked `UNVERIFIED` in `sources.md`
and won't be cited unless checked manually.
