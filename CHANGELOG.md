# Changelog

What each release changes, newest first. `node scripts/release.ts` turns
Unreleased into the release it cuts. Mark anything that breaks the HTTP API, a
spec, a profile or a job's files with **Breaking**: such a release bumps the
minor version before 1.0 and the major after, and Helix then refuses older
clients with how to update.

## Unreleased

- `after:` keeps waiting on an earlier spec that is not a valid spec, instead
  of failing the job. The waiting line names the file and why it could not be
  read, and the file is read again on every check.
- `npm run changelog` fails a branch that changes a shipped file without adding a
  line under Unreleased; this repo's profile runs it as a gate.

## 0.4.5 (2026-11-18)

- `after:` finds the earlier spec's pull request on GitHub, by the spec's
  title, when this machine's run log has no job for it, so a spec waiting on
  one that ran on Helix or another laptop starts once that PR is merged.
  While it finds none, it says the title it is looking for and how to stop
  waiting.
- The local display (`animus ui`) no longer links to people pages it does not
  have: no PEOPLE link, and `/people` says this display has none. It tags a
  job with its pull request (`PR #8`, `DRAFT PR #8`) linking to GitHub, and a
  job page says the job's output went to the terminal it ran in. On both
  displays, a job with no person or no line yet shows no empty separator or
  `>` line.
- The check-project test no longer fails under load: it read the check's log
  as soon as the project was ready, before the last line was written.

## 0.4.4 (2026-11-18)

- A Helix job for a repository whose GitHub App installation lacks Contents
  or Pull requests write is refused before it starts, saying what the app
  needs and who accepts it, instead of doing all its work and failing to open
  its pull request. `animus join` lists such projects apart from those the app
  does not reach. The app's logo is in `helix/deploy/github/`.

## 0.4.3 (2026-11-18)

- Helix no longer ends a running job's GitHub token. GitHub ends an access
  token the moment its refresh token is used, and Helix renewed before every
  job, project check, `helix check`, daily cleanup and display refresh, so a
  second job starting broke the first one's push ("Invalid username or
  token"). Helix now renews only in a token's last hour, keeps when it ends
  (`GH_TOKEN_EXPIRES` in the credentials file), and writes the current token
  to `~/.helix/tokens/<name>/gh-token`, mounted read-only into that person's
  jobs; git and Animus's `gh` calls read it each time, so a job outlives a
  renewal, and a job past eight hours can still push. `helix check` now tries
  the sign-in with GitHub instead of renewing it.

## 0.4.2 (2026-11-17)

- `lan_url` in Helix's `config.yaml`: the address on the office network.
  When it is set, `helix invite`, `animus invite` and the Slack bot's invite
  DM give a second join line with it, for joining with Tailscale off, beside
  the one at `url`.

## 0.4.1 (2026-11-17)

- A pull request that `gh` fails to open or update says why, instead of
  saying `gh` is not installed whenever it could not be run; "not installed"
  is kept for when it is not found. The test of opening a pull request no
  longer fails on a busy machine (it stopped 0.4.0 deploying to Helix).
- A Helix job cancelled in its first moments stays cancelled. Before, the job
  naming its Animus job just after the cancel put it back as running, so it
  could be cancelled again and then ended as failed.

## 0.4.0 (2026-11-17)

- A job catches up with its base before the push: when the base branch
  gained commits while the job ran and they merge cleanly, the job merges
  them in with one merge commit, runs every gate again with two fix rounds of
  its own, and the pull request names the base commit it caught up to. A
  failed job's draft pull request goes through the same catch-up. A base that
  did not move is left alone.
- A catch-up that conflicts goes to a fresh implementer session with the
  conflicting files, the spec and the base's commits that touched them. The
  job goes on only with no conflict markers left and every gate green within
  two fix rounds, and the pull request lists the resolved files. A conflict
  in a protected path, one the session cannot settle, or gates that still
  fail end the job as needs input; `animus resume <job> --answer` picks it up
  at the catch-up, not from the start.
