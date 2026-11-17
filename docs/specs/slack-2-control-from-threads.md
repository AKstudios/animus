---
size: small
difficulty: routine
type: backend
after: docs/specs/slack-1-invites-and-notifications.md
---
# See, answer and cancel jobs from Slack

## Problem

The bot tells a person when their job needs an answer or failed, but to
answer, cancel or see their other jobs they still have to open a terminal.

## Solution

`/helix jobs` and `/helix status` answer privately in Slack. A job's Slack
thread is where its person answers it and where it can be cancelled.

## Acceptance criteria

1. `/helix jobs` replies privately with the person's queued, running and
   needs-input jobs, each with its thread or PR link.
   $ sh scripts/with-tmp.sh node --disable-warning=ExperimentalWarning --test helix/test/slack-control.test.ts
2. `/helix status` replies privately with Helix's slots in use, the queue's
   length and its version.
   $ sh scripts/with-tmp.sh node --disable-warning=ExperimentalWarning --test helix/test/slack-control.test.ts
3. When a job needs input, its person answers by replying in the job's
   thread: any reply in a DM, or a reply that mentions @Helix in a channel.
   The job resumes as it does after `animus answer`, and the thread says so.
   Replies from anyone else, and channel replies without the mention, are
   ignored.
   $ sh scripts/with-tmp.sh node --disable-warning=ExperimentalWarning --test helix/test/slack-control.test.ts
4. The job's thread has a **Cancel job** button. It cancels the job for the
   job's person or the owner; anyone else gets a private refusal.
   $ sh scripts/with-tmp.sh node --disable-warning=ExperimentalWarning --test helix/test/slack-control.test.ts

## Decisions

- Built on the previous spec's bot core and fake transport; tests sit there.
- Answering and cancelling call what `animus answer` and `animus cancel`
  already reach on Helix; Slack adds no second path.
- In channels only replies mentioning @Helix count, so people can talk in a
  job's thread without the bot acting on it.

## Out of scope

- Drafts and starting jobs from Slack.
