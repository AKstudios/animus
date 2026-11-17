# Changelog

What each release changes, newest first. `node scripts/release.ts` turns
Unreleased into the release it cuts. Mark anything that breaks the HTTP API, a
spec, a profile or a job's files with **Breaking**: such a release bumps the
minor version before 1.0 and the major after, and Helix then refuses older
clients with how to update.

## Unreleased

## 0.3.3 (2026-11-17)

- A person's own settings in `~/.animus/config.yaml` (`ANIMUS_HOME`), never in
  a repository: `run: local | helix` and `skills:` at the top for every
  repository, and under `repos:` for one (named `owner/repo`, by any form of
  its GitHub address, or by its folder). A personal skill is a SKILL.md and
  the roles it is for (implementer and planner unless named; the reviewer
  only when named) and optionally task types. Its text is copied into the
  job's folder (`skills.json`) when the job starts, put in each granted
  role's instructions, and logged as `personal:<name>@<hash>`.
- `animus start <spec.md> [--local | --helix]`: runs the job here or submits
  it to Helix. The flag decides, then the config, then Helix when this
  machine has joined one that has the repository. `/animus:to-spec` starts
  jobs with it and passes `--helix` or `--local` when the person asked for
  one in the conversation.
- `animus submit` sends the person's skills with the spec (`skills` on
  `POST /jobs`, answered with the names taken); Helix keeps them beside the
  spec and starts `animus run --skills <file>`. A job Helix starts reads no
  config on the machine. `animus doctor` checks the config and says what it
  sets for the repository; `animus plan` lists your skills by role.
- Projects people add themselves: `animus project add [<name>]` from a
  checkout puts its repository on Helix (`POST /projects`). Helix clones it
  with that person's GitHub token, checks the token may push, reads its
  profile and runs its installs and setup once, in the job image when jobs
  run in containers, before it takes it; the command waits and prints the
  check (`GET /projects/<name>`). `animus project list` (`GET /projects`) and
  `animus project remove <name>` (`DELETE /projects/<name>`, only whoever
  added it). GitHub is the member list: anyone whose token may push to a
  project may submit for it, and a job from someone whose token may not fails
  before it starts. A join no longer fails on a project the token may not
  push to; the person is told which. `animus submit` finds the project by the
  checkout's GitHub address. `helix remove-repo` deletes the clones people's
  jobs made of the project.
- A `helix` skill: asked in a Claude Code session to add, list or remove a
  project, or to submit, follow, answer or cancel a job on Helix, Claude runs
  the command and passes on what Helix said, including a refused remove.
- The README is shorter and says what is built; running the Helix machine is
  now in `helix/README.md`.
- People and projects are kept in `helix.db`, not `config.yaml`. The `people`
  and `repos` of an existing `config.yaml` are moved there, and out of the
  file, the first time a `helix` command runs. `helix serve` starts with no
  projects.

## 0.3.2 (2026-11-16)

- Inviting and joining: `helix invite <name> [--github <login>]` prints a
  one-time code that ends after 24 hours, and `animus join <url> <code>` on
  the person's laptop runs `animus doctor`, then `claude setup-token`, then
  opens GitHub's page for a fine-grained token with the permissions filled
  in, and sends both tokens with the code (`POST /invite`, `POST /join`).
  Helix tries them, as `helix check` does, before it takes the code, and
  keeps them in `~/.helix/credentials/<name>.env`. The Helix token comes back
  and is kept in `~/.animus/helix.json` (mode 600), which the client uses
  when `HELIX_URL` and `HELIX_TOKEN` are not set. `animus leave` (`POST
  /leave`) takes the person off as `helix remove-person` does. `url` in
  `config.yaml` puts the whole join command in what `helix invite` prints.
  `helix serve` now starts with nobody on it yet.

## 0.3.1 (2026-11-16)

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
