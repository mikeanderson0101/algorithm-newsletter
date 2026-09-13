#!/usr/bin/env node
/**
 * Algorithm — finalizes a draft issue into its permanent, numbered file.
 *
 * The issue number is deliberately NOT assigned when composing begins.
 * Composing takes about ten minutes, and any number decided that far ahead
 * is stale by the time the file is actually committed — which is exactly
 * what broke publishing after the retry-loop fix on 2 Sept 2026: the safety
 * check meant to detect "another run already published this" tested
 * whether issues/<DATE>.json existed on the local filesystem, but that file
 * is the run's OWN freshly-written draft, sitting there untracked. `git
 * reset --hard` never removes untracked files, so the check found its own
 * draft on every single attempt and concluded — wrongly, every time — that
 * someone else had already published, and quietly exited without ever
 * committing.
 *
 * The fix is to stop keying anything on the filesystem at all. The draft is
 * written under a fixed staging name (issues/_draft.json) with a
 * placeholder issue number that is never trusted. This script assigns the
 * REAL number and writes the real file — but only from inside the retry
 * loop in the Publish step, immediately after that attempt's own fresh
 * `git fetch` + `git reset --hard origin/main`, so the count it's based on
 * is whatever is actually on `main` at that exact moment. If two runs still
 * race, `git push` itself rejects the loser as a non-fast-forward push,
 * which is the one check that can't produce a false positive — and the
 * loop simply recomputes a fresh number and tries again.
 *
 * This also removes the old one-issue-per-calendar-date constraint
 * entirely: uniqueness now comes from the issue number, not the date, so
 * multiple issues on the same day are unremarkable and require no special
 * handling anywhere in this pipeline.
 *
 * Usage: node scripts/finalize-issue.js <draftPath> <issueNumber> <outPath>
 */

const fs = require('fs');

const [, , draftPath, issueNumberStr, outPath] = process.argv;

if (!draftPath || !issueNumberStr || !outPath) {
  console.error('Usage: node scripts/finalize-issue.js <draftPath> <issueNumber> <outPath>');
  process.exit(1);
}

const issueNumber = Number(issueNumberStr);
if (!Number.isInteger(issueNumber) || issueNumber < 1) {
  console.error(`Invalid issue number: ${issueNumberStr}`);
  process.exit(1);
}

const issue = JSON.parse(fs.readFileSync(draftPath, 'utf8'));
issue.issue = issueNumber;
fs.writeFileSync(outPath, JSON.stringify(issue, null, 2) + '\n');
console.log(`${outPath}: Issue No. ${issueNumber} (${issue.date})`);
