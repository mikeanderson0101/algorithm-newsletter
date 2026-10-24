# Algorithm — how the automation is built

Written 25 Aug 2026. **Live since 28 Aug 2026.** Substantially revised 30 Aug.
Read this before changing how issues are produced.

**Live site:** https://mikeanderson0101.github.io/algorithm-newsletter/
**Repo:** github.com/mikeanderson0101/algorithm-newsletter

## Architecture, and why

A GitHub Action runs on publishing days in the repo. It does **not** run in a
Cowork session — Cowork sessions are ephemeral, so anything depending on one
cannot run unattended.

The critical split:

- **Claude writes exactly one file:** `issues/YYYY-MM-DD.json`
- **`scripts/build.js` renders every byte of HTML** from all issue JSONs

This is deliberate. If the model regenerated HTML daily, the design would drift
and the archive and search index would fall out of sync. Instead the whole site
is a pure function of `issues/*.json`, rebuildable at any time. That property is
not just tidiness — the publish retry loop below depends on it.

Claude's allowed tools in the workflow are deliberately narrow:
`WebSearch, WebFetch, Read, Write, Glob, Grep`. No Bash, no git.

## Schedule and model (as of 30 Aug 2026)

- **Mon / Wed / Fri / Sat**, two slots per day:
  `17 11 * * 1,3,5,6` (4:17am Pacific) and `47 15 * * 1,3,5,6` (8:47am Pacific).
- **Model: `claude-sonnet-5`**, set via `--model` in `claude_args`.

The second slot is a catch-up, not a second issue. If the morning run already
published, the meta step finds the issue file and exits **successfully** in about
ten seconds. It exists because GitHub genuinely drops scheduled runs under load —
30 Aug 2026 produced no scheduled run at all — and because it doubles as a free
retry when a run fails validation.

An existing issue file is a successful no-op, not an error. It used to `exit 1`,
which filled the Actions log with red runs that were working as designed.

## The "it never runs on schedule" bug — diagnosed 30 Aug 2026

**The schedule was always firing. The runs were being thrown away at the last
line.** Do not go looking for cron problems again.

Evidence, from the Actions run list:

| Run | Trigger | Result |
|---|---|---|
| #4 | Scheduled | cancelled |
| #6 | Scheduled | **failed after 9m 28s** |
| #9 | Manual | failed (issue already existed) |

Run #6's log, at step 7 (Publish):

```
[main d1fd527] Issue No. 2 — 2026-08-29
 5 files changed, 712 insertions(+), 50 deletions(-)
! [rejected] HEAD -> main (fetch first)
error: failed to push some refs
hint: Updates were rejected because the remote contains work that you do not
      have locally.
```

The mechanism: `actions/checkout` pins main at the moment the run starts, then
research takes about ten minutes. Anything landing on main in that window — a
manual run, one of Mike's workflow edits, a queued run — made the single
`git push` non-fast-forward. A fully composed, validated, built issue was
discarded at the final command, having already spent the money.

From outside it looks exactly like "the schedule doesn't work": no issue appears,
and the only runs that ever succeed are the manual ones Mike does at a quiet
moment when nothing else is touching main.

**The fix** is a loop in the Publish step. Each attempt (five, with backoff):

1. `git fetch origin main` and `git reset --hard origin/main`
2. bail out successfully if the issue file is already there
3. copy back the one JSON the model wrote, parked in `$RUNNER_TEMP`
4. `node scripts/build.js` — regenerate everything on top of current main
5. commit and push

Because the site is a pure function of `issues/*.json`, rebuilding after moving
to the new tip is always correct and **no merge conflict is possible**. Verified
against a local bare-repo harness that reproduces the original rejection and then
recovers: the concurrent issue survived, ours was added, all archive pages and
the search index rebuilt correctly.

## Source concentration — fixed 30 Aug 2026

Across issues 1-3, Highsnobiety took **4 of 6** menswear slots (both picks on
30 Aug) and Bandcamp Daily **2 of 6** music slots. Blackbird Spyplane took the
other two menswear slots, so the entire section came from two outlets.

Every rule passed, because **every concentration rule only ever looked inside a
single issue.** Nothing in the system could see yesterday. Three changes:

1. **Rolling window** — a publication may hold a category in at most 2 of any 4
   consecutive issues. Hard error.
2. **Both picks in one category from one outlet** — was a warning, which is
   exactly how 30 Aug shipped two Highsnobiety entries. Now a hard error.
3. **`scripts/recent-sources.js`** — prints recently-used publications per
   category, injected into the prompt as a "rest these today" list.

Point 3 matters most. Rules alone only fail the build after the money is spent;
a model told "do not over-concentrate", with no memory of yesterday, reaches for
the same obvious outlet every time. Naming the outlets is the actual lever.

Menswear also went from six usable outlets to ten (Vestoj, SSENSE Editorial,
Diary of a Wimpy Critic, Dazed Fashion — each fetched and confirmed carrying
2026-dated criticism), because a rotation rule over six sources in the thinnest
category on the list would just fail the build.

## The Pulse — retired 30 Aug 2026

Removed from the prompt, `build.js`, `validate.js` and `pr-body.js`. It never had
a real data source; live social trends aren't reachable from the research tools,
so it was inference presented as observation.

Removing it from the *builder* rather than from the issue files retires it from
the archive as well as the front page, on the next build. Old `pulse` keys in
issue JSONs are harmless history and are simply ignored.

## The validator exists because of specific real failures

| Failure | Guard |
|---|---|
| Summary written from a headline without reading the article | `verified: true` required per entry |
| Articles repeated from the sample template | Dedupe against `assets/search-index.json` by URL and title |
| Both picks in 5 of 7 categories from one publication | Max 2 entries per publication per issue |
| Both picks in one category from one publication (30 Aug) | Hard error per category |
| The same outlet every issue (issues 1-3) | Rolling-window rotation, 2 in any 4 |
| URLs guessed from site naming patterns | URLs must be absolute http(s), placeholders rejected |

## Setup friction worth remembering

- **`.github` is a hidden folder.** Mike's first upload silently dropped it (and
  `.gitignore`, and `issues/.gitkeep`). Fix: GitHub's *Create new file* with the
  full path `.github/workflows/daily-issue.yml` typed in — slashes create folders.
  Or edit the existing file in place and paste.
- **GitHub sidebar dropdowns.** "Secrets and variables" and "Actions" are
  collapsed menus with a `⌄` chevron, not links. Always give direct URLs
  (`/settings/secrets/actions`, `/settings/actions`).
- **Setup guide artifact:** https://claude.ai/code/artifact/887dc226-d648-464a-8afc-457964e68dd1

## Working on this from Cowork

- **Cannot push.** The sandbox routes git through a proxy with a session-fixed
  repository allowlist; no user-facing setting changes it. Hand over a zip, or
  work from a session that already has the repo authorised.
- **Read access works.** `git clone` of the public repo succeeds — that is how
  the generated branch and the source-concentration analysis were audited.
- **`curl` to arbitrary hosts is blocked; use WebFetch.** The GitHub REST API
  returns 403 through WebFetch, so run history had to be read through Mike's
  browser (Claude in Chrome) on the Actions pages. That worked well and is the
  route to use next time a run needs diagnosing.

## Hosting

Google Sites was considered and ruled out: its API is **deprecated and covers
classic Sites only**, with no public API for the current product. There is no way
to publish to it from a script, so it would mean pasting every issue in by hand
and abandoning the automation. GitHub Pages plus a custom domain keeps the whole
pipeline and changes only what the address bar says.
