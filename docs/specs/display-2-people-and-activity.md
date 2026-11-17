---
size: large
difficulty: hard
type: feature
after: docs/specs/display-1-job-page.md
---
# See who is on Helix and everything each person has done

## Problem

Nobody can see who has joined a Helix, what each person has submitted, or
what they have done there: answers given, jobs cancelled, projects added.
Helix keeps only a job's last answer and no record of the rest.

## Solution

Helix keeps an activity for each thing a person does. `/people` lists
everyone on the Helix with their numbers, and `/people/<name>` is that
person's page: their jobs and their activity.

## Acceptance criteria

1. Helix keeps an activity, with who and when, each time a person submits,
   answers or cancels a job, joins, leaves, or adds or removes a project.
   A person who joins from now on has the day they joined kept.
   $ sh scripts/with-tmp.sh node --disable-warning=ExperimentalWarning --test helix/test/activity.test.ts
2. `/people` lists each person with their GitHub login, when they joined
   (blank for those who joined before it was kept), jobs submitted, PRs
   opened, total spent and their last activity.
   $ sh scripts/with-tmp.sh node --disable-warning=ExperimentalWarning --test helix/test/person-page.test.ts
3. `/people/<name>` shows that person's numbers, their jobs newest first,
   thirty at a time, each linking to its job page, and their activity newest
   first. Jobs from before activity was kept still show.
   $ sh scripts/with-tmp.sh node --disable-warning=ExperimentalWarning --test helix/test/person-page.test.ts
4. Every person named on the overview or a job page links to their person
   page.
   $ sh scripts/with-tmp.sh node --disable-warning=ExperimentalWarning --test helix/test/person-page.test.ts

## Decisions

- Activity is a new append-only table in `helix.db`, written where each
  action happens (the API, `helix remove-person`, `helix remove-repo`).
  Nothing is backfilled; a person's jobs come from the jobs table, so old
  ones still show.
- An answer's activity keeps the answer's text, so every answer stays even
  when a job is answered more than once.
- A person who leaves keeps their activity and jobs; their page says they
  left.
- Person pages need a valid token, like job pages; any person may see any
  other.
- Each Slack spec (docs/specs/slack-*.md) gets one line under Decisions:
  what the bot does for a person is recorded as their activity.
- No owner is marked: Helix does not know one yet. PRs merged is not shown:
  it would need a GitHub call per PR.

## Out of scope

- Open PRs, the idle animation and the local display.
- Changing or removing people from the display.
