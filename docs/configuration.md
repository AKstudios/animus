# Configuration

Three files decide what a job does:

| File | Whose | What it holds |
| --- | --- | --- |
| `.animus/animus.yaml` in the target repository | The project's, committed | Setup, the gate commands, UI targets: what a job is checked against |
| `plugin/config/profiles.yaml` in Animus | Animus's | What each size, difficulty and type runs, model tiers, limits, skill grants |
| `~/.animus/config.yaml` | Yours, never in a repository | Where your jobs run, and skills of your own |

## The project profile

`animus init` drafts `.animus/animus.yaml`. Read and correct it before the
first job: its commands are the gates.

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

| Key | What it does |
| --- | --- |
| `setup` | Run once in each new worktree, after `installs`. |
| `installs` | Install commands whose output is cached by lockfile and cloned into each new worktree. |
| `commands` | The gates, by name, in the order they run. A command is a string or `{ run, cwd, paths, affected }`: `paths` runs it only when the job changed a file under those globs; `affected` is a narrower form a trivial job runs instead, given `$ANIMUS_BASE` and `$ANIMUS_CHANGED`. |
| `checks` | Which commands each task type runs. A type not listed runs them all. |
| `tests` | Globs for test files, used by `fails-on-base`. Defaults cover the usual names. |
| `protected` | Globs a job should not change. Default `.github/**`, `.animus/**`, `.claude/**`, `infrastructure/**`. |
| `base` | The branch jobs start from and their PRs target. Default `main`. |
| `worktrees` | Where job worktrees go. Default `../.worktrees/<repo name>`. |
| `notes` | What every agent is told about the project, beyond its own CLAUDE.md. |
| `ui.targets` | What a UI job can show. A web target has `serve` and `url` (with `$PORT`) and is screenshot by agent-browser at each viewport; an app target has a `capture` command that writes PNGs into `$ANIMUS_SHOTS`. Each has `pages`, and optionally `paths`, `ready`, `viewports` and design `references`. |
| `ui.human_review` | Read but not used yet. Default true. |

## Task profiles

[plugin/config/profiles.yaml](../plugin/config/profiles.yaml) is the one file
that decides what a job runs. Scripts read it; agents never choose.

- **Size** picks the stages: what setup runs, full or affected gates, which
  reviewer (none for trivial).
- **Difficulty** picks the model tier (fast, standard, deep) and effort, with
  per-size adjustments. Risky is always reviewed by the deep tier.
- **Type** adds a gate, a reviewer or evidence. `ui` adds the UI reviewer and
  screenshots; `bug` adds the `fails-on-base` gate, where an acceptance
  command must fail on the base commit with only the job's test files laid
  over it.
- **providers** maps tiers to models. Profiles name a tier, never a model.
- **limits**: gate fix rounds (2), review rounds (1), the context budget
  after which a session is replaced by a fresh one with a handoff (100k
  tokens), the compaction cap (160k), and the most one session may spend, by
  tier.
- **planner**: which sizes are cut into slices, its tier and effort, and the
  most slices a plan may have.

The reasoning behind the labels is in [factory.md](factory.md#task-profiles).

## Skills

Agents get only the skills their role is granted in `profiles.yaml`, copied
into their instructions from `plugin/vendor/` at the commit recorded in
`plugin/vendor/sources.yaml`:

| Skill | Role | Jobs |
| --- | --- | --- |
| ponytail, useful-tests | implementer | all |
| tdd | implementer | bug |
| impeccable | implementer, UI reviewer | ui |
| to-tickets | planner | sliced |

Job sessions have no Skill tool, and nothing is fetched while a job runs.
`animus skills` lists them. To take a newer commit of a skill: read the
upstream diff, change `sources.yaml`, run `scripts/vendor-skill.sh <name>`,
and replay a few past specs.

## Your own settings

`~/.animus/config.yaml` (under `ANIMUS_HOME`) is optional and holds only
`run` and `skills`:

```yaml
run: helix                              # local | helix, for every repository
skills:
  my-habits: ~/skills/my-habits/SKILL.md          # given to the implementer and planner

repos:
  AKstudios/meal-planner:               # owner/repo, its GitHub address, or a folder
    run: local
    skills:
      sql-style: { file: ~/skills/sql/SKILL.md, roles: [implementer, reviewer], types: [backend] }
```

- What you say in the conversation ("run it on Helix") wins over `run:`, and
  a repository's entry wins over the top.
- Your skills reach only the roles you name: the implementer and planner by
  default, the reviewer only when named, since it judges the work.
- Their text is copied into the job when it starts, or sent with the spec to
  Helix. Only the SKILL.md travels, not files beside it. The run log names
  each one with a hash of its text.
- Gates and setup stay in the shared `.animus/animus.yaml`, so a PR's proof
  never depends on one person's file.

`animus doctor` checks the file, and `animus plan` lists your skills by role.

## Helix's settings

On the Helix machine, `~/.helix/config.yaml` (under `HELIX_HOME`) holds
Helix's own settings, listed in [helix.md](helix.md#configyaml). One of them
is `owner:`, the person who may invite and remove people, remove any project,
cancel any job and see every job, from their own laptop
([helix.md](helix.md#the-owner)). Set it with `helix owner <person>` on the
machine, not by hand: it refuses anyone who has not joined. Nothing on a
laptop sets it, and the owner's own `~/.animus` holds nothing more than
anyone else's.

## Environment

| Variable | What it does |
| --- | --- |
| `ANIMUS_HOME` | Where jobs, the run log and your config live. Default `~/.animus`. |
| `HELIX_URL`, `HELIX_TOKEN` | Reach a Helix without `animus join`. Both must be set; they win over `helix.json`. |
| `HELIX_HOME` | On the Helix machine, where its files live. Default `~/.helix`. |
