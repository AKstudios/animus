# Development

```sh
npm ci && npm ci --prefix plugin
npm test            # node:test, a scripted fake agent, no model calls
npm run typecheck
```

Both must pass before a change goes in. Tests drive the pipeline with a
scripted fake agent (`plugin/test/helpers.ts`); none starts a model. Helix's
tests are in `helix/test/`.

To try a change against a real repository, run the plugin from this checkout
(`plugin/bin/animus run <spec.md> --dry-run` from inside the target repo),
then without `--dry-run` once it looks right.

## How the code is written

- TypeScript run directly by Node 24 type stripping. There is no build step,
  so only erasable syntax: no enums, namespaces or parameter properties.
  Local imports name the `.ts` file.
- One runtime dependency, `yaml`. Node built-ins first: `node:test`,
  `node:util` parseArgs, `path.matchesGlob`.
- Nothing may depend on one operating system. Animus runs on macOS, Linux
  and Windows (Git Bash or WSL).
- Errors meant for the user throw `AnimusError`, printed without a stack.

The rules about agents, skills, state and releases are in
[CLAUDE.md](../CLAUDE.md); the reasons behind them are in
[factory.md](factory.md).

## Where things stand

The maintainer keeps what is built, what is next and what has never run
against a real session in `notes/handoff.md`, outside git, since it names
their machines and network. The release notes are
written from the merged pull requests ([releases.md](releases.md)); a pull
request does not touch `CHANGELOG.md`.

## From orbit

Animus replaces orbit (`../orbit`, archived), whose plugin was also called
Animus. Orbit ran Beads epics of tickets in waves; this runs one spec as one
job with no tracker. What came from it:

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

Left behind: Beads, epics, tickets and waves, the Workflow script, the
test-writer stage, the stop and guard hooks, land, the view, retro and the
eval.
