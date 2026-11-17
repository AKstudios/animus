---
size: large
difficulty: risky
type: feature
after: docs/specs/slack-2-control-from-threads.md
---
# Start a job from a Slack message

## Problem

A teammate who has a GitHub issue, a Slack thread or a document describing
some work has to open Claude Code on a laptop to turn it into a spec before
Helix can do it. A Slack message on its own is not a spec: it has no
acceptance criteria and no checks.

## Solution

`/helix draft <text and links>` (or `@Helix <text>`) turns the message and
what it links to into a draft spec, posted in a thread. The person asks for
changes by replying, and **Submit** queues it as a job once a script finds it
complete.

## Acceptance criteria

1. `/helix draft <text>` or `@Helix <text>` from a linked person starts
   `animus draft` on Helix, and the draft is posted in a thread as text and as
   a `.md` file, with **Submit** and **Discard** buttons.
   $ sh scripts/with-tmp.sh node --disable-warning=ExperimentalWarning --test helix/test/slack-draft.test.ts
2. A GitHub issue or pull request link, a Slack file, or a public URL in the
   message is fetched before the session starts and saved beside the draft
   as a reference. The session reads those files and has no GitHub token and
   no network beyond Claude.
   $ sh scripts/with-tmp.sh node --disable-warning=ExperimentalWarning --test plugin/test/draft.test.ts
3. The draft's project is the linked issue's repository, else the channel's
   default set with `/helix project <name>`, else the one the person picks
   from a list of projects their GitHub token can push to.
   $ sh scripts/with-tmp.sh node --disable-warning=ExperimentalWarning --test helix/test/slack-draft.test.ts
4. A reply in the draft's thread from its person (any reply in a DM, a reply
   mentioning @Helix in a channel) runs the draft session again with that
   reply, and the revised draft replaces the old one in the thread.
   $ sh scripts/with-tmp.sh node --disable-warning=ExperimentalWarning --test helix/test/slack-draft.test.ts
5. **Submit** runs the same spec check as `animus plan`. A draft missing
   criteria or a check under each is refused in the thread with the reason. A
   complete one is queued as the person's job, and the thread becomes the
   job's thread.
   $ sh scripts/with-tmp.sh node --disable-warning=ExperimentalWarning --test helix/test/slack-draft.test.ts
6. A draft session stops at $0.50, a person's fourth open draft is refused,
   draft sessions run `draft_slots` at a time machine-wide (default 1) with
   the thread saying how many are ahead, and a draft untouched for 7 days is
   discarded with a note in its thread.
   $ sh scripts/with-tmp.sh node --disable-warning=ExperimentalWarning --test helix/test/slack-draft.test.ts plugin/test/draft.test.ts
7. docs/factory.md and docs/workflow.md describe drafts where they now say
   "the message is the spec".

## Decisions

- What the bot does for a person is recorded as their activity.
- Slack jobs start from a draft the person confirms, never from the message
  itself (docs/adr/0001).
- Draft sessions see only references a script fetched; the job gets the
  confirmed spec only, not the references (docs/adr/0003). A new kind of
  reference is a new fetcher in the script.
- `animus draft` is a read-only session on the fast tier, in the person's
  container, on a clone of the project at its base, so it can name real files
  and test commands. Only `Agent` in plugin/src/agent.ts names the model.
- Draft sessions have their own limit, `draft_slots` in `config.yaml`, apart
  from job slots, so drafts never delay jobs.
- A draft is changed only by replying; no Slack edit form (Slack caps a form
  field at 3,000 characters).
- Tests: Slack behaviour through the bot core's fake transport; the draft
  session through the fake agent in plugin/test/helpers.ts.
- Terms are in GLOSSARY.md: draft, reference.

## Out of scope

- Google Docs, Notion or any reference that needs a per-person sign-in.
- Code questions that end in an answer rather than a pull request.
- An interview in the thread.
