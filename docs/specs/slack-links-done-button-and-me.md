---
size: medium
difficulty: routine
type: backend
---
# Job threads link to the job page, lose Cancel when done, and /helix me

## Problem

When a job starts, its Slack thread says only `Job 12 started: <title>
(<project>)`. To watch it the person has to know Helix's addresses and find
the job on the display. The thread's opening post keeps its **Cancel job**
button after the job ended, so it offers to cancel something that is over and
answers with an error when pressed. And nothing in Slack tells a person what
Helix knows about them: who they are there, whether their job posts are on,
what they can build, and what they have running.

## Solution

- A job's start post in its thread links to the job's page at Helix's
  `url` (Tailscale) and at its `lan_url` (the office network), each labelled,
  whichever of the two are set.
- When a job ends (pull request, failure, needs input) or is cancelled, the
  thread's opening post is updated in place: its text says how the job ended
  and the **Cancel job** button is gone. A job that needs input and is
  answered runs again, so its opening post gets the button back when it
  resumes.
- `/helix me` privately shows the sender what Helix knows about them.

## Acceptance criteria

1. A job's start post includes its page, `<url>/jobs/<id>`, labelled
   Tailscale, and `<lan_url>/jobs/<id>`, labelled office network, when each
   is set in `config.yaml`; with neither set it says nothing about links. A
   resumed job's post carries the same links.
   $ sh scripts/with-tmp.sh node --disable-warning=ExperimentalWarning --test helix/test/slack-notify.test.ts
2. When a job ends or is cancelled, the thread's opening post is updated
   (`chat.update`) to say the job's outcome and has no **Cancel job**
   button; when an answered job resumes, it is updated again with the button.
   $ sh scripts/with-tmp.sh node --disable-warning=ExperimentalWarning --test helix/test/slack-notify.test.ts
3. Pressing a **Cancel job** button left on an old message for a job that is
   already over replies privately that the job has already ended, and
   updates that message to remove the button.
   $ sh scripts/with-tmp.sh node --disable-warning=ExperimentalWarning --test helix/test/slack-control.test.ts
4. `/helix me` privately shows: the sender's Helix name and GitHub login,
   whether they are the owner, when they joined, whether job notifications
   are on, the projects they may submit to, their queued, running and waiting
   jobs (as `/helix jobs` lists them), their last five ended jobs with
   outcome and pull request, and their people page at `url` and `lan_url`
   when set. It never shows a token or a credential.
   $ sh scripts/with-tmp.sh node --disable-warning=ExperimentalWarning --test helix/test/slack-control.test.ts
5. `/helix help` lists `/helix me`, the manifest's usage hint names it, and
   CHANGELOG.md says what changed under Unreleased.
   $ grep -q "me |\|| me" helix/deploy/slack/manifest.yaml

## Decisions

- Links are built from `config.url` and `config.lan_url` the way the invite
  DM builds its two join lines (`helix/src/slack.ts`), trailing slashes
  trimmed. No link ever carries a Helix token: Slack keeps message history,
  and the job page asks for the token once per address in the browser.
- The notifier needs `update` from the transport besides `dm` and `post`;
  the opening post's channel and `ts` are already kept by
  `store.putSlackThread`.
- The cancel button's handler and `/helix cancel` (if built by then) share
  one check for "already over".
- "The projects they may submit to" is the same list the draft project
  picker offers them.
- A person's page is `<address>/people/<name>`.
- Tests use the fake transport in `helix/test/fake-slack.ts`; none reaches
  Slack.

## Out of scope

- A sign-in link that carries the token, or any login flow for the display.
- Editing anything from `/helix me` (notify stays its own command).
- Links in posts other than the start and resume posts.
