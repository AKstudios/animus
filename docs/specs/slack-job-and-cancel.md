---
size: small
difficulty: routine
type: backend
---
# /helix job and /helix cancel

## Problem

From Slack, a person sees one job only through `/helix jobs`, a list of one
line each, or by finding its thread. Nothing says what one job is doing now,
why it is still queued, or how it ended. Cancelling takes the Cancel button
in the job's thread, so a job whose thread is lost, or one started from a
laptop with notifications off, cannot be cancelled from Slack at all.

## Solution

Two `/helix` commands, answered privately like the others:

- `/helix job <id>`: the job's title, project and person; its state; for a
  running job, its stage and who is working (as the display shows); for a
  queued one, why it waits when it is held for room; for an ended one, its
  outcome, its pull request and the reason it failed or the question it
  asks; and links to its thread and pull request when it has them.
- `/helix cancel <id>`: cancels a queued or running job, exactly as the
  thread's Cancel button does, and says so in the job's thread when it has
  one.

## Acceptance criteria

1. `/helix job <id>` shows the job's title, project, person, state and the
   links it has; for a running job its stage and who is working, for a queued
   one held for room the reason it waits, for an ended one its outcome with
   its pull request, failure reason or question.
   $ sh scripts/with-tmp.sh node --disable-warning=ExperimentalWarning --test helix/test/slack-control.test.ts
2. `/helix job <id>` for a job that does not exist, or one of another
   person's when the sender is not the owner, says there is no such job of
   theirs and shows nothing of it. The owner may look at any job.
   $ sh scripts/with-tmp.sh node --disable-warning=ExperimentalWarning --test helix/test/slack-control.test.ts
3. `/helix cancel <id>` cancels the sender's queued or running job, replies
   that it was cancelled, and posts `Job <id> was cancelled by <@user>.` in
   its thread when it has one, as the button does. The owner may cancel
   anyone's job; anyone else gets `Only <person> or <owner> may cancel job
   <id>.`
   $ sh scripts/with-tmp.sh node --disable-warning=ExperimentalWarning --test helix/test/slack-control.test.ts
4. `/helix cancel <id>` on a job that has already ended or been cancelled
   says so, and on a missing job or a word that is not a job number says
   there is no such job; neither changes anything.
   $ sh scripts/with-tmp.sh node --disable-warning=ExperimentalWarning --test helix/test/slack-control.test.ts
5. `/helix help` lists both commands, the manifest's `/helix` usage hint
   names them, and CHANGELOG.md says so under Unreleased.
   $ grep -q "job <id>" helix/deploy/slack/manifest.yaml && grep -q "cancel <id>" helix/deploy/slack/manifest.yaml

## Decisions

- Both live in `helix/src/slack.ts` beside `jobsCommand`. The Cancel button
  and `/helix cancel` share one function, so who may cancel and what the
  thread is told cannot drift apart.
- Stage and who is working come from `supervisor.progress(job)`, as the
  display reads them; the queued reason is the job's `waiting` field.
- An `#` before the number is accepted (`/helix job #12`).
- No confirmation step: the command names the job by number.
- Tests use the existing `helix()` setup and fake transport in
  `helix/test/slack-control.test.ts`.

## Out of scope

- Cancelling several jobs at once, or a draft (Discard does that).
- Showing a job's log in Slack.
- `/helix retry`.
