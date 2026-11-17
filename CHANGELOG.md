# Changelog

What each release changes, newest first. `node scripts/release.ts` turns
Unreleased into the release it cuts. Mark anything that breaks the HTTP API, a
spec, a profile or a job's files with **Breaking**: such a release bumps the
minor version before 1.0 and the major after, and Helix then refuses older
clients with how to update.

## Unreleased

- Every job on Helix's display links to its own page, `/jobs/<id>`, which
  a person reads after signing in with their Helix token (pasted, or given
  in the address as `#token=…`). Its data comes from a new authenticated
  route, `GET /jobs/<id>/page-data`; `/display` is unchanged and still
  needs no token. `/people` and `/people/<name>` say they are coming.

## 0.3.8 (2026-11-17)

- The installers and `animus setup` find Animus's marketplace by its GitHub
  repository, whatever it is called. Claude Code knows a marketplace by its
  source, so on a machine that had it as `animus`, adding `akstudios` added
  nothing and the install stopped ("no plugin/src/setup.ts at an unknown
  place"). Setup now moves it, and stops if the person keeps the old name.

## 0.3.7 (2026-11-17)

- `install.sh` no longer hides from setup that `~/.local/bin` is missing from
  the person's PATH, so setup offers to add it. `install.ps1` stops with an
  error instead of `exit`, which closed the PowerShell window it ran in.

- Cleanup keeps every job's record for analysis: `animus cleanup` no
  longer removes job folders after 14 days, or Claude Code's transcripts,
  and `helix cleanup` no longer removes Helix's job folders (`log.txt`).
  Only a job named to `animus cleanup` goes whole.
- A finished job's branches, `animus/<job>` and `animus-evidence/<job>`,
  stay 30 days after its pull request merged or closed (`--days`), instead
  of going at once; its worktree still goes at once.

## 0.3.6 (2026-11-17)

- The marketplace is now called `akstudios`, so the plugin is
  `animus@akstudios`; existing installs move once. `animus setup` removes the one called `animus` and
  its plugin; by hand, `claude plugin marketplace remove animus`, then add
  `akstudios/animus#stable` and install `animus@akstudios`. `animus doctor`
  warns while the old one is there.
- One command installs Animus: `install.sh` (macOS, Linux) and `install.ps1`
  (Windows) install git, Node 24 and Claude Code where missing, asking
  first, add the marketplace, and run `animus setup`.
- `animus setup`: `gh` installed and signed in, Claude Code signed in,
  Animus updating itself if the person agrees, Animus turned on in every
  project or in the checkouts they pick, and the `animus` command in
  `~/.local/bin`, which runs the newest installed copy of the plugin.
- `animus enable [<dir>]` turns Animus on in one more checkout, for that
  person only.

## 0.3.5 (2026-11-17)

- `helix cleanup` removes what finished jobs leave on a Helix machine, and
  `helix serve` runs it once a day: `animus cleanup` in each person's Animus
  home with their credentials, Helix's own folder of each job that ended over
  14 days ago (`--days`), and the job images of other releases.
- `animus cleanup` also removes the transcripts Claude Code kept of a job's
  sessions when it removes the job's folder, and keeps a job waiting for an
  answer unless it is named.
- The install cache is pruned whenever a job's worktree is removed: each
  install path keeps its two saves used last and any used in the last hour.
  Before, nothing pruned it.
- A UI target's serve command stops when the job that started it ends,
  however it ends: Ctrl-C, a crash, or Helix cancelling the job. Before, it
  ran on in its own process group.

- `setup.sh` no longer installs `helix-upgrade.timer`: Helix moves to a
  release only with `npm run deploy` or `helix upgrade`. 0.3.4's setup.sh
  installed it, but no machine ran that.

## 0.3.4 (2026-11-17)

- Helix follows the `stable` branch by itself. `helix upgrade --follow`
  moves the machine to the release `stable` is at when it is not already on
  it, and a systemd timer from `setup.sh` (`helix-upgrade.timer`) runs it
  every 15 minutes. A release that failed on the machine is not tried again
  on its own; each try is kept in `helix.db`. A second `helix upgrade` while
  one is under way is refused.
- `npm run deploy -- <ssh-host>` runs that upgrade over ssh now rather than
  at the timer's next run, and `npm run release -- <version> --deploy
  <ssh-host>` pushes the release and then deploys it.

- The README says only how to install and use Animus. Everything else is in
  `docs/`: a CLI reference, the spec format, configuration, architecture,
  releases and development. Helix's READMEs moved to `docs/helix.md` and
  `docs/helix-deploy.md`.

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
