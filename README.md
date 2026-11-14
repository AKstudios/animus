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

From a Claude Code session with the plugin installed, you talk and the factory does the rest. `/animus:grill-with-docs` (or `/animus:grilling`) interviews you, `/animus:to-spec` writes the spec, checks it and starts the job in the background. The session has to stay open until the job ends: compacting is fine, closing or clearing it stops the job. All of a job's state is in files, so one that was cut off is picked up with `animus resume <job>`. A design too large for one job becomes several specs, each its own job and PR. No agent breaks a spec down mid-run.

| Command | What it does |
| --- | --- |
| `animus run <spec.md> [--dry-run] [--draft] [--keep]` | One job, spec to PR. `--dry-run` stops before the push; `--draft` opens the PR as a draft. |
| `animus plan <spec.md>` | Validates a spec and prints its stages and models. Starts nothing. |
| `animus resume <job> [--answer <text>]` | Picks up a job that asked a question or was interrupted, in the same session. |
| `animus runs [-n <count>] [--json]` | The run log. |
| `animus outcomes [--json]` | What became of each PR, read from GitHub and kept in `~/.animus/outcomes.json`: merged or closed, time to merge, human commits, reverted or reworked within 30 days. Prints the five numbers split by task class. |
| `animus cleanup [<job>...] [--days <n>] [--dry-run]` | Removes what finished jobs left behind: the branches (local and on origin) and worktree of a job whose PR merged or closed, and a job's folder 14 days after its last run. A job with an open PR is kept. A named job does not wait. |
| `animus skills` | The vendored skills, where each came from, and which role gets it. |
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
5. **Evidence.** The last gate run's output is each criterion's proof. A UI job, and any job that changed files under a UI target's `paths`, also gets screenshots of the running app.
6. **PR.** The branch is pushed and the PR opened, its body built by script from what the job recorded, so every PR has the same sections: Review here, Acceptance criteria, the evidence, Screenshots when there are any, Follow-ups, Run. Screenshots go on a branch of their own (`animus-evidence/<job>`) and show as images in the body. A job that fails after its fix rounds opens a draft with the failure report.

A job that cannot proceed stops as `needs-input` with one question. `animus resume <job> --answer "..."` continues it.

## Task profiles

[plugin/config/profiles.yaml](plugin/config/profiles.yaml) is the one file that decides what a job runs. Size picks the stages, difficulty picks the tier and effort, type adds a gate, a reviewer or evidence. A `bug` job gets the `tdd` skill and one more gate: the spec's acceptance commands run on the base commit with only the job's test files added, and one must fail there. Profiles name a tier (fast, standard, deep), and one map turns tiers into models. The implementer may raise a job's size or difficulty and never lower it.

## Skills

An agent has the skills its role is granted and no others. A skill reaches a role as text in its instructions, copied from `plugin/vendor/`, where each one sits at a commit recorded in `plugin/vendor/sources.yaml`. Nothing is fetched while a job runs. Job sessions have no Skill tool and no slash commands, so Claude Code's built-in skills and your own are out of reach.

| Skill | Given to | What it gets |
| --- | --- | --- |
| [ponytail](https://github.com/dietrichgebert/ponytail) | implementer, every job | The whole skill: the smallest change that fully solves the task |
| useful-tests (yours, from orbit) | implementer, every job | The whole skill: fewer tests, each one justified |
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
| `skills/grilling`, `skills/to-spec` | the same skills | They end in a spec file with labels, not an epic |
| `src/skills.ts`, `vendor/` | the old Orbit's `lib/skills.ts` and `skills/vendor/` | Same idea: pinned copies, granted per role, put in the role's prompt |

Left behind: Beads, epics, tickets and waves, the Workflow script, the test-writer stage, the stop and guard hooks, land, the view, retro and the eval.

## Not built yet

- Types marked `later` in the profiles file: refactor, upgrade, migration, performance, docs, tests, investigation.
- Services for a job (database, storage). The plan records the setup level, but a local job only runs the profile's installs and `setup`.
- Running a job apart from the session that started it. Closing the session stops the job; `animus resume <job>` continues it. Helix is where jobs will outlive a session.
- `animus init`. A new repo's profile is written by hand.
- Steps 3 to 7 of the build order: containers, Helix, the issue and Slack triggers, a second submitter.

## Develop

```sh
npm test            # node:test, a scripted fake agent, no model calls
npm run typecheck
```
