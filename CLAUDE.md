# Animus

A software factory on Claude Code. A spec goes in and a pull request with
proof for each acceptance criterion comes out. The design is docs/factory.md;
docs/workflow.md is the text of its walkthrough. The plugin in `plugin/` is
the whole product: skills to shape a spec, and the `animus` CLI that runs a job.

This project replaces orbit (`../orbit`, archived), whose plugin was also
called Animus from 2026-11-11. Orbit ran Beads epics of tickets in waves.
This one runs one spec as one job with no tracker. README.md lists what was
taken from orbit.

Built so far: steps 1 and 2 of the build order (local `animus run`, the run
log), task profiles, the draft PR on failure, skills granted per role from
plugin/vendor/, screenshots in the PR, and `animus cleanup` (branches,
worktree and job folder of a finished job). Two real jobs ran on
../../meal-planner (its PRs 1 and 2, closed unmerged and cleaned up).

Not built, roughly in the order wanted:
- The outcome fields filled from GitHub (merged, time to merge, human
  commits, reverts), and the five numbers split by task class.
- The task types marked `later` in plugin/config/profiles.yaml, bug first
  (with the `tdd` skill for the implementer on bug jobs only).
- `animus init`, and an `after:` header field so a split spec waits for the
  one before it.
- Containers, Helix, the issue and Slack triggers (build order steps 3 to 7).

Not yet tried against real sessions: a gate fix round, a review send-back,
needs-input with resume, a UI spec with a real visual change (impeccable's
guidance), to-spec starting a job, grill-with-docs, splitting a large design.

Nothing here may depend on one operating system. A job runs in the
foreground of whoever started it: there is no detached mode (tried and
removed on 2026-11-13; Helix is where jobs will outlive a session).

## Conventions

- TypeScript run directly by Node 24 type stripping. No build step. Erasable
  syntax only: no enums, namespaces, or parameter properties. Import local
  files with the `.ts` extension.
- One runtime dependency (`yaml`). Prefer Node built-ins (`node:test`,
  `node:util` parseArgs, `path.matchesGlob`).
- Scripts own every decision that can be scripted. Agents implement and
  review, and propose labels; they do not route.
- Every agent step goes through `Agent` in plugin/src/agent.ts. Nothing else
  may name a model or a CLI. Profiles name a tier.
- A skill reaches an agent only through a grant in profiles.yaml and a copy
  in plugin/vendor/ at a commit in sources.yaml. Never give a job session
  the Skill tool, and never fetch a skill while a job runs.
- A job leaves nothing in the target repo but its branch. Its state, the run
  log and its evidence live under `~/.animus` (`ANIMUS_HOME`).
- Errors meant for the user throw `AnimusError` (printed without a stack).
- `npm test` and `npm run typecheck` must both pass. Tests drive the pipeline
  with a scripted fake agent (plugin/test/helpers.ts); none starts a model.
