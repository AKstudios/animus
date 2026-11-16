# Changelog

What each release changes, newest first. `node scripts/release.ts` turns
Unreleased into the release it cuts. Mark anything that breaks the HTTP API, a
spec, a profile or a job's files with **Breaking**: such a release bumps the
minor version before 1.0 and the major after, and Helix then refuses older
clients with how to update.

## Unreleased

- One interview skill: `/animus:grilling` is gone and `/animus:grill-with-docs`
  holds the interview itself, loading `domain-modeling` for the glossary and
  ADRs. Its size rule now says large work is one spec that the factory cuts
  into slices, where it used to say to cut it into medium specs.

- Each Helix job can run in a Docker container of its own: on when
  `config.yaml` has `container: {memory, cpus}`. A job sees only its
  submitter's folder under `~/.helix/people/` (their clone, job state and
  Claude config), Animus read-only and its spec, and only their credentials,
  passed by name. No Docker socket, no published port, all capabilities
  dropped. `helix image` builds the image (`animus-job:<version>`) and
  `helix upgrade` rebuilds it. `helix remove-person` also deletes the
  person's folder and removes their containers.
- setup.sh step 8 adds Helix's account to the docker group.

## 0.3.0 (2026-11-16)

- **Breaking:** the client sends its version to Helix, and Helix refuses one it
  cannot work with (HTTP 426, with how to update). A client from before this
  release sends none and is refused: update the plugin.
- `animus doctor`: checks Node, Claude Code (2.1.322 or later), git, gh, the
  repo's profile, Helix and its version, orbit's old plugin of the same name,
  and git hooks or commit signing that would reach a job's commits.
- Job sessions start no MCP server, not even one the person added for
  themselves (`--strict-mcp-config`).
- Helix: `helix remove-person` (token off, jobs cancelled, credentials file
  deleted, a checklist of the rest), `helix remove-repo`, and `helix upgrade
  <tag>` (drain, check out, install, test, restart, or go back). People,
  repositories and slots are read again when `config.yaml` changes, with no
  restart. A job whose person or repository was removed fails instead of
  running.
- Releases: `npm run release -- <version>` tags a release and moves the `stable`
  branch, which teammates' Claude Code follows.
- setup.sh: Helix's service runs with Claude Code's auto-update off.
