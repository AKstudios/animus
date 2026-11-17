# Architecture

How Animus is put together and what happens when a job runs. Why it is built
this way is in [factory.md](factory.md).

## The pieces

```
you, in Claude Code
  │  /animus:grill-with-docs, /animus:to-spec   (plugin/skills/)
  ▼
spec.md ──► animus start ──┬─► animus run  (this machine, in the foreground)
                           │
                           └─► animus submit ──HTTP──► Helix  (helix/)
                                                         │ queue in helix.db
                                                         ▼
                                                  animus run  (one process per job,
                                                               in a container when set)
                                                         │
                                                         ▼
                                              branch animus/<job> + pull request
```

- **The plugin** (`plugin/`) is what a developer installs in Claude Code:
  the skills that shape a spec, and the `animus` command that runs a job.
- **Helix** (`helix/`) is the supervisor for a shared machine: a queue in
  SQLite, an HTTP API, a display page, and one `animus run` process per job.
  It imports from `plugin/src` and is never shipped in the plugin. It holds no
  state of its own beyond `helix.db` and the job files, so a restart carries
  on from them. See [helix.md](helix.md).

Both run the same pipeline, so anything that works on a laptop works on
Helix.

## What a job does

1. **Set up.** A worktree on branch `animus/<job>` from `origin/<base>`, with
   the profile's installs (cached by lockfile) and `setup`.
2. **Plan.** A medium or large spec is cut into slices. A read-only planner
   session proposes the cut and a brief the slices share; a script
   (`checkSlicing`) takes it only if every criterion is held by exactly one
   slice, each slice says what it delivers, a slice waits only for earlier
   ones, and there are no more slices than criteria. A refused cut goes back
   once. Trivial and small specs are one slice by script.
3. **Implement.** One fresh session per slice, in order, on the job's
   branch. Each gets its slice, the criteria it holds, a line on the slices
   before and after, the brief and the whole spec. Between slices the gates
   run with the criteria so far, and failures go back to that slice's
   session.
4. **Gates.** The profile's commands, then every criterion's command, and
   `fails-on-base` for a bug. Failures go back to the session one model tier
   up, at most twice.
5. **Review.** A fresh read-only session judges each criterion from the spec
   and the diff. Blockers go back once, to the last slice's session.
6. **Evidence and PR.** Each criterion's proof is its last gate output, plus
   screenshots for UI work. The PR body is built by script. A job that fails
   after its fix rounds opens a draft PR with the failure report.

A job that cannot proceed stops with one question. `animus resume <job>
--answer "..."` (or `animus answer` on Helix) continues it, and the reviewer
is told what was asked and answered.

Sessions are kept short: a session that ends over the context budget is not
resumed but replaced by a fresh one given a handoff, and each session has a
dollar cap by tier ([configuration.md](configuration.md#task-profiles)).

## Who decides what

Scripts own every decision that can be scripted: the stages, the tier, the
gates, the cut being taken, the PR. Agents implement and review, and propose
labels and slices; they do not route. Every agent session goes through
`Agent` in `plugin/src/agent.ts`, the only place that names a model or a CLI.

## What a job leaves where

A job leaves nothing in the target repository but its branch.

| Where | What |
| --- | --- |
| `~/.animus/runs.jsonl` | One line per run: job, labels, outcome, cost, duration, PR |
| `~/.animus/jobs/<job>/` | Its state, spec, gate output, reviews, PR body, screenshots, transcripts, `progress.json` |
| `../.worktrees/<repo>/` | The job's worktree, removed when the job ends unless `--keep` |
| `<repo>/.git/animus/installs/` | The install cache: the two saves used last per install path, and any used in the last hour |
| `~/.claude/projects/<worktree>/` | Claude Code's transcripts of the job's sessions, removed with the job's folder |
| `~/.helix/` (Helix only) | `config.yaml`, `helix.db`, credentials, each person's folder under `people/` |

## Source map

### plugin/src

| File | What it does |
| --- | --- |
| `cli.ts` | The `animus` command |
| `pipeline.ts` | One job from spec to PR, and resuming one |
| `agent.ts` | The `Agent` interface and the Claude Code implementation: sessions, tiers, context and cost |
| `spec.ts` | Reads a spec: header labels and criteria |
| `profiles.ts` | Reads `profiles.yaml` and resolves a spec's labels into a plan |
| `profile.ts` | Reads a project's `.animus/animus.yaml` |
| `slices.ts` | The planner session and the script that checks its cut |
| `workspace.ts`, `installs.ts` | The worktree, its setup, and the install cache |
| `gates.ts` | Runs the gates and the acceptance commands, and `fails-on-base` |
| `review.ts` | The reviewer's verdict per criterion |
| `ui.ts` | Starts a UI target and takes screenshots |
| `pr.ts` | The PR body, the push, the evidence |
| `skills.ts`, `personal.ts` | Vendored skills granted by role, and a person's own config and skills |
| `log.ts` | The run log and each job's state |
| `after.ts` | Waiting for an earlier spec's PR to merge |
| `outcomes.ts`, `cleanup.ts` | `animus outcomes` and `animus cleanup` |
| `init.ts`, `doctor.ts` | `animus init` and `animus doctor` |
| `remote.ts`, `join.ts`, `project.ts` | The Helix client: jobs, joining and leaving, projects |
| `git.ts`, `proc.ts` | git and process helpers, and `AnimusError` |
| `version.ts` | The version and the handshake with Helix |

Also in `plugin/`: `prompts/` (each role's instructions), `config/profiles.yaml`,
`skills/` (the Claude Code skills a person uses: grill-with-docs, to-spec,
domain-modeling, helix), `vendor/` (pinned copies of skills granted to job
sessions), `bin/animus`.

### helix/src

| File | What it does |
| --- | --- |
| `cli.ts` | The `helix` command, including `upgrade` |
| `server.ts` | The HTTP API and the display page |
| `supervisor.ts` | The queue: starts jobs while slots are free, restarts, cancels, answers |
| `store.ts` | `helix.db`: jobs, people, projects, invites, upgrades |
| `upgrade.ts` | Which release `helix upgrade --follow` moves to |
| `cleanup.ts` | `helix cleanup`: each person's `animus cleanup`, old job folders, old job images |
| `config.ts` | `config.yaml`, people and projects |
| `join.ts` | Invites, joining and leaving |
| `projects.ts` | Adding a project and its check |
| `check.ts` | Trying a person's GitHub and Claude tokens |
| `container.ts` | Running a job in its own container |
| `display.ts`, `ui.ts` | What the display page shows, and serving it (`helix/ui/`) |

`helix/deploy/` holds the job image's Dockerfile and the Ubuntu setup
scripts.
