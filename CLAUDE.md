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
log) plus task profiles and the draft PR on failure. Not built: containers,
Helix, the Slack and issue triggers, the outcome fields filled from GitHub,
and every task type marked `later` in plugin/config/profiles.yaml.

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
- A job leaves nothing in the target repo but its branch. Its state, the run
  log and its evidence live under `~/.animus` (`ANIMUS_HOME`).
- Errors meant for the user throw `AnimusError` (printed without a stack).
- `npm test` and `npm run typecheck` must both pass. Tests drive the pipeline
  with a scripted fake agent (plugin/test/helpers.ts); none starts a model.
