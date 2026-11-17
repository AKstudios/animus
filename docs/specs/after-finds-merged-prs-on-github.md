---
size: small
difficulty: routine
type: backend
---
# after: sees a pull request merged from anywhere

## Problem

A spec's `after:` finds the earlier spec's pull request only in the run log
of whoever runs the job. A job on Helix that comes after a spec run on a
laptop (or by someone else) never finds it, so it waits forever, saying "no
job from it has opened a pull request yet" even when that pull request was
merged long ago. Helix job 1 on `animus` did exactly this and had to be
cancelled.

## Solution

When the run log has no pull request for the earlier spec, the job asks
GitHub for one, by the earlier spec's title, since a job's pull request is
titled after its spec. A merged one lets the job start; one closed unmerged
fails it, as now. While nothing is found anywhere, the job says where it
looked and how to stop waiting.

## Acceptance criteria

1. A spec whose `after:` names a spec with no job in the run log starts at
   once when GitHub has a merged pull request in the repo titled as that
   spec.
   $ sh scripts/with-tmp.sh node --disable-warning=ExperimentalWarning --test plugin/test/after.test.ts
2. When the pull request GitHub has for it was closed without merging, the
   job fails, naming that pull request, as it does for one in the run log.
   An open one keeps it waiting, saying which pull request it waits for.
   $ sh scripts/with-tmp.sh node --disable-warning=ExperimentalWarning --test plugin/test/after.test.ts
3. While neither the run log nor GitHub has a pull request for it, the job
   says it found none in either, names the title it looked for, and says
   that removing the `after:` line or cancelling the job ends the wait.
   $ sh scripts/with-tmp.sh node --disable-warning=ExperimentalWarning --test plugin/test/after.test.ts

## Decisions

- The run log is asked first, as now; GitHub only when it has no pull
  request for that spec file.
- The title is the earlier spec's `# ` heading, read from its file. GitHub
  is asked through `gh` in the repo (the person's own token, as every other
  `gh` call in a job), for pull requests in any state whose title is exactly
  that; of several, the newest counts.
- The GitHub lookup is a dependency of the wait, beside the existing pull
  request lookup, so tests pass a fake; no test reaches GitHub.
- Still checked every minute.

## Out of scope

- Refusing a Helix submission whose `after:` cannot be found.
- Matching pull requests by anything but their title.
