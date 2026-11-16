# Animus

A spec goes in and a pull request comes out, with evidence for each acceptance criterion. Scripts set up the workspace, run the gates and open the PR. One agent implements and a fresh one reviews. You merge.

The design is [docs/factory.md](docs/factory.md). This repo has the local half of it: `animus run spec.md` on a laptop, the run log, and task profiles. Office mode (Helix, containers, Slack and issue triggers) is not built.

## Run a job

```sh
npm ci && npm ci --prefix plugin
plugin/bin/animus plan path/to/spec.md     # checks the spec, prints what would run
plugin/bin/animus run path/to/spec.md      # from inside the target repo
```

`run` prints progress on stderr and a JSON result on stdout. It needs `claude`, `git` and `gh` on PATH, Node 24, and a `.animus/animus.yaml` in the target repo.

From a Claude Code session with the plugin installed, you talk and the factory does the rest. `/animus:grill-with-docs` interviews you and writes the glossary and ADRs as it goes, `/animus:to-spec` writes the spec, checks it and starts the job in the background. The session has to stay open until the job ends: compacting is fine, closing or clearing it stops the job. All of a job's state is in files, so one that was cut off is picked up with `animus resume <job>`. A large design is still one spec and one PR: the factory cuts it into slices and does each in a fresh session.

| Command | What it does |
| --- | --- |
| `animus run <spec.md> [--dry-run] [--draft] [--keep]` | One job, spec to PR. `--dry-run` stops before the push; `--draft` opens the PR as a draft. |
| `animus plan <spec.md>` | Validates a spec and prints its stages and models. Starts nothing. |
| `animus plan <spec.md> --slices` | Also asks the planner how it would cut the spec into slices (one read-only session in the repo) and prints the plan the script took. A small or trivial spec is one slice, with no session. |
| `animus init [--force]` | Drafts `.animus/animus.yaml` from the repo's `package.json`, `pyproject.toml`, `go.mod` or `Cargo.toml`: the install as setup, the scripts as gates, a UI target for a vite or next app. Runs nothing, and lists what it could not find. |
| `animus resume <job> [--answer <text>]` | Picks up a job that asked a question or was interrupted, in the same session. |
| `animus runs [-n <count>] [--json]` | The run log. |
| `animus outcomes [--json]` | What became of each PR, read from GitHub and kept in `~/.animus/outcomes.json`: merged or closed, time to merge, human commits, reverted or reworked within 30 days. Prints the five numbers split by task class. |
| `animus cleanup [<job>...] [--days <n>] [--dry-run]` | Removes what finished jobs left behind: the branches (local and on origin) and worktree of a job whose PR merged or closed, and a job's folder 14 days after its last run. A job with an open PR is kept. A named job does not wait. |
| `animus skills` | The vendored skills, where each came from, and which role gets it. |
| `animus doctor` | Whether this machine can run and submit jobs: Node, Claude Code, git, gh, the repo's profile, Helix and its version, and what of your own setup reaches a job (orbit's old plugin of the same name, git hooks, commit signing). Exits 1 if something would stop a job. |
| `animus check`, `animus shots`, `animus ui up\|down` | For the implementer, inside a job's worktree. |

## Releases

The version is the one in `plugin/.claude-plugin/plugin.json`; the plugin and
Helix ship from the same tag. `npm run release -- <version>` cuts one from a
clean main that matches origin: it needs `CHANGELOG.md`'s Unreleased section
filled in, runs the tests and the typecheck, sets the version, commits, tags
`v<version>` and moves the `stable` branch there. It prints the push.

A release that breaks the HTTP API, a spec, a profile or a job's files bumps
the minor version before 1.0 (the major after) and needs `--breaking`. Helix
refuses a client it cannot work with, saying how to update, so upgrade Helix
and tell the team together.

The team follows `stable`, not `main`. Put this in each team repository's
`.claude/settings.json` (or in managed settings), and Claude Code offers
Animus when they open it and keeps it on the latest release:

```json
{
  "extraKnownMarketplaces": {
    "animus": { "source": { "source": "github", "repo": "AKstudios/animus", "ref": "stable" }, "autoUpdate": true }
  },
  "enabledPlugins": { "animus@animus": true }
}
```

They need read access to the repository on GitHub. `animus doctor` then says
what is missing on their machine. Orbit's plugin had the same name from a
marketplace of the same name; doctor says so if it is still registered.

