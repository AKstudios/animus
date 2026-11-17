---
size: large
difficulty: risky
type: feature
---
# See everything about a job on its own page

## Problem

The display shows that a job is running or how it ended, and nothing else.
To learn what a job was asked, how its checks went, what the reviewer said
or what it asked and was told, a person has to ssh to the machine and read
files.

## Solution

Every job on the display links to its job page at `/jobs/<id>`, a link that
can be shared and opened cold. The job page shows the job's spec, stages,
checks, review, questions and answers, log and screenshots, live while it
runs. A person signs in on the display with their Helix token. The overview
stays open to everyone on the network, as now.

## Acceptance criteria

1. The display's page and scripts are served from the plugin, and Helix's
   overview looks and behaves as it did.
   $ sh scripts/with-tmp.sh node --disable-warning=ExperimentalWarning --test helix/test/view.test.ts helix/test/helix.test.ts
2. `/jobs/<id>`, `/people` and `/people/<name>` each load the display at
   that page, also when the address is opened cold, and every job on the
   overview links to its job page. The two people pages may say only that
   they are coming.
   $ sh scripts/with-tmp.sh node --disable-warning=ExperimentalWarning --test helix/test/display-pages.test.ts
3. A token given in the address as `#token=…` is kept by that browser and
   removed from the address bar; a person can also paste their token, and
   sign out. Without a token the overview works as before and a job page
   says to sign in. Helix answers a job page's data only to a valid token.
   $ sh scripts/with-tmp.sh node --disable-warning=ExperimentalWarning --test helix/test/display-pages.test.ts
4. A job page shows the job's title, project, person, state, outcome, PR,
   cost and times; its spec as submitted; each stage with how long it took,
   and its slices when it was cut; each check, with the output of a failed
   one; the reviewer's findings; every question it asked with the answer it
   was given; and its log, following the end every two seconds while it runs
   unless the person has scrolled up, and whole once it has ended.
   $ sh scripts/with-tmp.sh node --disable-warning=ExperimentalWarning --test helix/test/job-page.test.ts
5. A job's screenshots show on its job page. Helix serves them only to a
   valid token, and no path reaches outside that job's folder.
   $ sh scripts/with-tmp.sh node --disable-warning=ExperimentalWarning --test helix/test/job-page.test.ts
6. `animus ui --helix` opens the person's Helix in their browser, already
   signed in.
   $ sh scripts/with-tmp.sh node --disable-warning=ExperimentalWarning --test plugin/test/ui-command.test.ts

## Decisions

- ADR 0004: the display (page, styles, fonts, scripts, view) moves out of
  `helix/ui/` into the plugin, and Helix serves it from there. This move is
  the first slice, before any new page, and changes no behaviour.
  `helix/` still never ships in the plugin.
- Pages are real paths served by Helix, not hash routes, so a Slack thread
  can later link `/jobs/<id>`. Helix answers each of them with the same
  page; the script draws the one the path names. The picked project on the
  overview may stay in the hash.
- `GET /display` stays unauthenticated and keeps leaving out what it leaves
  out now. A job page's data comes from a new authenticated endpoint; any
  person on the Helix may see any job.
- The token is kept in the browser's localStorage, read on every request
  and sent as `Authorization: Bearer`; a refused token is forgotten and the
  page says to sign in again. Every read and write of storage is guarded.
- What a job page shows comes from Helix's job row and the Animus job
  folder in the submitter's Animus home on the machine (spec, `state.json`,
  the run log line, gate output, reviews, `shots/`), read fresh on each
  request: Helix keeps nothing new for it. Questions and answers come from
  the job's `answers` in its state, so every round shows, not only the last.
- Claude session transcripts are not shown.
- The wording of a job page is worked out without the DOM, beside the
  overview's view, and tested the same way.
- `animus ui --helix` opens `<url>/#token=<token>` with the URL and token
  the person joined with, through the system's opener; the test fakes the
  opener. Plain `animus ui` (the local display) is a later spec.
- docs/helix.md says not to sign in on a shared wall screen: a token can
  also submit and cancel.

## Out of scope

- The people pages' contents and the activity record
  (display-2-people-and-activity).
- Open PRs, the idle animation and the local display
  (display-3-open-prs-idle-and-local).
- Cancelling or answering from the page: the display only reads.
