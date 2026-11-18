---
size: medium
difficulty: routine
type: backend
---
# Helix starts a job when the machine and Claude have room for it

## Problem

Helix starts queued jobs while fewer than `slots` run, a number set by hand
in `config.yaml`. On abstergo (8 cores, 30 GB) two slots left job 6 queued
while the machine sat almost idle: jobs 4 and 5 used about 200 MB each,
since a job mostly waits on Claude. Raising `slots` by hand fixed that once,
but nothing stops Helix starting a job while `npm ci` and test runs already
have the machine short of memory, and nothing stops it running several
Opus-tier jobs at once against the same Claude account.

## Solution

`slots` stays as the most jobs that ever run at once. Before starting each
queued job, Helix checks two kinds of room, and a job that does not fit stays
queued with the reason shown wherever its state is shown:

- **The machine:** free memory must cover the job's memory (the container's
  `memory`, else `job_memory`) plus `reserve_memory`, and the 1-minute load
  average must be under the number of cores.
- **Claude:** at most `tier_limits.<tier>` jobs whose implementer runs on
  that tier at once (for example `deep: 1`).

The checks run again every 30 seconds and whenever a job ends. With no job
running, the first queued job starts whatever the machine reports, so a
small or busy machine never sits with an empty queue.

## Acceptance criteria

1. With fewer than `slots` running, a queued job stays queued when free
   memory is under its memory plus `reserve_memory`, or when the load average
   is at or above the core count, and starts on a later check once both fit.
   $ sh scripts/with-tmp.sh node --disable-warning=ExperimentalWarning --test helix/test/room.test.ts
2. A job whose implementer would run on a tier that already has
   `tier_limits` jobs running stays queued, while a later job on another
   tier that fits starts ahead of it.
   $ sh scripts/with-tmp.sh node --disable-warning=ExperimentalWarning --test helix/test/room.test.ts
3. A queued job held for room carries why, in plain words with the numbers
   (`waiting for memory: 3.1 GB free, needs 6 GB plus 2 GB kept free`,
   `waiting for the deep tier: 1 of 1 running`), in `animus status <id>` and
   in its queued entry in `GET /display`. The reason clears once it starts.
   $ sh scripts/with-tmp.sh node --disable-warning=ExperimentalWarning --test helix/test/room.test.ts helix/test/helix.test.ts
4. With nothing running, the first queued job starts even when the machine
   reports no room, and `slots` still caps how many run whatever the room.
   $ sh scripts/with-tmp.sh node --disable-warning=ExperimentalWarning --test helix/test/room.test.ts
5. `config.yaml` takes `reserve_memory` (default `2g`), `job_memory` (default
   `4g`, used when there is no `container.memory`) and `tier_limits` (default
   none); a wrong value is refused at load with the key named, and a change
   is read without a restart like the rest of `config.yaml`.
   $ sh scripts/with-tmp.sh node --disable-warning=ExperimentalWarning --test helix/test/room.test.ts
6. docs/helix.md, where it describes `config.yaml`, describes
   the three keys and that `slots` is now a ceiling, and CHANGELOG.md says so
   under Unreleased.
   $ grep -q "tier_limits" CHANGELOG.md

## Decisions

- The room check is a pure function in a new `helix/src/room.ts`: given the
  config, the running jobs' tiers and a reading of the machine, it returns
  start or the reason to wait. The supervisor's `tick` calls it per queued
  job, in queue order; a job that does not fit is skipped, not blocking jobs
  behind it that do.
- The machine is read through Node's `os` (`freemem`, `loadavg`,
  `availableParallelism`), passed in as a dependency so tests give fixed
  readings. Nothing reads `/proc` or depends on one operating system. Where
  `loadavg` is all zeros (Windows), load is not checked.
- A job's tier is its plan's implementer tier from the spec's labels, worked
  out with the existing `resolvePlan` from `plugin/src/profiles.ts` when the
  job is submitted and kept on the job. A later escalation inside the job
  does not change what Helix counts.
- The 30-second re-check is a timer in `helix serve` that calls `tick`; it is
  stopped with the supervisor so tests and shutdown leave nothing running.
- Memory sizes are written as `config.yaml`'s container memory is (`6g`,
  `512m`); one parser serves all three.
- No new HTTP route; the reason travels on the job's existing fields. Adding
  an optional field to a job is not breaking.

## Out of scope

- A cap on Claude spend per hour or per day.
- Measuring a running job's own memory or CPU, or stopping a running job for
  lack of room.
- Changing `slots` itself from what the machine has.
- Slack posts about a job waiting for room.
