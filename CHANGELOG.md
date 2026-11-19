# Changelog

What each release changes, newest first. `node scripts/release.ts` writes
each release from the merged pull requests, so a pull request does not edit
this file. What breaks the HTTP API, a spec, a profile or a job's files is
marked **Breaking**: such a release bumps the
minor version before 1.0 and the major after, and Helix then refuses older
clients with how to update.

## Unreleased

## 0.6.2 (2026-11-19)

- A job page shows what is happening now and every stage the job went through ([#53](https://github.com/AKstudios/animus/pull/53))
- A failed add check starts a provision job that fixes the project's environment ([#52](https://github.com/AKstudios/animus/pull/52))
- Overview: finished and open PR rows show project, submitter and time taken ([#51](https://github.com/AKstudios/animus/pull/51))
- One name per person, People that loads, headings on their own row and a clear labels dialog ([#50](https://github.com/AKstudios/animus/pull/50))
- A project's profile names its environment variables and secrets ([#49](https://github.com/AKstudios/animus/pull/49))
- Glossary: one name per person, labels, stages and agent sessions ([#48](https://github.com/AKstudios/animus/pull/48))
- A project runs in its own image, and adding it runs every gate ([#47](https://github.com/AKstudios/animus/pull/47))

## 0.6.1 (2026-11-19)

- A person's facts and the screenshot viewer fit their space ([#44](https://github.com/AKstudios/animus/pull/44))
- The display tells fixes apart and shows a running job as it is ([#46](https://github.com/AKstudios/animus/pull/46))
- Jobs on this machine run from the same queue as Helix, without a session ([#43](https://github.com/AKstudios/animus/pull/43))
- Design: a project's own image, env and secrets, and provision jobs ([#45](https://github.com/AKstudios/animus/pull/45))
- The display shows names, usage and tokens, and finds its way back ([#42](https://github.com/AKstudios/animus/pull/42))
- Tests no longer write into the real Animus home ([#40](https://github.com/AKstudios/animus/pull/40))
- Helix holds a waiting job in its queue until the spec it builds on merges ([#41](https://github.com/AKstudios/animus/pull/41))
- Glossary, ADR and rule for one queue on Helix and on one machine ([#39](https://github.com/AKstudios/animus/pull/39))
- Fix any Animus pull request, from wherever it was opened ([#38](https://github.com/AKstudios/animus/pull/38))
- Display fixture names tiers; npm run changelog removed ([#37](https://github.com/AKstudios/animus/pull/37))
- Helix jobs started together no longer fail setting up with ENOTEMPTY ([#36](https://github.com/AKstudios/animus/pull/36))

## 0.6.0 (2026-11-19)

- Pull requests no longer touch CHANGELOG.md: `npm run release` writes the release's notes from the merged pull requests, and a job's pull request has a `## Breaking` section when its implementer reports a breaking change (the report gains an optional `breaking`). The `changelog` gate is gone; `npm run changelog` stays as a no-op until a later change drops it.
- `/animus fix <what to change>` on an open pull request a job opened, from
  the job's person or the owner, gets 👀 and queues a fix on Helix with the
  pull request's reviews and inline comments since the last push as
  references (`animus fix --references <dir>`). A plain `/animus` there, a
  fix from anyone else, on a pull request no job opened, a merged or closed
  one or one with a fix already queued, running or waiting gets a one-line
  reply and queues nothing. The fix comments on the pull request when it
  pushed (what changed, its cost, its job page), failed or was refused (the
  reason) or asks a question, and nothing in between; `/animus answer <text>`
  and `/animus cancel` on the pull request act on it.
- The job page tells what the run cost and what came of it: the third number is fix rounds (with the gate runs), the Pull request panel adds the commits and lines people added after the job and, once merged, the 30-day watch, an Agents panel shows cost by role and tier with each one's sessions, tool calls and failed calls, "What this run taught" lists the lessons citing the job, a flaky check is a chip, each review finding says its fate, and a folded Tool calls row lists the calls as `animus tools` does. The Jobs page has a Fix rounds column, and the overview's This week shows gates passed first time and cost per merged PR in place of jobs finished and money spent, with a link to Insights. Job and list data gain `run`, `after`, `lessons` and `fix_rounds`; nothing is removed.
- The display has an Insights page (`/insights`, a tab beside Jobs, on Helix and on `animus ui`) that asks whether the factory is getting better: the last 30 days against the 30 before, for the factory or one project (`?scope=`). It shows merge rate, merged untouched, gates passed first time (a flaky check counts as passed), cost per merged PR with the median job time, and PRs reverted or reworked within the 30-day watch, each with its change; a table by task class; one bar per reason jobs did not deliver; agents by role and tier with their share of cost, tool calls, failed calls and review findings acted on; flaky checks; and proposed and kept lessons (read-only: accept one with `animus lessons accept <id>`). Its data is the new `GET /insights-data[?scope=]`, served on Helix to any person with a token and on the local display without one.
- `animus fix <pr> "<text>"` changes an open pull request a job opened: a new
  job in that job's worktree, reset to the branch as GitHub has it, that
  carries on from its implementer session (or a handoff when the session is
  over the context budget), proves every criterion again and pushes to the
  same pull request, whose body keeps `Closes #N` and gains a Fixes list. The
  run log's `fix_of` names the job it continues; `trigger` is `fix`, and
  `without_session: true` marks a fix that ran from the pull request alone
  (its spec read from the description, a fresh session). `animus fix`
  refuses a pull request no job opened, a merged or closed one and one with
  a fix queued, running or waiting for an answer; a failed fix, or one the
  reviewer refuses on a ready pull request, pushes nothing. Every pull
  request body now carries the spec in a collapsed block, left out with a
  note past GitHub's 65,536 characters. `animus cleanup` keeps a job's
  worktree and branch while a fix of its pull request is queued, running or
  waiting. With a Helix, `animus fix` submits to the new `POST /jobs/fix`
  (`repo`, `pr`, `ask`; the job's person or the owner), which runs it as an
  `animus fix` process in a new container, and the job page links the job it
  fixes. Adding the route is not breaking.
- The display's overview is the same on `animus ui` and on Helix: Needs you, Working now, Queued, Open pull requests, Finished. Result tags are in sentence case, a Finished row says how long its PR took to merge, and the Projects panel has ticks and a key in place of the "All projects" button.
- `animus retro [--project <name>] [--days <n>]` runs a read-only `retro`
  session (standard tier, a new role in profiles.yaml) over a project's runs
  and proposes at most 5 lessons, each citing at least two jobs or one whose
  PR was reverted or reworked; the script drops the rest. `animus lessons`
  lists proposed, kept and expired lessons from the new
  `ANIMUS_HOME/lessons.json`, and `animus lessons accept <id>` /
  `dismiss <id>` keep or drop one. A kept lesson expires after 60 days
  unless a retro sees it again. Every later job gives its project's and the
  factory's kept lessons to the implementer, planner and reviewer they are for
  (at most 10 each, newest first, under "Lessons from earlier jobs"), adds one
  to each lesson's uses, and lists the ids as `lessons` on its run line.
  `helix serve` runs a retro for each ready project once a week (as `animus
  retro --project <name> --json`, which prints its counts as JSON), keeps the
  lessons in Helix's own Animus home, and posts the count and `animus lessons`
  to the project's Slack channel. New `GET /lessons[?project=<name>]` and
  `POST /lessons/<id>` (`action`: `accept` or `dismiss`) take a person's
  token, and `animus lessons` / `accept` / `dismiss` use them for a checkout
  of a Helix project (`--local` or `--helix` decides), say where they acted,
  and refuse to `accept` or `dismiss` on this machine when a Helix you are
  signed in to does not answer. On a Helix with containers the retro also reads
  each person's Animus home, jobs get Helix's `lessons.json` read-only, and
  Helix counts their uses from the run line.
- A spec refused at admission, and a job ended by SIGINT, SIGTERM or a Helix
  cancel, now leave a run line with cause `admit`, `interrupted` or
  `cancelled`. Helix writes a `cancelled` file beside the job's spec before it
  kills the job.
- The run log's `review` gains `log`: every finding as `{ round, severity,
  file, line, fate }` (`fixed`, `open` or `not-acted-on`), the counts as
  before. `factory_version` is the plugin's version plus the commit (and
  `-dirty`) from a git checkout, never `unknown`. `animus outcomes` records
  `human_lines` (lines added and removed by commits after the job's last
  run) beside `human_commits`, and `--json` shows them.
- Each agent session leaves its tool calls in `tools.jsonl` in the job's
  folder, read by the script from the session's transcript when it ends, and
  the run log's agent entries gain `tools: { calls, errors, by_tool }`.
  `animus tools <job>` (and `--json`) shows the sessions and every call.
- A gate check that fails is run once more on the same tree before the work
  is sent back. Passing then, it counts as passed, the run log marks it
  `flaky: true` in that gate run, and the job says `flaky: <check> failed,
  then passed on the same code`.
- Every run that does not end as a pull request has a `cause` in the run log,
  set by script (`setup`, `plan`, `needs-input`, `gates` with
  `failing_checks`, `review` with `blockers_left`, `budget`, `context`,
  `agent-error`; `admit`, `cancelled` and `interrupted` are in the list but not
  yet set), and `animus outcomes` counts each task class's jobs by cause. A
  job whose setup fails now leaves a run.

- **Breaking:** a spec's header is held to its keys. A key other than `title`,
  `size`, `difficulty`, `type`, `base`, `ui`, `after` and `design` (or, under
  `ui`, other than `target` and `pages`) is refused with "did you mean", where
  it used to be ignored. Specs written with a misspelt or invented key must be
  corrected. Specs that `after:` names are still read as before.
- A spec is admitted against its project before it runs. One script, with no
  model, checks it against the factory and the project's profile and lists
  every problem at once, each marked as fixed in the spec or in the profile
  (with the YAML to add and the branch the profile was read from): an unknown
  key, a `ui` of the wrong shape, no or an unknown UI target, an unknown page,
  a design file or base branch that is missing, a type not built, a `bug` spec
  with no command, a spec where no criterion has one. `animus plan` shows the
  target, pages, gates, problems and warnings, and exits 1 when refused;
  `animus run` and `start` admit before any work, and a warning is shown when
  every criterion's command is a gate or all are the same.
- Helix admits against the base branch as GitHub has it: `POST /jobs` answers
  400 with the list, `animus start --helix` warns when the checkout's profile
  differs, `after:` is refused on Helix with a pointer to `--local`, and a
  queued job is admitted again when it starts and ends as `refused`, with the
  list, if it no longer passes. Jobs and drafts read the profile from
  `origin/<base>`, not from whatever the clone has checked out.
- Drafts on Slack and GitHub are written knowing the project (base, gates,
  runnable types, UI targets and pages), admit's problems go back to the
  session once within the $0.50 cap, the posted draft carries a summary
  outside its spec, and Submit is refused with the problems while any remain.
  A draft's criterion may have no command.
- A UI spec's `pages` may give a path such as `/masjid/subscribe`; the job
  screenshots it on its target as it does a named page.
- `issue_link: refs` in the project's profile makes a PR for a GitHub issue say
  `Refs #N` instead of `Closes #N`; the default is `closes`.
- Helix jobs and drafts read the project's base branch as GitHub has it. Before a job starts or a draft is written, Helix fetches the base branch (the profile's `base`, `main` when unset) with the person's token, so a profile fixed on GitHub is the one the next job reads, even from an older clone. A fetch that fails (token refused, GitHub unreachable) ends the job or draft before any work, with the reason. A person's own branches and uncommitted work in a clone are left alone.
- The display's overview leads with what needs you: a headline from the counts
  ("1 job needs you. 3 agents at work.") and the last job that finished, an
  amber card for each question waiting (with the `animus answer` or
  `animus resume --answer` command), the work in progress, then a short QUEUED
  list. A THIS WEEK panel and the PROJECTS list sit beside the main column, a
  merged PR's tick in violet, and the header has tabs.
- The display's look: system sans with mono only for ids, numbers and commands,
  no grid, result tags as pills tinted with their status (merged violet, open
  green, failed red), headings and buttons in sentence case. The job page
  lists its acceptance criteria with the command that proved each, its other
  checks as tags, and its slices folded; the stage bar is one hue. The Jobs
  page filters by result with one row of choices. Titillium Web and its files
  are gone.
- `animus ui` reads GitHub for its PRs' outcomes when it starts and every ten
  minutes (in a process of its own, when `gh` is installed), so merged and
  closed PRs show as such on the local display's overview as well as its Jobs
  page.
- This repo's profile has a ui target, `display`: the display served from
  made-up jobs (`scripts/display-fixture.ts`), each page compared with its
  design in `docs/design/display/`. Display specs can now be `type: ui`.
- An Insights page shows whether the factory is getting better ([#35](https://github.com/AKstudios/animus/pull/35))
- Fix a pull request with an /animus fix comment ([#34](https://github.com/AKstudios/animus/pull/34))
- Release notes come from the merged pull requests ([#33](https://github.com/AKstudios/animus/pull/33))
- Fix an open pull request with animus fix ([#32](https://github.com/AKstudios/animus/pull/32))
- The factory proposes lessons and uses the ones you keep ([#31](https://github.com/AKstudios/animus/pull/31))
- The display looks like its design ([#30](https://github.com/AKstudios/animus/pull/30))
- Glossary and ADR for fix on pull requests ([#29](https://github.com/AKstudios/animus/pull/29))
- Every run records what each agent did and why it stopped ([#28](https://github.com/AKstudios/animus/pull/28))
- Design references: time bar colours and Insights ([#27](https://github.com/AKstudios/animus/pull/27))
- A spec is admitted against its project before it runs ([#26](https://github.com/AKstudios/animus/pull/26))
- Display design references follow the redesign canvas ([#25](https://github.com/AKstudios/animus/pull/25))
- Helix jobs and drafts read the base branch as GitHub has it ([#24](https://github.com/AKstudios/animus/pull/24))
- The display shows what needs you first ([#23](https://github.com/AKstudios/animus/pull/23))
- Glossary and ADRs: admit decides whether a spec runs, at every entry point and at job start; Helix reads the profile from the base branch

## 0.5.1 (2026-11-18)

- The display's RECENT is now FINISHED: the 30 newest jobs that ended or were
  cancelled, with a delivered one tagged `MERGED #n`, `CLOSED #n` or, when
  GitHub has not answered about it, `PR #n`. Helix asks GitHub once a minute
  per project for its 10 latest closed PRs, and `/display` gains an optional
  `closed` list beside `prs`. WAITING, OPEN PRS and FINISHED are not drawn when
  empty.
- A Jobs page at `/jobs`, linked from the display's header, lists every job
  newest first, 30 at a time with SHOW MORE, tagged RUNNING, QUEUED, NEEDS INPUT,
  OPEN PR #n, MERGED #n, CLOSED #n, FAILED and so on. Its result, project and
  person filters are in the address. Helix serves it from `GET /job-list`, to a
  person's token; `animus ui` has it too, without the person filter, with
  merged and closed read from `outcomes.json`.
- Every job says where to watch it. `animus start` and `animus run` on this
  machine print `watch it: animus ui, then open /jobs/<job>`; `animus start
  --helix`, `animus submit` and `animus status <id>` print the job page on
  Tailscale and the office network, whichever Helix has set. Helix's submit and
  status answers gain `links`; older clients ignore it. The to-spec and helix
  skills offer `animus ui` or give both links.

## 0.5.0 (2026-11-18)

- **Breaking:** Slack's command is `/animus` and its bot is Animus, not
  `/helix` and Helix: every subcommand and `@Animus <text>` work as before, and
  `/helix` is no longer answered. Update the Slack app from
  helix/deploy/slack/manifest.yaml and reinstall it to the workspace. The
  `helix` CLI is unchanged.
- Start and follow work with GitHub comments: Helix reads each project's issue
  and pull request comments about once a minute, from the moment it first sees the project. A person's `/animus <text>`
  on an issue gets a 👀 reaction and a draft spec as a comment (the spec in a
  `markdown` block, with the replies it understands), written from the issue and
  the comment, whether or not Slack is set up. A second `/animus <changes>` while
  the draft is open posts the revised draft as a new comment. A comment more
  than a day old when first seen is answered as too old; on a pull request,
  `/animus` replies that `fix` is not available yet. Comments by people not on
  the Helix, by Animus itself, or on repositories that are not projects are
  ignored. A person with a Slack link is also DMed a link to each draft or
  revision posted. `/animus discard` on the issue closes the draft with a
  comment (the draft's person or the owner may), and a draft untouched for 7
  days is discarded with a comment on its issue. GitHub and Slack drafts share
  the limit of 3 open per person and the `draft_slots` queue. `/animus submit`
  reads the spec block of the latest draft comment as it is on GitHub then, hand
  edits included, checks it as `animus plan` does and queues it as the draft
  person's job, with a comment naming the job; an incomplete spec, or a comment
  with no readable spec block, gets a comment saying so and queues nothing. A
  job submitted that way comments on its issue when its pull request opens (the
  pull request says `Closes #<issue>`), when it fails, with the reason, and when
  it needs input, with the question; stages in between are not commented.
  `/animus answer <text>` on the issue answers the question and resumes the job,
  and `/animus cancel` cancels it. `submit`, `discard`, `answer` and `cancel` by
  anyone but the draft's or job's person, or the owner, get a one-line refusal.
  `helix check` now flags a project that no person's GitHub token can read
  comments on, and docs/factory.md, helix.md and cli.md describe `/animus`
  comments on GitHub.

## 0.4.7 (2026-11-18)

- `/helix job <id>` shows one job in Slack: its state, stage and who is working,
  why it waits, or how it ended, with links to its thread and pull request.
  `/helix cancel <id>` cancels a queued or running job as the thread's Cancel
  button does. Both appear in `/helix help`; the manifest's usage hint names
  them: update the Slack app from it.
- A job's Slack start and resume posts link its page at `url` (Tailscale) and
  `lan_url` (office network), whichever are set. When a job ends or is
  cancelled, its thread's opening post is edited to say how, without the
  **Cancel job** button (back when an answered job resumes); an old button
  pressed for a finished job replies privately and is removed. This needs the
  `chat:write` scope the bot already has.
- `/helix me` privately shows what Helix knows about the sender: their name,
  GitHub login, whether they own Helix, when they joined, whether job
  notifications are on, the projects they may submit to, their queued,
  running and waiting jobs, their last five ended jobs, and their people
  page. `/helix help` and the Slack manifest's usage hint list it: update
  the app from the manifest.

## 0.4.6 (2026-11-18)

- `/helix help` lists every Slack command, one line each, the owner's only to
  the owner; an empty or unknown `/helix` now gets the same list. The Slack
  app's manifest has a new description, a long description and `help` in the
  usage hint: update the app from it (no reinstall needed).
- Helix starts a queued job only when the machine and Claude have room.
  `config.yaml` takes `reserve_memory` (`2g`), `job_memory` (`4g`) and
  `tier_limits` (such as `deep: 1`); `slots` is now the most jobs at once. A
  job held for room says why in `animus status <id>` and on the display, and
  Helix checks again every 30 seconds. With nothing running, the first queued
  job starts regardless.
- `animus draft <folder>` writes a spec, `draft.md`, from a message and the
  references fetched beside it: one fast session (the new `drafter` profile,
  stopped at $0.50) that reads files and nothing else, refuses to start with
  a GitHub token, and leaves the earlier draft when it stops. The fetching
  (GitHub issues and pull requests, Slack files, public pages but never a
  private address) and the draft's container are there for Helix.
- Helix drafts from Slack: `/helix draft <text>` or `@Helix <text>` from a
  linked person posts a thread, fetches what the message links to with the
  person's GitHub sign-in, runs `animus draft` (without it), and posts the
  draft in the thread as text and as `draft.md`, with Submit and Discard.
  The project is the linked issue's repository, else the channel's default
  set with `/helix project <name>`, else the one the person picks from those
  the GitHub App lets them push to. `draft_slots` in config.yaml (1 when
  unset) is how many drafts run at once, apart from jobs.
- A draft's person revises it by replying in its thread (any reply in a DM,
  one mentioning @Helix in a channel), and the revision replaces the draft's
  post and file. Submit runs the check `animus plan` does and wants a
  `$ command` under every criterion; it says what is missing in the thread,
  or queues the draft as the person's job, whose progress then posts in that
  thread. Discard closes a draft, a person has at most 3 open, a waiting draft
  says how many are ahead of it, and a draft untouched for 7 days is
  discarded.
- The Slack app needs the `files:read` and `files:write` scopes and the new
  `/helix` usage line: update it from
  `helix/deploy/slack/manifest.yaml` and reinstall it to the workspace.
- `after:` keeps waiting on an earlier spec that is not a valid spec, instead
  of failing the job. The waiting line names the file and why it could not be
  read, and the file is read again on every check.
- `npm run changelog` fails a branch that changes a shipped file without adding a
  line under Unreleased; this repo's profile runs it as a gate.

## 0.4.5 (2026-11-18)

- `after:` finds the earlier spec's pull request on GitHub, by the spec's
  title, when this machine's run log has no job for it, so a spec waiting on
  one that ran on Helix or another laptop starts once that PR is merged.
  While it finds none, it says the title it is looking for and how to stop
  waiting.
- The local display (`animus ui`) no longer links to people pages it does not
  have: no PEOPLE link, and `/people` says this display has none. It tags a
  job with its pull request (`PR #8`, `DRAFT PR #8`) linking to GitHub, and a
  job page says the job's output went to the terminal it ran in. On both
  displays, a job with no person or no line yet shows no empty separator or
  `>` line.
- The check-project test no longer fails under load: it read the check's log
  as soon as the project was ready, before the last line was written.

## 0.4.4 (2026-11-18)

- A Helix job for a repository whose GitHub App installation lacks Contents
  or Pull requests write is refused before it starts, saying what the app
  needs and who accepts it, instead of doing all its work and failing to open
  its pull request. `animus join` lists such projects apart from those the app
  does not reach. The app's logo is in `helix/deploy/github/`.

## 0.4.3 (2026-11-18)

- Helix no longer ends a running job's GitHub token. GitHub ends an access
  token the moment its refresh token is used, and Helix renewed before every
  job, project check, `helix check`, daily cleanup and display refresh, so a
  second job starting broke the first one's push ("Invalid username or
  token"). Helix now renews only in a token's last hour, keeps when it ends
  (`GH_TOKEN_EXPIRES` in the credentials file), and writes the current token
  to `~/.helix/tokens/<name>/gh-token`, mounted read-only into that person's
  jobs; git and Animus's `gh` calls read it each time, so a job outlives a
  renewal, and a job past eight hours can still push. `helix check` now tries
  the sign-in with GitHub instead of renewing it.

## 0.4.2 (2026-11-17)

- `lan_url` in Helix's `config.yaml`: the address on the office network.
  When it is set, `helix invite`, `animus invite` and the Slack bot's invite
  DM give a second join line with it, for joining with Tailscale off, beside
  the one at `url`.

## 0.4.1 (2026-11-17)

- A pull request that `gh` fails to open or update says why, instead of
  saying `gh` is not installed whenever it could not be run; "not installed"
  is kept for when it is not found. The test of opening a pull request no
  longer fails on a busy machine (it stopped 0.4.0 deploying to Helix).
- A Helix job cancelled in its first moments stays cancelled. Before, the job
  naming its Animus job just after the cancel put it back as running, so it
  could be cancelled again and then ended as failed.

## 0.4.0 (2026-11-17)

- A job catches up with its base before the push: when the base branch
  gained commits while the job ran and they merge cleanly, the job merges
  them in with one merge commit, runs every gate again with two fix rounds of
  its own, and the pull request names the base commit it caught up to. A
  failed job's draft pull request goes through the same catch-up. A base that
  did not move is left alone.
- A catch-up that conflicts goes to a fresh implementer session with the
  conflicting files, the spec and the base's commits that touched them. The
  job goes on only with no conflict markers left and every gate green within
  two fix rounds, and the pull request lists the resolved files. A conflict
  in a protected path, one the session cannot settle, or gates that still
  fail end the job as needs input; `animus resume <job> --answer` picks it up
  at the catch-up, not from the start.
- Helix keeps an activity, with who and when, each time a person submits,
  answers (with the answer's text) or cancels a job, joins, leaves, or adds or
  removes a project, and the day each new person joined. Nothing from before
  is filled in.
- `/people` on Helix's display lists each person with their GitHub login, the
  day they joined (blank before it was kept), jobs submitted, PRs opened,
  total spent and last activity, from a new authenticated route,
  `GET /people/page-data`. Every person named on the overview or a job page
  links to `/people/<name>`.
- `/people/<name>` shows that person's numbers, their jobs newest first thirty
  at a time, each linking to its job page (those from before activity was kept
  too), and their activity newest first, and says when they left, from a new
  authenticated route, `GET /people/<name>/page-data[?before=<job id>]`.
- `animus ui` serves the local display on 127.0.0.1 (port 7420 or the next
  free one) and opens it: every job in `~/.animus`, grouped by project, newest
  first, each with its job page, and no people pages or sign-in. Ctrl-C stops
  it. The display page tells its source apart by the new `local` flag on
  `Display`; `animus ui --helix` is unchanged. Not breaking: Helix's API and
  the job's files keep their shape.
- `animus run` records its process in the job's `progress.json` (`pid` and
  `host`, added to `stage`, `who` and `at`). A job counts as running only on
  that host with that process alive; one whose process is gone and that has no
  outcome is stopped, and the local display's reader of `~/.animus` shows it
  with `animus resume <job>` as the way on.
- With no job running or queued and no project picked, the display's overview
  shows an original synchronizing-helix animation (inline SVG and CSS only: the
  Helix mark unwinds into a slowly turning double helix, with glitch fragments
  and "SYNCHRONIZING") in place of the empty working box. It holds still when
  the browser asks for reduced motion, pauses while the tab is hidden and
  drifts slowly so nothing burns into a wall screen. A job that only waits for
  an answer does not keep it away.
- The display's overview lists the ten newest open PRs Helix's jobs opened
  (for the picked project when one is picked), drafts marked, in place of
  merged and closed ones. Helix lists a project's open PRs on GitHub with the
  token of the person whose job opened one, at most once a minute per project;
  a PR whose person has left is not listed. RECENT now keeps only failed and
  cancelled jobs. `GET /display` gains `prs`.
- The installers take `join <url> <code>`: after setup they run `animus join`
  with them, so one line installs Animus and joins a Helix
  (`curl -fsSL …/install.sh | bash -s -- join <url> <code>`).
- `helix slack setup` tries the Slack app's bot and app tokens against Slack,
  keeps them in `~/.helix/credentials/slack.env` and turns the bot on in
  `config.yaml` (`slack: {enabled, owner}`). A refused token is reported with
  Slack's reason and nothing is written.
- `helix github setup <client-id>` proves Helix's GitHub App's client ID with
  a device-code request and writes `github: {client_id}` to `config.yaml`. An
  ID GitHub refuses is reported with GitHub's reason and nothing is written.
- On a Helix with a GitHub App, `animus join` asks for no GitHub token: it
  shows GitHub's code, opens github.com/login/device and waits while Helix
  polls GitHub, then joins the person as the login that approved, keeping
  their access and refresh tokens in their credentials file. An invite with
  `--github` refuses any other login and its code stays usable. At the end
  the person is told which projects the app cannot reach for them, each with
  the app's installation link. With no `github:` entry, join is as before.
- **Breaking:** on a Helix with a GitHub App, `POST /join` takes
  `device_code` (from the new `POST /join/device`, which takes the invite's
  `code` and answers GitHub's `user_code` and `verification_uri`) instead of
  `github_token`, answers `202 {pending: true}` while GitHub has not been
  approved (the client asks again), and adds `unreachable: [{project, owner,
  install}]` to its answer. `POST /invite` answers `github_app: true` there.
- On a Helix with a GitHub App, each job, each project check and `helix
  check` first trade the person's refresh token for a fresh access token,
  keeping the new pair in their credentials file (mode 600); the job gets the
  access token as `GH_TOKEN` and never the refresh token. A job for a project
  the app cannot reach for the person fails before it starts with the app's
  installation link. A refresh GitHub refuses (revoked, or unused for six
  months) fails the job before it starts with "run `animus github login`",
  DMed to a person linked on Slack.
- `animus github login` runs GitHub's device flow again and Helix replaces the
  person's stored tokens; a login other than their own is refused.
- [helix/deploy/github/manifest.json](helix/deploy/github/manifest.json) is
  Helix's GitHub App, and [docs/helix-deploy.md](docs/helix-deploy.md) walks
  through creating it and running `helix github setup`.
- **Breaking:** new `POST /github/device` (answers GitHub's `device_code`,
  `user_code` and `verification_uri`) and `POST /github/login` (takes
  `device_code`, answers `202 {pending: true}` until GitHub is approved, then
  `{name, github}`; 403 for a login other than the person's, 409 on a Helix
  with no GitHub App).
- With `slack.enabled` in `config.yaml`, `helix serve` connects to Slack over
  Socket Mode: every envelope is acknowledged at once, and a socket Slack
  drops is replaced. With it off, Helix opens no connection to Slack.
- The Slack bot answers a Slack user with no Slack link, whatever they send,
  with a private "You're not on this Helix. Ask <owner> for an invite.", and
  keeps nothing. An invite may carry a Slack user, linked to the person when
  they join; the owner's `/helix link @user <person>` links someone who joined
  before. Leaving Helix, or `helix remove-person`, removes the link.
- The owner invites someone from Slack with `/helix invite @user
  <github-login>`, or on the machine with `helix invite <name> --github
  <login> --slack <member-id>`: the bot DMs them to connect Tailscale first,
  and one line that installs Animus and joins. An invite sent on Slack must
  name a GitHub login, and only the owner may send one.
- A linked person's Helix jobs, however submitted, post to them on Slack, one
  DM thread per job: started (or resumed), needs input with the question, the
  pull request's link, or failed with the reason. `/helix notify off` stops
  these for that person and `/helix notify on` starts them again; they are on
  by default.
- The Slack app's manifest is in `helix/deploy/slack/manifest.yaml`;
  docs/helix-deploy.md walks from creating the app to `helix slack setup`,
  and docs/helix.md describes the bot's commands.
- From Slack, `/helix jobs` lists a person's queued, running and waiting
  jobs with where to follow each, and `/helix status` says Helix's slots in
  use, the queue and its version, both privately. A person answers a job
  that needs input by replying in its thread (in a channel, with @Helix),
  and the thread's **Cancel job** button cancels it for its person or the
  owner. The manifest adds interactivity and the `app_mention` event for
  these.
- The planner is told what a slice costs: each one is a fresh session that
  reads the brief, the spec and the code before it writes, so it now cuts
  fewer, larger slices and folds a small addition into the slice it builds
  on. A large spec was cut into seven slices of two or three minutes each.
- Animus's own test commands (`npm test` and the specs' `$` lines, all run
  through `scripts/with-tmp.sh`) end a test that never settles after a
  minute, and no longer wait on a server a test left open. One such test
  held an implementer for eight minutes.
- Every job on Helix's display links to its own page, `/jobs/<id>`, which
  a person reads after signing in with their Helix token (pasted, or given
  in the address as `#token=…`). Its data comes from a new authenticated
  route, `GET /jobs/<id>/page-data`; `/display` is unchanged and still
  needs no token. `/people` and `/people/<name>` say they are coming.
- A job page shows the job's facts, its spec as submitted, its time in each
  stage and its slices, its latest checks with a failed one's output, the
  reviewer's findings, its questions and answers, and its log, which keeps
  to its end while the job runs. A gate run's file, `gates/run-<n>.txt`,
  now ends with all that each check printed.
- A job page shows the job's latest screenshots. Helix serves each, to a
  valid token only, at `GET /jobs/<id>/shots/<name>`, and only names the
  job's `shots/manifest.json` lists, never a file outside its shots folder.
- `animus ui --helix` opens the Helix this machine joined in the browser,
  already signed in with its token.

## 0.3.8 (2026-11-17)

- The installers and `animus setup` find Animus's marketplace by its GitHub
  repository, whatever it is called. Claude Code knows a marketplace by its
  source, so on a machine that had it as `animus`, adding `akstudios` added
  nothing and the install stopped ("no plugin/src/setup.ts at an unknown
  place"). Setup now moves it, and stops if the person keeps the old name.

## 0.3.7 (2026-11-17)

- `install.sh` no longer hides from setup that `~/.local/bin` is missing from
  the person's PATH, so setup offers to add it. `install.ps1` stops with an
  error instead of `exit`, which closed the PowerShell window it ran in.

- Cleanup keeps every job's record for analysis: `animus cleanup` no
  longer removes job folders after 14 days, or Claude Code's transcripts,
  and `helix cleanup` no longer removes Helix's job folders (`log.txt`).
  Only a job named to `animus cleanup` goes whole.
- A finished job's branches, `animus/<job>` and `animus-evidence/<job>`,
  stay 30 days after its pull request merged or closed (`--days`), instead
  of going at once; its worktree still goes at once.

## 0.3.6 (2026-11-17)

- The marketplace is now called `akstudios`, so the plugin is
  `animus@akstudios`; existing installs move once. `animus setup` removes the one called `animus` and
  its plugin; by hand, `claude plugin marketplace remove animus`, then add
  `akstudios/animus#stable` and install `animus@akstudios`. `animus doctor`
  warns while the old one is there.
- One command installs Animus: `install.sh` (macOS, Linux) and `install.ps1`
  (Windows) install git, Node 24 and Claude Code where missing, asking
  first, add the marketplace, and run `animus setup`.
- `animus setup`: `gh` installed and signed in, Claude Code signed in,
  Animus updating itself if the person agrees, Animus turned on in every
  project or in the checkouts they pick, and the `animus` command in
  `~/.local/bin`, which runs the newest installed copy of the plugin.
- `animus enable [<dir>]` turns Animus on in one more checkout, for that
  person only.

## 0.3.5 (2026-11-17)

- `helix cleanup` removes what finished jobs leave on a Helix machine, and
  `helix serve` runs it once a day: `animus cleanup` in each person's Animus
  home with their credentials, Helix's own folder of each job that ended over
  14 days ago (`--days`), and the job images of other releases.
- `animus cleanup` also removes the transcripts Claude Code kept of a job's
  sessions when it removes the job's folder, and keeps a job waiting for an
  answer unless it is named.
- The install cache is pruned whenever a job's worktree is removed: each
  install path keeps its two saves used last and any used in the last hour.
  Before, nothing pruned it.
- A UI target's serve command stops when the job that started it ends,
  however it ends: Ctrl-C, a crash, or Helix cancelling the job. Before, it
  ran on in its own process group.

- `setup.sh` no longer installs `helix-upgrade.timer`: Helix moves to a
  release only with `npm run deploy` or `helix upgrade`. 0.3.4's setup.sh
  installed it, but no machine ran that.

## 0.3.4 (2026-11-17)

- Helix follows the `stable` branch by itself. `helix upgrade --follow`
  moves the machine to the release `stable` is at when it is not already on
  it, and a systemd timer from `setup.sh` (`helix-upgrade.timer`) runs it
  every 15 minutes. A release that failed on the machine is not tried again
  on its own; each try is kept in `helix.db`. A second `helix upgrade` while
  one is under way is refused.
- `npm run deploy -- <ssh-host>` runs that upgrade over ssh now rather than
  at the timer's next run, and `npm run release -- <version> --deploy
  <ssh-host>` pushes the release and then deploys it.

- The README says only how to install and use Animus. Everything else is in
  `docs/`: a CLI reference, the spec format, configuration, architecture,
  releases and development. Helix's READMEs moved to `docs/helix.md` and
  `docs/helix-deploy.md`.

## 0.3.3 (2026-11-17)

- A person's own settings in `~/.animus/config.yaml` (`ANIMUS_HOME`), never in
  a repository: `run: local | helix` and `skills:` at the top for every
  repository, and under `repos:` for one (named `owner/repo`, by any form of
  its GitHub address, or by its folder). A personal skill is a SKILL.md and
  the roles it is for (implementer and planner unless named; the reviewer
  only when named) and optionally task types. Its text is copied into the
  job's folder (`skills.json`) when the job starts, put in each granted
  role's instructions, and logged as `personal:<name>@<hash>`.
- `animus start <spec.md> [--local | --helix]`: runs the job here or submits
  it to Helix. The flag decides, then the config, then Helix when this
  machine has joined one that has the repository. `/animus:to-spec` starts
  jobs with it and passes `--helix` or `--local` when the person asked for
  one in the conversation.
- `animus submit` sends the person's skills with the spec (`skills` on
  `POST /jobs`, answered with the names taken); Helix keeps them beside the
  spec and starts `animus run --skills <file>`. A job Helix starts reads no
  config on the machine. `animus doctor` checks the config and says what it
  sets for the repository; `animus plan` lists your skills by role.
- Projects people add themselves: `animus project add [<name>]` from a
  checkout puts its repository on Helix (`POST /projects`). Helix clones it
  with that person's GitHub token, checks the token may push, reads its
  profile and runs its installs and setup once, in the job image when jobs
  run in containers, before it takes it; the command waits and prints the
  check (`GET /projects/<name>`). `animus project list` (`GET /projects`) and
  `animus project remove <name>` (`DELETE /projects/<name>`, only whoever
  added it). GitHub is the member list: anyone whose token may push to a
  project may submit for it, and a job from someone whose token may not fails
  before it starts. A join no longer fails on a project the token may not
  push to; the person is told which. `animus submit` finds the project by the
  checkout's GitHub address. `helix remove-repo` deletes the clones people's
  jobs made of the project.
- A `helix` skill: asked in a Claude Code session to add, list or remove a
  project, or to submit, follow, answer or cancel a job on Helix, Claude runs
  the command and passes on what Helix said, including a refused remove.
- The README is shorter and says what is built; running the Helix machine is
  now in `helix/README.md`.
- People and projects are kept in `helix.db`, not `config.yaml`. The `people`
  and `repos` of an existing `config.yaml` are moved there, and out of the
  file, the first time a `helix` command runs. `helix serve` starts with no
  projects.

## 0.3.2 (2026-11-16)

- Inviting and joining: `helix invite <name> [--github <login>]` prints a
  one-time code that ends after 24 hours, and `animus join <url> <code>` on
  the person's laptop runs `animus doctor`, then `claude setup-token`, then
  opens GitHub's page for a fine-grained token with the permissions filled
  in, and sends both tokens with the code (`POST /invite`, `POST /join`).
  Helix tries them, as `helix check` does, before it takes the code, and
  keeps them in `~/.helix/credentials/<name>.env`. The Helix token comes back
  and is kept in `~/.animus/helix.json` (mode 600), which the client uses
  when `HELIX_URL` and `HELIX_TOKEN` are not set. `animus leave` (`POST
  /leave`) takes the person off as `helix remove-person` does. `url` in
  `config.yaml` puts the whole join command in what `helix invite` prints.
  `helix serve` now starts with nobody on it yet.

## 0.3.1 (2026-11-16)

- One interview skill: `/animus:grilling` is gone and `/animus:grill-with-docs`
  holds the interview itself, loading `domain-modeling` for the glossary and
  ADRs. Its size rule now says large work is one spec that the factory cuts
  into slices, where it used to say to cut it into medium specs.

- Each Helix job can run in a Docker container of its own: on when
  `config.yaml` has `container: {memory, cpus}`. A job sees only its
  submitter's folder under `~/.helix/people/` (their clone, job state and
  Claude config), Animus read-only and its spec, and only their credentials,
  passed by name. No Docker socket, no published port, all capabilities
  dropped. `helix image` builds the image (`animus-job:<version>`) and
  `helix upgrade` rebuilds it. `helix remove-person` also deletes the
  person's folder and removes their containers.
- setup.sh step 8 adds Helix's account to the docker group.

## 0.3.0 (2026-11-16)

- **Breaking:** the client sends its version to Helix, and Helix refuses one it
  cannot work with (HTTP 426, with how to update). A client from before this
  release sends none and is refused: update the plugin.
- `animus doctor`: checks Node, Claude Code (2.1.322 or later), git, gh, the
  repo's profile, Helix and its version, orbit's old plugin of the same name,
  and git hooks or commit signing that would reach a job's commits.
- Job sessions start no MCP server, not even one the person added for
  themselves (`--strict-mcp-config`).
- Helix: `helix remove-person` (token off, jobs cancelled, credentials file
  deleted, a checklist of the rest), `helix remove-repo`, and `helix upgrade
  <tag>` (drain, check out, install, test, restart, or go back). People,
  repositories and slots are read again when `config.yaml` changes, with no
  restart. A job whose person or repository was removed fails instead of
  running.
- Releases: `npm run release -- <version>` tags a release and moves the `stable`
  branch, which teammates' Claude Code follows.
- setup.sh: Helix's service runs with Claude Code's auto-update off.
