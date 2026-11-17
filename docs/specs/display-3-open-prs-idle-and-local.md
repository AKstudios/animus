---
size: large
difficulty: hard
type: feature
after: docs/specs/display-1-job-page.md
---
# Open PRs, an idle animation, and the display on a laptop

## Problem

The display lists the last thirty ended jobs, most of them PRs that were
merged or closed long ago, so what still needs a review is hard to find. An
idle Helix shows an empty box. And a person running jobs on their own
laptop has no display at all.

## Solution

The overview lists the ten newest open PRs. When nothing is running or
queued, an original "synchronizing helix" animation fills the space.
`animus ui` shows the local display: every job the laptop's Animus has run,
with the same job pages.

## Acceptance criteria

1. The overview lists the ten newest open PRs that Helix's jobs opened (for
   the picked project when one is picked), with drafts marked. GitHub is
   asked with the token of the person whose job opened the PR, at most once
   per project a minute. RECENT keeps only failed and cancelled jobs.
   $ sh scripts/with-tmp.sh node --disable-warning=ExperimentalWarning --test helix/test/open-prs.test.ts
2. With no job running or queued and no project picked, the overview shows
   the synchronizing-helix animation in place of the empty working box, and
   it holds still when the browser asks for reduced motion. The reviewer
   judges how it looks.
   $ sh scripts/with-tmp.sh node --disable-warning=ExperimentalWarning --test helix/test/view.test.ts
3. `animus run` records its process in the job's progress. A job whose
   process is gone and that has no outcome shows as stopped, with
   `animus resume <job>` as the way on.
   $ sh scripts/with-tmp.sh node --disable-warning=ExperimentalWarning --test plugin/test/local-display.test.ts
4. `animus ui` serves the local display on 127.0.0.1 only and opens it in
   the browser: every job this machine's Animus ran, grouped by project,
   newest first, each with its job page. It has no people pages and no
   sign-in.
   $ sh scripts/with-tmp.sh node --disable-warning=ExperimentalWarning --test plugin/test/local-display.test.ts

## Decisions

- Open PRs: one GitHub call per project lists its open PRs, matched to the
  jobs' PR URLs; results are kept for 60 seconds. A PR whose person has left
  is not asked about and drops off. The GitHub call is injectable so the
  test uses a fake.
- The animation is original and only evokes the Animus of the games: the
  Helix mark unwinding into a slowly turning double helix of light, glitch
  fragments and "SYNCHRONIZING". No Ubisoft names, logos, insignia,
  characters, interface or music. Inline SVG and CSS transforms only, no
  canvas and no script frame loop; paused while the tab is hidden; the whole
  of it drifts slowly so nothing burns into a wall screen. Whether it shows
  is decided in the view, without the DOM. It also shows on the local
  display.
- A job that only waits for an answer does not keep the animation away.
- The local display is a second source behind the same page (ADR 0004): it
  reads `~/.animus` (the job folders and the run log) and answers the same
  shapes Helix does. Local job ids are Animus's own, not numbers.
- `animus run` writes its pid and host to `progress.json`; a job counts as
  running only on the same host with that process alive.
- `animus ui` uses port 7420, or the next free one, prints the address,
  and stops on Ctrl-C. Plain `animus ui` is the local display;
  `animus ui --helix` stays as it is.

## Out of scope

- Showing Helix jobs and local jobs together.
- PRs merged, or PRs opened by hand.
