# Animus

A software factory on Claude Code: a spec goes in, a pull request with proof
for each acceptance criterion comes out. `plugin/` is what a developer
installs (skills and the `animus` CLI); `helix/` is the supervisor for a
shared machine and is never shipped in the plugin. Docs index:
docs/README.md.

Read notes/handoff.md before starting work, and update it in the same change
whenever something there is built, tried or dropped. It is the maintainer's
own, kept out of git (it names their machines and network); where it is
missing, there is nothing to read or update.

## Rules

- TypeScript run by Node 24 type stripping, no build step: erasable syntax
  only, import local files with `.ts`. One runtime dependency (`yaml`).
- Nothing may depend on one operating system.
- Scripts own every decision that can be scripted; agents implement, review
  and propose, and never route.
- Only `Agent` in plugin/src/agent.ts names a model or a CLI. Profiles name a
  tier.
- A skill reaches a job session only through a grant in profiles.yaml with a
  copy in plugin/vendor/, or as a personal skill copied in when the job
  starts. Never give a job session the Skill tool or fetch a skill mid-job.
- `~/.animus/config.yaml` holds only `run` and `skills`; what a job is
  checked against stays in the project's `.animus/animus.yaml`.
- A job leaves nothing in the target repo but its branch; its state lives
  under `ANIMUS_HOME`.
- Jobs run in the foreground of whoever started them; Helix is where jobs
  outlive a session. Helix holds no state beyond `helix.db` and the job
  files, and starts jobs only as `animus` processes.
- Errors meant for the user throw `AnimusError`.
- A breaking change to the HTTP API, a spec, a profile or a job's files is
  said in the pull request's Breaking section; `npm run release` writes the
  changelog from the merged pull requests and refuses a breaking one without
  `--breaking`.
- `npm test` and `npm run typecheck` must pass. Tests use the fake agent in
  plugin/test/helpers.ts; none starts a model.
- Docs live in docs/; keep README.md to installing and using.
