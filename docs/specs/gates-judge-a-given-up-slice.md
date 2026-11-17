---
size: small
difficulty: routine
type: bug
---
# The gates, not the implementer, decide that work failed

## Problem

When an implementer reports `failed` because it could not show its own work
passes, the job ends at once as a draft pull request, without the gates ever
running. A job stopped this way on work whose tests all passed: the
implementer's own test run had hung, and it gave up. When that job was
resumed and finished, it updated the draft pull request but left it a draft,
so a finished job looked unfinished.

## Solution

An implementer that gives up after changing code is checked by the gates like
any other, and its note goes with the work. A job's pull request ends as a
draft only when the job failed: one that finishes is marked ready for review,
including a draft left by an earlier failed attempt.

## Acceptance criteria

1. When the implementer reports `failed` but the job's branch has changes
   from that session, the gates run. If they pass, the job goes on (the next
   slice, then review and the pull request), and the implementer's notes are
   in the pull request. If they fail, the failure goes back to the
   implementer with the usual fix rounds, and the job ends as failed only if
   the gates still fail after them. An implementer that reports `failed`
   having changed nothing ends the job as now.
   $ sh scripts/with-tmp.sh node --disable-warning=ExperimentalWarning --test plugin/test/given-up.test.ts
2. When a job ends in a pull request and its branch already has a draft pull
   request open, that pull request is updated and marked ready for review.
   When a job ends as failed and its pull request is open and ready, it is
   updated and turned back into a draft.
   $ sh scripts/with-tmp.sh node --disable-warning=ExperimentalWarning --test plugin/test/publish.test.ts

## Decisions

- Scripts decide routing: an implementer's `failed` is a claim, and the gates
  check it whenever there is work to check. `needs-input` is unchanged: a
  question still stops the job.
- "Changes from that session" is the branch's head differing from where the
  session started, counting what the factory commits for it at the end.
- The first criterion is tested through the pipeline with the fake agent in
  plugin/test/helpers.ts; the second through `publish` with a fake `gh` on
  PATH that records its calls.

## Out of scope

- Telling the implementer how to run the tests without hanging.
