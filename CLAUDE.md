# Animus

A software factory on Claude Code. A spec goes in and a pull request with
proof for each acceptance criterion comes out. The design is docs/factory.md;
docs/workflow.md is the text of its walkthrough. The plugin in `plugin/` is
what a developer installs: skills to shape a spec, and the `animus` CLI that
runs a job. `helix/` is the supervisor for a shared machine: a queue, an HTTP
API and one `animus run` process per job. It imports from `plugin/src` and is
never shipped in the plugin.

This project replaces orbit (`../orbit`, archived), whose plugin was also
called Animus from 2026-11-11. Orbit ran Beads epics of tickets in waves.
This one runs one spec as one job with no tracker. README.md lists what was
taken from orbit.

What is built, what is next, and what has never run against a real session
are in docs/handoff.md. Read it before starting work, and update it in the
same change whenever something there is built, tried or dropped. Keep this
file to what the project is and its conventions.

Nothing here may depend on one operating system. A job runs in the
foreground of whoever started it: there is no detached mode (tried and
removed on 2026-11-13). Helix is where jobs outlive a session.

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
- Helix holds no state of its own: the SQLite table and Animus's job files
  are the record, so a restart carries on from them. It starts jobs only as
  `animus` processes and never calls the pipeline in its own process.
- One version, in `plugin/.claude-plugin/plugin.json`; releases are cut by
  `npm run release -- <version>`. A change that breaks the HTTP API, a spec,
  a profile or a job's files goes under **Breaking** in CHANGELOG.md's
  Unreleased section.
- `npm test` and `npm run typecheck` must both pass. Tests drive the pipeline
  with a scripted fake agent (plugin/test/helpers.ts); none starts a model.
