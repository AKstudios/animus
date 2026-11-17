---
size: small
difficulty: routine
type: feature
---
# The local display stops pointing at what it does not have

## Problem

Seen in a browser on `animus ui`: the header links to PEOPLE, which the
local display does not have, and the link lands on a bare
`{"error":"nothing at /people"}`. Its job rows say only "PR", with no number
and no way to the pull request. A running job's card reads "animus ·" with
nothing after the dot, and an empty `>` line. A local job page's log says "It
has printed nothing yet." when the job did print, to its terminal.

## Solution

The local display shows only what it has, and says where the rest is.

## Acceptance criteria

1. The local display's header has no PEOPLE link; Helix's still does.
   Opening `/people` or `/people/<name>` on the local display shows the
   display saying that this machine's display has no people pages, never
   raw JSON.
   $ sh scripts/with-tmp.sh node --disable-warning=ExperimentalWarning --test plugin/test/local-display.test.ts
2. On the local display a job that opened a pull request is tagged with its
   number (`PR #8`, `DRAFT PR #8`) and the tag links to the pull request on
   GitHub.
   $ sh scripts/with-tmp.sh node --disable-warning=ExperimentalWarning --test plugin/test/local-display.test.ts
3. A running job with no person shows its project with no separator after
   it, and a job that has said no line yet shows no empty `>` line, on the
   local display and on Helix.
   $ sh scripts/with-tmp.sh node --disable-warning=ExperimentalWarning --test helix/test/view.test.ts
4. A local job page's log section says the job's output went to the
   terminal it ran in, instead of "It has printed nothing yet."
   $ sh scripts/with-tmp.sh node --disable-warning=ExperimentalWarning --test plugin/test/local-display.test.ts

## Decisions

- Whether the header links to PEOPLE is decided in the view from the
  display's `local` flag, beside the other local differences, so it is
  tested without the DOM.
- The local server answers `/people` and `/people/<name>` with the
  display's page, as Helix does; the page draws the notice. No people data
  route is added to the local server.
- On Helix the open-PRs list stays where a PR is reached from, and RECENT
  stays as it is: the PR link on a job row is for the local display only.
- The wording of every notice is worked out in the view, as now.

## Out of scope

- A log file for local runs.
- Anything on Helix's people pages, open PRs or sign-in.
