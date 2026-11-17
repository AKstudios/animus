---
size: medium
difficulty: hard
type: backend
---
# Pull requests open without conflicts with their base

## Problem

A job works from the base branch as it was when the job started. If the base
moves while the job runs, the pull request can open with conflicts, or with
code that no longer works against the new base, and the person finds out only
when they come to merge.

## Solution

Before the push, the job catches up with its base. A clean merge is checked
again by the gates; a conflict is resolved by a fresh session and checked the
same way. What the factory cannot settle comes back to the person as a
question, and the job carries on from their answer.

## Acceptance criteria

1. When the base gained commits during the job and they merge without
   conflict, the job merges them into its branch before the push, runs every
   gate again (acceptance checks included), and the pull request names the
   base commit it caught up to. When the base did not move, nothing is merged
   and no gate runs again.
   $ sh scripts/with-tmp.sh node --disable-warning=ExperimentalWarning --test plugin/test/catch-up.test.ts
2. When the merge is clean but a gate fails afterwards (the base renamed
   something the job's code uses), the failure goes to the implementer with
   the usual two fix rounds, and the pull request opens once the gates pass.
   $ sh scripts/with-tmp.sh node --disable-warning=ExperimentalWarning --test plugin/test/catch-up.test.ts
3. When the merge conflicts, a fresh implementer session gets the conflicting
   files, the spec and the base's commits that touched those files, and
   resolves them. The job goes on only with no conflict markers left and
   every gate green within two fix rounds, and the pull request lists the
   files whose conflicts the agent resolved.
   $ sh scripts/with-tmp.sh node --disable-warning=ExperimentalWarning --test plugin/test/catch-up.test.ts
4. When that session says it cannot resolve a conflict, or the gates still
   fail after the fix rounds, the job ends as needs input with the
   conflicting files and what it could not decide. `animus resume <job>
   --answer "…"` continues from the catch-up with the answer, not from the
   start.
   $ sh scripts/with-tmp.sh node --disable-warning=ExperimentalWarning --test plugin/test/catch-up.test.ts
5. A conflict in a protected path of the profile ends the job as needs input
   with that path, whatever the session would have done.
   $ sh scripts/with-tmp.sh node --disable-warning=ExperimentalWarning --test plugin/test/catch-up.test.ts
6. docs/factory.md's pipeline and docs/workflow.md show the catch-up step
   between the review and opening the pull request.

## Decisions

- The catch-up is a script step after the review passes and before the push:
  fetch the base, merge it with one merge commit (no rebase: a sliced job's
  many commits would each meet the same conflict). GitHub squashes the pull
  request, so the merge commit does not reach the base's history.
- The script decides whether a resolution holds (no markers, gates green);
  the agent only resolves and may say it cannot.
- No second review after a resolution: the gates prove it, and the pull
  request names the resolved files for the person's review.
- A draft pull request on failure is opened after the same catch-up, so it too
  opens without conflicts where the merge is clean.
- Tests use the pipeline's fake agent in plugin/test/helpers.ts, with the
  base moved in the test's origin while the job runs.
- Term in GLOSSARY.md: catch-up.

## Out of scope

- Keeping a pull request current after it has opened.
- Resolving conflicts with a second reviewer.
