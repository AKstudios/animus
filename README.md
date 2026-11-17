# Animus

A spec goes in and a pull request comes out, with evidence for each acceptance criterion. Scripts set up the workspace, run the gates and open the PR. One agent implements and a fresh one reviews. You merge.

The design is [docs/factory.md](docs/factory.md); what is built and what is next is [docs/handoff.md](docs/handoff.md). Jobs run on your own machine, or on Helix, a shared machine that runs them for a team ([helix/README.md](helix/README.md)).

## Getting started

You need [Claude Code](https://code.claude.com) signed in, Node 24, git, read access to this repository, and for local jobs the GitHub CLI `gh` signed in. It runs on macOS, Linux and Windows (through Git Bash, which Claude Code already uses, or WSL).

```sh
claude plugin marketplace add AKstudios/animus#stable
claude plugin install animus@animus
```

Then ask Claude Code to run `animus doctor`, which lists anything missing. Inside Claude Code `animus` is on the PATH; for your own terminal, clone the `stable` branch, run `npm ci --prefix plugin` in it, and put its `plugin/bin` on your PATH.

### On your machine

1. In the target repository, run `animus init` once. It drafts `.animus/animus.yaml`, the setup and gate commands. Check it and commit it.
2. Run `/animus:grill-with-docs` and describe what you want. It asks questions until the design is clear, then writes the spec and starts the job (`/animus:to-spec` does that step alone). Keep the session open until the job ends.
3. Review and merge the PR.

Asking Claude Code to build something without mentioning Animus does the work in your session as usual; no job runs.

### On Helix

Jobs run on the shared machine, so your laptop can close. The PR still opens as you.

1. Ask whoever runs Helix for an invite, and run the `animus join <url> <code>` it gives you. It has you make a Claude token and a GitHub token and sends both to Helix.
2. Ask Claude to add your repository to Helix if it is not there yet (`animus project add` from a checkout of it). Helix checks it first, which takes a few minutes.
3. Write a spec and ask Claude to submit it (`animus submit spec.md`). `/animus:to-spec` starts the job on your own machine, so ask it to write the spec without running it.
4. Ask Claude how the job is going, or watch Helix's page at its address. If the job asks a question, Claude passes your answer on.

Anyone on Helix whose GitHub token may push to a project may submit for it. Only whoever added a project can remove it. `animus leave` takes you off Helix and deletes your tokens there.

## Commands

| Command | What it does |
| --- | --- |
| `animus run <spec.md> [--dry-run] [--draft] [--keep]` | One job, spec to PR, from inside the repo. |
| `animus plan <spec.md> [--slices]` | Checks a spec and prints what would run; `--slices` also shows how the planner would cut it. |
| `animus init [--force]` | Drafts `.animus/animus.yaml` from `package.json`, `pyproject.toml`, `go.mod` or `Cargo.toml`. |
| `animus resume <job> [--answer <text>]` | Picks up a job that asked a question or was interrupted. |
| `animus runs`, `animus outcomes` | The run log; what became of each PR, with the five numbers by task class. |
| `animus cleanup [<job>...] [--days <n>]` | Removes the branches and worktrees of finished jobs. |
| `animus doctor`, `animus skills` | Whether this machine can run and submit jobs; the vendored skills. |
| `animus join <url> <code>`, `animus leave` | Get on and off a Helix. |
| `animus project add [<name>] \| list \| remove <name>` | The projects on Helix. |
| `animus submit <spec.md> [--draft]` | Queues a spec on Helix for this checkout's project. |
| `animus status [<id>]`, `result <id>`, `answer <id> <text>`, `cancel <id>` | Follow and steer jobs on Helix. |

In a Claude Code session you rarely type these: the plugin's skills run them when you ask.

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

Each list item under "Acceptance criteria" is one criterion, and a `$ command` under it is its check: Animus runs it as a gate and puts the output in the PR. A criterion with no command is judged by the reviewer alone. A `ui` spec may add `ui: { target, pages }` and `design: [files]`. `after: <spec.md>` in the header makes the job wait until that spec's PR is merged.

## What a job does

1. **Set up.** A worktree on branch `animus/<job>` from `origin/<base>`, with the profile's installs and `setup`.
2. **Plan.** A medium or large spec is cut into slices: a read-only session proposes the cut and a script takes or refuses it.
3. **Implement.** One fresh session per slice, in order. The gates for the criteria so far run between slices, and failures go back to that slice's session.
4. **Gates.** The profile's commands, then every criterion's command. Failures go back, one model tier up, at most twice. A session that ends over the context budget is replaced by a fresh one with a handoff.
5. **Review.** A fresh read-only session judges each criterion from the spec and the diff. Blockers go back once.
6. **Evidence and PR.** Each criterion's proof is the last gate output, plus screenshots for UI work. The PR body is built by script. A job that fails after its fix rounds opens a draft with the failure report.

A job that cannot proceed stops with one question; `animus resume <job> --answer "..."` continues it. Every run appends a line to `~/.animus/runs.jsonl`, and `~/.animus/jobs/<job>/` keeps its spec, gate output, reviews, PR body, screenshots and transcripts.

## Configuration

`.animus/animus.yaml` in the target repo:

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

[plugin/config/profiles.yaml](plugin/config/profiles.yaml) decides what a job runs: size picks the stages, difficulty the model tier and effort, and type adds a gate, a reviewer or evidence. A `bug` job must show a test that fails on the base commit.

Agents get only the skills their role is granted there, copied into their instructions from `plugin/vendor/` at a commit in `plugin/vendor/sources.yaml`: ponytail and useful-tests for every implementer, to-tickets for the planner, impeccable for UI work. Job sessions have no Skill tool, and nothing is fetched while a job runs. To take a newer commit of a skill, read the upstream diff, change `sources.yaml`, run `scripts/vendor-skill.sh <name>`, and replay a few past specs.

## Releases

The version is in `plugin/.claude-plugin/plugin.json`; the plugin and Helix ship from the same tag. `npm run release -- <version>` cuts one from a clean main: it needs `CHANGELOG.md`'s Unreleased section filled in, runs the tests and typecheck, tags `v<version>` and moves `stable`. A release that breaks the HTTP API, a spec, a profile or a job's files bumps the minor version (before 1.0) and needs `--breaking`; Helix then refuses older clients with how to update.

To have Claude Code offer Animus in a team repository and keep it on the latest release, put this in its `.claude/settings.json`:

```json
{
  "extraKnownMarketplaces": {
    "animus": { "source": { "source": "github", "repo": "AKstudios/animus", "ref": "stable" }, "autoUpdate": true }
  },
  "enabledPlugins": { "animus@animus": true }
}
```

## From orbit

This replaces orbit (`../orbit`), whose plugin was also called Animus. What came from it:

| Here | From orbit's `plugin/` | Changed |
| --- | --- | --- |
| `src/proc.ts`, `src/installs.ts` | the same files | Unchanged, apart from dropping the per-wave cache warm-up |
| `src/profile.ts` | `profile.ts` | Epic-only keys dropped (still accepted and ignored); `checks` takes any task type |
| `src/gates.ts` | `checks.ts` | Tickets and touches removed; acceptance commands carry their criterion |
| `src/ui.ts` | `ui.ts` | Target and pages come from the spec header, not ticket labels |
| `src/workspace.ts` | `ensureSetup`, `branches.ts` | One worktree per job instead of one per stage |
| `src/review.ts`, `prompts/` | `REVIEW_SCHEMA`, `agents/*.md` | A verdict per criterion added; agents are prompt files |
| `src/pr.ts` | `pr.ts` | Body built from the run, not from Beads |
| `skills/grill-with-docs`, `skills/to-spec` | the same skills | They end in a spec file with labels, not an epic |
| `src/skills.ts`, `vendor/` | `lib/skills.ts`, `skills/vendor/` | Same idea: pinned copies, granted per role |

Left behind: Beads, epics, tickets and waves, the Workflow script, the test-writer stage, the stop and guard hooks, land, the view, retro and the eval.

## Develop

```sh
npm ci && npm ci --prefix plugin
npm test            # node:test, a scripted fake agent, no model calls
npm run typecheck
```