## Helix

[helix/](helix/) is the supervisor for a machine that runs jobs for several people (docs/factory.md, "The office machine"). It is not part of the plugin and is not installed with it. It keeps a queue in one SQLite table, starts each job as its own `animus run` process while slots are free, and answers five actions over HTTP.

On the machine, with its files under `~/.helix` (`HELIX_HOME`):

```sh
helix/bin/helix add-repo meal-planner /srv/repos/meal-planner   # a clone with a .animus/animus.yaml
helix/bin/helix add-person ajmal --env-file /srv/helix/ajmal.env   # prints their token once
helix/bin/helix check          # each person's credentials, tried against GitHub and Claude
helix/bin/helix serve
helix/bin/helix remove-person ajmal     # token off, their jobs cancelled, their credentials file deleted
helix/bin/helix remove-repo meal-planner
helix/bin/helix upgrade v0.3.0          # drain, check out the release, install, test, restart
```

Helix reads `config.yaml` again whenever it changes, so adding or removing a
person or a repository, or changing the slots, needs no restart. Someone
leaving is `helix remove-person`, which prints what is left to revoke
elsewhere. `helix upgrade` stops starting jobs, waits for the running ones,
checks out the tag and runs the tests; if they fail it goes back. It then
stops `helix serve` for its service manager to start again. Moving Helix to
another machine is [helix/deploy/README.md](helix/deploy/README.md).

