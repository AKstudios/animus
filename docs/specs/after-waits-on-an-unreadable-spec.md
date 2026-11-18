---
size: small
difficulty: routine
type: backend
---
# after: waits on an earlier spec it cannot read

## Problem

When a spec's `after:` names an earlier spec that the run log has no pull
request for, the job reads that spec's title to look for its pull request on
GitHub. If the file is there but is not a valid spec (a broken header, no
criteria), `loadSpec` throws and the job fails before it starts. A missing
file already keeps the job waiting, and before 0.4.5 an unreadable one did
too. The earlier spec being half-edited in someone's checkout should not
fail a job that only waits on it.

## Solution

An earlier spec that cannot be read is treated like a missing one: the job
keeps waiting and says why it has no title to look for, then reads the file
again on the next check, so fixing the file lets the wait find its pull
request.

## Acceptance criteria

1. A spec whose `after:` names a file that is not a valid spec, with no pull
   request for it in the run log, keeps waiting instead of failing, and its
   waiting line names the file and says it could not be read, with the
   reason `loadSpec` gave.
   $ sh scripts/with-tmp.sh node --disable-warning=ExperimentalWarning --test plugin/test/after.test.ts
2. Once that file becomes a valid spec while the job waits, the next check
   reads its title and the job starts when GitHub has a merged pull request
   titled as it.
   $ sh scripts/with-tmp.sh node --disable-warning=ExperimentalWarning --test plugin/test/after.test.ts
3. A pull request for that file in the run log still lets the job start
   without the file being read, as now.
   $ sh scripts/with-tmp.sh node --disable-warning=ExperimentalWarning --test plugin/test/after.test.ts

## Decisions

- Only `waitForMerged` in `plugin/src/after.ts` changes. A file that could
  not be read is read again on every check; a file read once stays read, as
  now.
- Only an `AnimusError` from `loadSpec` is caught; anything else still
  throws.
- The waiting line is printed again only when what it says changes, as now.
- Tests use the existing fakes for the run log, `lookup` and `find`, and
  write the broken spec file into the test's temporary folder.

## Out of scope

- Refusing a submission whose `after:` names an unreadable spec.
- `resolveAfter`, which only checks that the file exists.