- Helix keeps an activity, with who and when, each time a person submits,
  answers (with the answer's text) or cancels a job, joins, leaves, or adds or
  removes a project, and the day each new person joined. Nothing from before
  is filled in.
- `/people` on Helix's display lists each person with their GitHub login, the
  day they joined (blank before it was kept), jobs submitted, PRs opened,
  total spent and last activity, from a new authenticated route,
  `GET /people/page-data`. Every person named on the overview or a job page
  links to `/people/<name>`.
- `/people/<name>` shows that person's numbers, their jobs newest first thirty
  at a time, each linking to its job page (those from before activity was kept
  too), and their activity newest first, and says when they left, from a new
  authenticated route, `GET /people/<name>/page-data[?before=<job id>]`.
- `animus ui` serves the local display on 127.0.0.1 (port 7420 or the next
  free one) and opens it: every job in `~/.animus`, grouped by project, newest
  first, each with its job page, and no people pages or sign-in. Ctrl-C stops
  it. The display page tells its source apart by the new `local` flag on
  `Display`; `animus ui --helix` is unchanged. Not breaking: Helix's API and
  the job's files keep their shape.
- `animus run` records its process in the job's `progress.json` (`pid` and
  `host`, added to `stage`, `who` and `at`). A job counts as running only on
  that host with that process alive; one whose process is gone and that has no
  outcome is stopped, and the local display's reader of `~/.animus` shows it
  with `animus resume <job>` as the way on.
- With no job running or queued and no project picked, the display's overview
  shows an original synchronizing-helix animation (inline SVG and CSS only: the
  Helix mark unwinds into a slowly turning double helix, with glitch fragments
  and "SYNCHRONIZING") in place of the empty working box. It holds still when
  the browser asks for reduced motion, pauses while the tab is hidden and
  drifts slowly so nothing burns into a wall screen. A job that only waits for
  an answer does not keep it away.
- The display's overview lists the ten newest open PRs Helix's jobs opened
  (for the picked project when one is picked), drafts marked, in place of
  merged and closed ones. Helix lists a project's open PRs on GitHub with the
  token of the person whose job opened one, at most once a minute per project;
  a PR whose person has left is not listed. RECENT now keeps only failed and
  cancelled jobs. `GET /display` gains `prs`.
- The installers take `join <url> <code>`: after setup they run `animus join`
  with them, so one line installs Animus and joins a Helix
  (`curl -fsSL …/install.sh | bash -s -- join <url> <code>`).
- `helix slack setup` tries the Slack app's bot and app tokens against Slack,
  keeps them in `~/.helix/credentials/slack.env` and turns the bot on in
  `config.yaml` (`slack: {enabled, owner}`). A refused token is reported with
  Slack's reason and nothing is written.
- `helix github setup <client-id>` proves Helix's GitHub App's client ID with
  a device-code request and writes `github: {client_id}` to `config.yaml`. An
  ID GitHub refuses is reported with GitHub's reason and nothing is written.
- On a Helix with a GitHub App, `animus join` asks for no GitHub token: it
  shows GitHub's code, opens github.com/login/device and waits while Helix
  polls GitHub, then joins the person as the login that approved, keeping
  their access and refresh tokens in their credentials file. An invite with
  `--github` refuses any other login and its code stays usable. At the end
  the person is told which projects the app cannot reach for them, each with
  the app's installation link. With no `github:` entry, join is as before.
