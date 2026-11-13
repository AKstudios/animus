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

From a Claude Code session with the plugin installed, `/animus:grilling` interviews you, `/animus:to-spec` writes the spec, and `/animus:run <spec>` starts the job.

| Command | What it does |
| --- | --- |
| `animus run <spec.md> [--dry-run] [--keep]` | One job, spec to PR. `--dry-run` stops before the push. |
| `animus plan <spec.md>` | Validates a spec and prints its stages and models. Starts nothing. |
| `animus resume <job> [--answer <text>]` | Picks up a job that asked a question or was interrupted, in the same session. |
| `animus runs [-n <count>] [--json]` | The run log. |
| `animus check`, `animus shots`, `animus ui up\|down` | For the implementer, inside a job's worktree. |

## The spec

```markdown
---
size: small          # trivial | small | medium (large is refused)
difficulty: routine  # routine | hard | risky
type: feature        # feature | backend | ui
---
# Sort the shopping list by aisle

## Acceptance criteria

1. Items are grouped under their aisle.
   $ npx vitest run src/lib/shopping.test.js
2. An empty list shows a hint.
```

Each list item under "Acceptance criteria" is one criterion. A `$ command` line under it is its check. Animus runs it as a gate and puts the output in the PR. A criterion with no command is judged by the reviewer alone, and the PR says so. A `ui` spec may add `ui: { target, pages }` and `design: [files]`.

## What a job does

1. **Set up.** A worktree at `../.worktrees/<repo>/<job>` on branch `animus/<job>`, started from `origin/<base>`. The profile's installs are cloned from a cache, then its `setup` runs.
2. **Implement.** One session plans, writes the code and its tests, and commits at each step.
3. **Gates.** The profile's commands for the type, then every criterion's command. Failures go back to the same session, one model tier up, at most twice.
4. **Review.** A fresh read-only session gets the spec and the diff, and answers with a verdict per criterion and graded findings. Blockers go back once, the gates run again, and a second review settles it. A UI job's reviewer also gets screenshots a script took of the running app.
5. **PR.** The branch is pushed and the PR opened, its body built from what the job recorded. A job that fails after its fix rounds opens a draft with the failure report.

A job that cannot proceed stops as `needs-input` with one question. `animus resume <job> --answer "..."` continues it.

## Task profiles

[plugin/config/profiles.yaml](plugin/config/profiles.yaml) is the one file that decides what a job runs. Size picks the stages, difficulty picks the tier and effort, type adds a reviewer or evidence. Profiles name a tier (fast, standard, deep), and one map turns tiers into models. The implementer may raise a job's size or difficulty and never lower it.

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
| `skills/grilling`, `skills/to-spec` | the same skills | They end in a spec file with labels, not an epic |

Left behind: Beads, epics, tickets and waves, the Workflow script, the test-writer stage, the stop and guard hooks, land, the view, retro and the eval.

## Not built yet

- The outcome fields filled later from GitHub (merged, time to merge, human commits, reverts).
- Types marked `later` in the profiles file: bug, refactor, upgrade, migration, performance, docs, tests, investigation.
- Services for a job (database, storage). The plan records the setup level, but a local job only runs the profile's installs and `setup`.
- Screenshots in the PR itself. They are saved in the job's folder and listed in the PR.
- `animus init`. A new repo's profile is written by hand.
- Steps 3 to 7 of the build order: containers, Helix, the issue and Slack triggers, a second submitter.

## Develop

```sh
npm test            # node:test, a scripted fake agent, no model calls
npm run typecheck
```
