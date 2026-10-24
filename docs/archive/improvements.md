# Algorithm — improvements & fixes

Running list. Mike adds notes in conversation; Claude maintains this file.
Newest at the top of each section. Move items to **Done** rather than deleting,
so the reasoning stays visible.

---

## Open

### Waiting on Mike

- **Dedicated website.** Google Sites was ruled out — its API is deprecated and
  covers classic Sites only, so there is no way to publish to it from a script;
  it would mean pasting each issue in by hand. Recommendation is a custom domain
  pointed at the existing GitHub Pages site. Nothing to build until Mike picks a
  domain.

### Editorial

- **Menswear and design still skew Western.** Four outlets added 30 Aug (Vestoj,
  SSENSE Editorial, Diary of a Wimpy Critic, Dazed Fashion) widen the pool from
  six to ten, and one of them writes from Tokyo — but the structural finding
  from three research passes stands.
- **Latin America is thin.** The English-only rule correctly excludes most
  strong regional criticism, which is Spanish- or Portuguese-only.
- **Issue No. 3 fails the new rotation rules retroactively** — both its fashion
  picks were Highsnobiety. It is already published and has been left alone. The
  validator only checks the day's new file, so it will not block future runs.

### Sources to verify by hand

Good publications that block automated fetching, so the workflow can't cite them:

- Die Workwear (Derek Guy) — probably the best menswear criticism in English
- Business of Fashion — menswear opinion strand; needs a subscription login
- Bubblegum Club (South Africa) — best African fashion-criticism lead; JS-gated
- Pitchfork — blocks fetch
- Cinema Scope (Canada) — JS-gated

### Automation

- **The first real end-to-end test is Mon 31 Aug, 4:17am Pacific.** Everything
  was verified locally — including the git race, against a bare-repo harness —
  but no run has yet exercised the new workflow on GitHub. A same-day manual
  dispatch proves nothing: it hits the new "already exists" skip and exits in
  ten seconds without touching the changed steps. To test sooner, dispatch with
  `date = 2026-08-31`, which composes Monday's issue early; the scheduled run
  then correctly skips.
- **Watch the first few Sonnet issues for quality.** The model changed at the
  same time as the rotation rules tightened, so if quality dips it will not be
  obvious which change caused it. Revert lever is one line: `--model` in
  `.github/workflows/daily-issue.yml`.
- **A validation failure still costs a full research run.** The catch-up slot
  softens this — it re-attempts the same day — but nothing yet retries within a
  single run.

---

## Done

- **30 Aug 2026 — changeset applied to main.** Four commits (`2100b2b`,
  `6b8e611`, `0f15d79`, `babfd7e`), walked in through Mike's browser via
  GitHub's upload UI, since the Cowork sandbox still cannot push. Verified by
  re-cloning: all twelve files byte-match the local build, every script parses,
  `build.js` reproduces the site byte-identically from the committed state, and
  the live GitHub Pages site now renders seven sections with no Pulse.
  **Technique worth reusing:** `file_upload` only accepts paths under
  `/mnt/user-data/outputs`, not the working directory — stage files there first.
  Uploading to `/upload/main/<subdir>` lands files in that subdirectory, which
  sidesteps the hidden-`.github`-folder problem entirely.
- **30 Aug 2026 — found why the schedule "never ran".** It did run. Scheduled
  runs fired and were thrown away at the last line. Full diagnosis in
  build-notes.md. Fixed with a rebuild-and-retry publish loop.
- **30 Aug 2026 — cut per-issue cost.** Moved to Mon/Wed/Fri/Sat (7 runs a week
  to 4) and from Opus to Sonnet 5. Roughly 43% fewer runs, and a much cheaper
  model on each.
- **30 Aug 2026 — fixed source concentration.** Highsnobiety had taken 4 of 6
  menswear slots (both on 30 Aug) and Bandcamp Daily 2 of 6 music slots, because
  every concentration rule only ever looked inside a single issue. Added a
  rolling-window rotation rule, a hard error on both picks in a category sharing
  an outlet, and `scripts/recent-sources.js`, which tells the composing prompt
  by name which publications to rest.
- **30 Aug 2026 — retired The Pulse.** Removed from the prompt, builder,
  validator and PR body. It never had a real data source. Removing it from the
  builder retires it from the archive too, not just the front page.
- **28 Aug 2026** — Issue No. 1 published. 14 entries, 14 distinct publications,
  zero unlinked, spread across 8 countries.
- **28 Aug 2026** — Fixed `find issues` failing under `set -euo pipefail` on a
  fresh repo (`mkdir -p issues`), and `validate.js` crashing rather than erroring
  cleanly on a missing `issues/` directory.