- **Breaking:** on a Helix with a GitHub App, `POST /join` takes
  `device_code` (from the new `POST /join/device`, which takes the invite's
  `code` and answers GitHub's `user_code` and `verification_uri`) instead of
  `github_token`, answers `202 {pending: true}` while GitHub has not been
  approved (the client asks again), and adds `unreachable: [{project, owner,
  install}]` to its answer. `POST /invite` answers `github_app: true` there.
- On a Helix with a GitHub App, each job, each project check and `helix
  check` first trade the person's refresh token for a fresh access token,
  keeping the new pair in their credentials file (mode 600); the job gets the
  access token as `GH_TOKEN` and never the refresh token. A job for a project
  the app cannot reach for the person fails before it starts with the app's
  installation link. A refresh GitHub refuses (revoked, or unused for six
  months) fails the job before it starts with "run `animus github login`",
  DMed to a person linked on Slack.
- `animus github login` runs GitHub's device flow again and Helix replaces the
  person's stored tokens; a login other than their own is refused.
- [helix/deploy/github/manifest.json](helix/deploy/github/manifest.json) is
  Helix's GitHub App, and [docs/helix-deploy.md](docs/helix-deploy.md) walks
  through creating it and running `helix github setup`.
- **Breaking:** new `POST /github/device` (answers GitHub's `device_code`,
  `user_code` and `verification_uri`) and `POST /github/login` (takes
  `device_code`, answers `202 {pending: true}` until GitHub is approved, then
  `{name, github}`; 403 for a login other than the person's, 409 on a Helix
  with no GitHub App).
- With `slack.enabled` in `config.yaml`, `helix serve` connects to Slack over
  Socket Mode: every envelope is acknowledged at once, and a socket Slack
  drops is replaced. With it off, Helix opens no connection to Slack.
- The Slack bot answers a Slack user with no Slack link, whatever they send,
  with a private "You're not on this Helix. Ask <owner> for an invite.", and
  keeps nothing. An invite may carry a Slack user, linked to the person when
  they join; the owner's `/helix link @user <person>` links someone who joined
  before. Leaving Helix, or `helix remove-person`, removes the link.
- The owner invites someone from Slack with `/helix invite @user
  <github-login>`, or on the machine with `helix invite <name> --github
  <login> --slack <member-id>`: the bot DMs them to connect Tailscale first,
  and one line that installs Animus and joins. An invite sent on Slack must
  name a GitHub login, and only the owner may send one.
- A linked person's Helix jobs, however submitted, post to them on Slack, one
  DM thread per job: started (or resumed), needs input with the question, the
  pull request's link, or failed with the reason. `/helix notify off` stops
  these for that person and `/helix notify on` starts them again; they are on
  by default.
- The Slack app's manifest is in `helix/deploy/slack/manifest.yaml`;
  docs/helix-deploy.md walks from creating the app to `helix slack setup`,
  and docs/helix.md describes the bot's commands.
- From Slack, `/helix jobs` lists a person's queued, running and waiting
  jobs with where to follow each, and `/helix status` says Helix's slots in
  use, the queue and its version, both privately. A person answers a job
  that needs input by replying in its thread (in a channel, with @Helix),
  and the thread's **Cancel job** button cancels it for its person or the
  owner. The manifest adds interactivity and the `app_mention` event for
  these.
- The planner is told what a slice costs: each one is a fresh session that
  reads the brief, the spec and the code before it writes, so it now cuts
  fewer, larger slices and folds a small addition into the slice it builds
  on. A large spec was cut into seven slices of two or three minutes each.
- Animus's own test commands (`npm test` and the specs' `$` lines, all run
  through `scripts/with-tmp.sh`) end a test that never settles after a
  minute, and no longer wait on a server a test left open. One such test
  held an implementer for eight minutes.
- Every job on Helix's display links to its own page, `/jobs/<id>`, which
  a person reads after signing in with their Helix token (pasted, or given
  in the address as `#token=…`). Its data comes from a new authenticated
  route, `GET /jobs/<id>/page-data`; `/display` is unchanged and still
  needs no token. `/people` and `/people/<name>` say they are coming.
- A job page shows the job's facts, its spec as submitted, its time in each
  stage and its slices, its latest checks with a failed one's output, the
  reviewer's findings, its questions and answers, and its log, which keeps
  to its end while the job runs. A gate run's file, `gates/run-<n>.txt`,
  now ends with all that each check printed.
- A job page shows the job's latest screenshots. Helix serves each, to a
  valid token only, at `GET /jobs/<id>/shots/<name>`, and only names the
  job's `shots/manifest.json` lists, never a file outside its shots folder.
- `animus ui --helix` opens the Helix this machine joined in the browser,
  already signed in with its token.

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