`config.yaml` there sets `host` (default 127.0.0.1; set it to the machine's address on your private network, never a public one), `port` (7420) and `slots` (2). A person's `--env-file` holds `KEY=VALUE` lines set for their jobs only, such as `CLAUDE_CODE_OAUTH_TOKEN` and `GH_TOKEN`, so the PR appears as them. Without one, their jobs use the machine's own logins. With a `GH_TOKEN`, git uses that token for https remotes for the job's processes only, so clone the repositories over https.

`helix check [<name>]` asks the services themselves: who GitHub says the token is and when it ends, whether it may push to each repository (a push that sends nothing), and whether the Claude token answers, in one small session that has no login kept on the machine to fall back on. It exits 1 if anything fails. `helix serve` runs the GitHub part when it starts and again before each job, so a token that ended fails the job at once with the reason.

To keep Helix running with nobody signed in, [helix/deploy/ubuntu/setup.sh](helix/deploy/ubuntu/setup.sh) sets up an Ubuntu machine: an account for Helix, Node 24, no sleep, and a systemd unit that starts at boot and is started again whenever it stops. `finish.sh` beside it removes the account the machine was set up from. Helix itself needs none of this: on another system, anything that runs `helix serve` at boot and restarts it does the same job. With Tailscale, leave `host` at 127.0.0.1 and run `tailscale serve --bg 7420` once: the tailnet reaches Helix over https and the setting outlasts restarts.

Helix also serves a display at its own address (`http://127.0.0.1:7420/`, or the tailnet address). It shows the slots, the agents working now with each job's stage, the queue, the jobs that wait for an answer, and the jobs that ended. It needs no sign-in: anyone who can reach Helix's address can see it, so keep that address on a private network. Submitting, answering and cancelling still need a person's token. The display only reads, so answering and cancelling stay with the commands below. Click a project to narrow the page to it. The page follows the system's light or dark theme, and `?theme=dark` or `?theme=light` fixes one. Set `name` in `config.yaml` to change what the display calls the machine (default: its hostname).

From a laptop, with `HELIX_URL` and `HELIX_TOKEN` set:

| Command | What it does |
| --- | --- |
| `animus submit <spec.md> [--draft]` | Queues the spec for the repository named like this checkout's folder. |
| `animus status [<id>]` | The queue, or one job with the end of its log. |
| `animus result <id>` | One job as JSON; exits 0 once it ended in a PR. |
| `animus answer <id> <text>` | Answers a job that stopped with a question; it is queued again and resumes. |
| `animus cancel <id>` | Ends a queued or running job. Only its submitter can. |

A job that was running when Helix stopped or died is queued again when it comes back, and resumes from its own files. One found running three times is ended as failed instead, since it may be what takes Helix down. Jobs run in worktrees on the machine, with no containers yet, so they share its tools, ports and network. Traffic is plain HTTP: keep it on a private network such as Tailscale. A spec with `after:` cannot wait on a spec submitted separately, because Helix keeps each submitted spec under its own job folder.

## The spec

```markdown
---
size: small          # trivial | small | medium | large (medium and large are cut into slices)
difficulty: routine  # routine | hard | risky
type: feature        # feature | backend | ui
---
# Sort the shopping list by aisle

## Acceptance criteria

1. Items are grouped under their aisle.
   $ npx vitest run src/lib/shopping.test.js
2. An empty list shows a hint.
```

Each list item under "Acceptance criteria" is one criterion. A `$ command` line under it is its check. Animus runs it as a gate and puts the output in the PR. A criterion with no command is judged by the reviewer alone, and the PR says so. A `ui` spec may add `ui: { target, pages }` and `design: [files]`. A spec that builds on another names it with `after: <spec.md>` in the header: its job waits until that spec's PR is merged, checking once a minute, and then starts from the updated base. It stops if that PR is closed unmerged.

## What a job does

1. **Set up.** A worktree at `../.worktrees/<repo>/<job>` on branch `animus/<job>`, started from `origin/<base>`. The profile's installs are cloned from a cache, then its `setup` runs.
2. **Plan.** A medium or large spec is cut into slices first: a read-only session proposes the cut and a script takes or refuses it (`animus plan --slices` shows the same thing). A small or trivial spec is one slice, with no session. If the cut is refused twice a medium job runs as one slice and a large one fails.
3. **Implement.** One session per slice, in order, on the job's branch. Each is fresh: it gets its slice, the criteria that slice finishes, a line on the slices before and after it, the planner's brief and the spec. It writes the code and its tests and commits at each step. Before the next slice starts, the gates run with the acceptance commands of the slices so far, and failures go back to that slice's session, at most twice. A job of one slice is one session, as before.
4. **Gates.** On the finished branch: the profile's commands for the type, then every criterion's command. Failures go back to the same session, one model tier up, at most twice.

   Sessions are kept short. After each one, Animus reads from its transcript how full its context was. A session that ended over `limits.context_budget` in `profiles.yaml` (100k tokens) is not resumed for the next round: a fresh one starts with the job's brief, where to read the work so far, and the round's own ask. While a session runs, its context is compacted at `context_cap` (160k), and it may spend at most `session_usd` for its tier.
5. **Review.** A fresh read-only session gets the spec and the diff, and answers with a verdict per criterion and graded findings. Blockers go back once, the gates run again, and a second review settles it. A UI job's reviewer also gets screenshots a script took of the running app.
6. **Evidence.** The last gate run's output is each criterion's proof. A UI job, and any job that changed files under a UI target's `paths`, also gets screenshots of the running app.
7. **PR.** The branch is pushed and the PR opened, its body built by script from what the job recorded, so every PR has the same sections: the slices when there was more than one, Review here, Acceptance criteria, the evidence, Screenshots when there are any, Follow-ups, Run. Screenshots go on a branch of their own (`animus-evidence/<job>`) and show as images in the body. A job that fails after its fix rounds opens a draft with the failure report.

A job that cannot proceed stops as `needs-input` with one question. `animus resume <job> --answer "..."` continues it.

## Task profiles

[plugin/config/profiles.yaml](plugin/config/profiles.yaml) is the one file that decides what a job runs. Size picks the stages, difficulty picks the tier and effort, type adds a gate, a reviewer or evidence. A `bug` job gets the `tdd` skill and one more gate: the spec's acceptance commands run on the base commit with only the job's test files added, and one must fail there. Profiles name a tier (fast, standard, deep), and one map turns tiers into models. The implementer may raise a job's size or difficulty and never lower it.

## Skills

An agent has the skills its role is granted and no others. A skill reaches a role as text in its instructions, copied from `plugin/vendor/`, where each one sits at a commit recorded in `plugin/vendor/sources.yaml`. Nothing is fetched while a job runs. Job sessions have no Skill tool and no slash commands, so Claude Code's built-in skills and your own are out of reach.

| Skill | Given to | What it gets |
| --- | --- | --- |
| [ponytail](https://github.com/dietrichgebert/ponytail) | implementer, every job | The whole skill: the smallest change that fully solves the task |
| useful-tests (yours, from orbit) | implementer, every job | The whole skill: fewer tests, each one justified |
| to-tickets ([mattpocock/skills](https://github.com/mattpocock/skills)) | planner, medium and large specs | Its cutting rules: tracer-bullet slices, each sized for one fresh context window, prefactoring first. Its tracker and its quiz are left out: a script checks the plan instead (`src/slices.ts`) |
| [impeccable](https://github.com/pbakaus/impeccable) | implementer, UI jobs | The skill, with its reference files to read on demand |
| impeccable | ui-reviewer, UI jobs | Only its quality floor, as a checklist |
| none | reviewer | |

The `skills:` block of `plugin/config/profiles.yaml` holds these grants. `plugin/vendor/<skill>.<role>.md` is Animus's note on how the skill applies with nobody there to answer. Impeccable's launcher is left out, because it downloads a prebuilt binary on first run. The skill's own "launcher unavailable" path is used.

The target repo's own skills (`.claude/skills/`) are listed for every role by file path, to read when one applies.

To take a newer commit of a skill: read the upstream diff, change the commit in `sources.yaml`, run `scripts/vendor-skill.sh <name>`, and replay a few past specs with and without it.

On a laptop, your global `~/.claude/CLAUDE.md` and rules still load into job sessions. Claude Code has no flag that drops them and keeps the subscription login. The prompts tell agents to load no skill from there. A container has no such file.

## The run log

Every run appends one JSON line to `~/.animus/runs.jsonl`: job, repo, submitter, trigger, labels, factory version, time per stage, each agent call with its model, tokens and cost, each gate run, fix rounds, review findings and how many were acted on, and the outcome with its reason. `~/.animus/jobs/<job>/` keeps the spec, the gate output, the reviews, the PR body, the screenshots and a copy of each transcript.

## The project's profile

`.animus/animus.yaml` in the target repo, in orbit's format:

```yaml
setup: npm ci                      # run once in each job's worktree
commands:                          # the gates, in order
  test: npm test
  lint: { run: npm run lint, paths: [src/**], affected: npx eslint $ANIMUS_CHANGED }
checks: { ui: [test] }             # a type not listed runs every command
base: main
protected: [.github/**]            # a change here is flagged at the top of the PR
notes: What an unattended agent should know about this project.
ui:
  targets:
    app: { serve: "npm run dev -- --port $PORT", url: "http://127.0.0.1:$PORT", pages: { home: / } }
```

Keys only orbit's epics used (`commits`, `max_parallel`, `review`, `outside_touches`, `teardown`) are accepted and ignored.

## From orbit

| Here | From orbit's `plugin/` | Changed |
| --- | --- | --- |
| `src/proc.ts`, `src/installs.ts` | the same files | Unchanged, apart from dropping the per-wave cache warm-up |
| `src/profile.ts` | `profile.ts` | Epic-only keys dropped; `checks` takes any task type |
| `src/gates.ts` | `checks.ts` | Tickets and touches removed; acceptance commands carry their criterion |
| `src/ui.ts` | `ui.ts` | Target and pages come from the spec header, not ticket labels |
| `src/workspace.ts` | `ensureSetup`, `branches.ts` | One worktree per job instead of one per stage |
| `src/review.ts`, `prompts/` | `REVIEW_SCHEMA`, `agents/*.md` | A verdict per criterion added; agents are prompt files, so no stage depends on the plugin being installed |
| `src/pr.ts` | `pr.ts` | Body built from the run, not from Beads |
| `skills/grill-with-docs`, `skills/to-spec` | the same skills | They end in a spec file with labels, not an epic |
| `src/skills.ts`, `vendor/` | the old Orbit's `lib/skills.ts` and `skills/vendor/` | Same idea: pinned copies, granted per role, put in the role's prompt |

Left behind: Beads, epics, tickets and waves, the Workflow script, the test-writer stage, the stop and guard hooks, land, the view, retro and the eval.

## Not built yet

- Types marked `later` in the profiles file: refactor, upgrade, migration, performance, docs, tests, investigation.
- Services for a job (database, storage). The plan records the setup level, but a local job only runs the profile's installs and `setup`.
- Containers: on Helix a job still runs in a worktree on the machine itself.
- Steps 3 and 5 to 7 of the build order: containers, the issue and Slack triggers, a second submitter tried for real.

## Develop

```sh
npm test            # node:test, a scripted fake agent, no model calls
npm run typecheck
```
