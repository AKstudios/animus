# CLI reference

Two commands: `animus`, which the plugin installs, and `helix`, which runs
on the Helix machine only. In a Claude Code session you rarely type
`animus` yourself: the plugin's skills run it when you ask. `animus help`
and `helix help` print the same list in short.

Exit codes: 0 for success, 1 when the command ran but its result is a
failure (a job that did not end in a PR, a failing gate, a doctor problem),
2 for a usage error or a refusal (printed as `animus: <reason>`).

## animus

### Jobs on this machine

#### `animus start <spec.md> [--local | --helix] [--repo <dir>] [--draft]`

Starts one job, here or on Helix. Where it runs is decided in this order:

1. `--local` or `--helix`.
2. `run:` in `~/.animus/config.yaml`, the repository's entry and then the
   top ([configuration.md](configuration.md#your-own-settings)).
3. Helix, when this machine has joined one that has the repository.
4. Otherwise here.

Here, it is `animus run` and waits for the job to end. On Helix, it is
`animus submit` and returns at once. `/animus:to-spec` starts jobs with
this command.

#### `animus run <spec.md> [--repo <dir>] [--dry-run] [--draft] [--keep] [--skills <file>]`

Runs one job on this machine, from spec to PR: a worktree, the planner for a
medium or large spec, the implementer, the gates, the review, the PR
([architecture.md](architecture.md#what-a-job-does)). Run it from inside
the target repository, or name it with `--repo`.

- `--dry-run`: stops before the push, so no PR opens.
- `--draft`: opens the PR as a draft.
- `--keep`: leaves the worktree when the job ends.
- `--skills <file>`: the personal skills as JSON, instead of reading
  `~/.animus/config.yaml`. Helix passes them this way.

A spec with `after: <spec.md>` waits until that spec's PR is merged. Prints
the result as JSON; exits 0 when the job ended in a PR.

#### `animus resume <job> [--answer <text>] [--dry-run] [--keep]`

Picks up a job that stopped with a question, or was interrupted. `--answer`
gives it the answer to its question.

#### `animus plan <spec.md> [--slices] [--repo <dir>]`

Checks a spec and prints what its labels would run: stages, tier, effort,
reviewer, the skills each role gets (yours marked), what it waits for, and
each criterion with its check command. Starts no job.

`--slices` also asks the planner how it would cut the spec. That is one
read-only model session in the repository, so it costs a little.

#### `animus init [--repo <dir>] [--force]`

Drafts `.animus/animus.yaml` from the repository's `package.json`,
`pyproject.toml`, `go.mod` or `Cargo.toml`. Runs nothing. Read the draft
before the first job: its commands are the gates. `--force` replaces an
existing profile.

### The record

#### `animus runs [-n <count>] [--json]`

The run log (`~/.animus/runs.jsonl`), newest last, 20 lines unless `-n`
says otherwise.

#### `animus outcomes [--json]`

What became of each PR, read from GitHub with `gh`: merged or closed, time
to merge, commits by people, reverted or reworked within 30 days. Then the
five numbers split by task class. Without `gh`, it shows what it last read.

#### `animus cleanup [<job>...] [--days <n>] [--dry-run]`

Removes what finished jobs left behind. A job whose PR is merged or closed
loses its worktree at once, and its branches (`animus/<job>` and
`animus-evidence/<job>`, local and on origin) once the PR ended more than
`--days` ago (default 30). A job with no PR loses both once it last ran
that long ago. A job with an open PR, or one waiting for an answer, is
kept. What a job records stays for analysis: its folder (spec, gate output,
reviews, screenshots, transcripts), Claude Code's own transcripts and the
run log. A named job goes whole and at once, folder included. `--dry-run`
lists what would be removed.

Deleting an evidence branch leaves its PR's screenshots unreachable once
GitHub collects the commit; the job's folder keeps them. Nothing runs it on a laptop by itself; on
Helix, `helix cleanup` runs it once a day ([helix.md](helix.md#cleanup)).

Removing a worktree also drops install-cache saves (`.git/animus/installs`)
that are neither among the two used last for their path nor used in the
last hour.

### This machine

#### `animus setup`

Gets this machine ready, asking as it goes. The install scripts end with it;
run it again in a terminal at any time. It checks Claude Code (and updates
it when older than the oldest a job has run on) and `gh`, installing `gh`
with brew, winget, apt or dnf if you agree, signs both in, and has git use
`gh` for GitHub. It removes the marketplace Animus had before it was called
`akstudios`, if you still have it. Then it asks whether Claude Code may
update Animus by itself (`autoUpdate` on the `akstudios` entry under
`extraKnownMarketplaces` in your `~/.claude/settings.json`), and whether to
turn Animus on in every project (installed for your user) or in the
checkouts you pick from those it finds under `~/Dev`, `~/code`, `~/src`,
`~/projects` and the like. Last, it writes the `animus` command to
`~/.local/bin` (it runs the newest installed copy of the plugin, so updates
need nothing more) and offers to put that folder on your PATH.

#### `animus enable [<dir>]`

Turns Animus on in one checkout, this one unless named, for you only:
`claude plugin install animus@akstudios --scope local`, which Claude Code
keeps in the checkout's `.claude/settings.local.json`. That file is kept out
of git through the checkout's `.git/info/exclude` when nothing ignores it
already, so the repository is unchanged.

#### `animus doctor`

Checks that this machine can run and submit jobs: Node, Claude Code, git,
`gh`, the repository's profile, your config, Helix and its version, and
anything in your own setup that would reach a job (orbit's plugin, git
hooks, commit signing). Exits 1 if anything would stop a job.

#### `animus skills`

The vendored skills, the commit each was copied at, and which role gets
each.

#### `animus version`

The plugin's version and the commit of Animus it runs from (marked `-dirty`
when that checkout has changes).

### Helix

These need a Helix this machine has joined (`~/.animus/helix.json`), or
`HELIX_URL` and `HELIX_TOKEN` set, which win.

#### `animus join <url> <code>`

Joins a Helix with the one-time code from `helix invite`. It runs `animus
doctor`, runs `claude setup-token` and asks for the token it printed, opens
GitHub's page for a fine-grained token (contents and pull requests, write)
and asks for that token, then sends both. Helix tries them and refuses them
with the reason if either fails. The Helix token it returns is kept in
`~/.animus/helix.json`.

#### `animus leave [--yes]`

Takes you off Helix: your queued and running jobs are cancelled and your
tokens there deleted. Asks first unless `--yes`, which a session without a terminal needs.
The owner is refused until another is named with `helix owner` on the
machine.

#### `animus invite <name> [--github <login>] [--slack <member-id>]`

The owner only ([helix.md](helix.md#the-owner)): makes an invite as `helix
invite` does on the machine, and prints the same code and `animus join`
line, or where the Slack bot sent it. `--slack` needs the bot running.
Anyone else is refused with the owner's name.

#### `animus remove-person <name>`

The owner only: takes a person off as `helix remove-person` does, and prints
the same list of what is left to revoke. The owner cannot be removed until
another is named.

#### `animus project add [<name>]`

Puts this checkout's repository on Helix, named after its folder unless
given a name. Helix clones it with your GitHub token, checks the token may
push, reads `.animus/animus.yaml` from the default branch and runs its setup
once. The command waits and prints the check as it goes. Anyone on Helix
whose GitHub token may push to the repository can then submit for it.

#### `animus project list`

The projects on Helix: state (ready, checking or failed, with the reason), GitHub address and who added each.

#### `animus project remove <name>`

Removes a project you added, or any project for the owner. Refused while any
of its jobs is queued or running. The clones Helix and people's jobs made of it are deleted.

#### `animus submit <spec.md> [--repo <dir>] [--draft]`

Queues a spec on Helix for the project with this checkout's GitHub address
(or, failing that, the one named after its folder), with your personal
skills. Returns the job's number at once.

A job can also start from GitHub with no command here: `/animus <what you
want>` as a comment on an issue in the project gets a draft spec as a comment,
`/animus submit` queues it, and `/animus discard`, `/animus answer <text>` and
`/animus cancel` act as their commands here do. See
[helix.md](helix.md#github-comments).

#### `animus status [<id>] [--all]`

With no id, your jobs on Helix. With one, that job and the end of its log.
`--all` lists every person's jobs, with whose each is; only the owner may
use it.

#### `animus result <id>`

One job as JSON. Exits 0 once it has ended in a PR.

#### `animus answer <id> <text>`

Answers a job's question. The job is queued again and resumes with it.

#### `animus cancel <id>`

Cancels a queued or running job of yours, or anyone's for the owner.

#### `animus ui`

Serves the local display on `127.0.0.1` (port 7420, or the next free one),
opens it in your browser and runs until Ctrl-C. It shows every job this machine
ran, read from `~/.animus`, grouped by project and newest first, each with its
job page. A job whose process is gone and that has no outcome shows as stopped,
with `animus resume <job>`. Its Jobs page (`/jobs`, linked from the header) lists them 30 at a time with filters by result and project in the address; merged and closed tags come from `outcomes.json`. It has no sign-in and no people pages, and answers
only GET and only for the host names `127.0.0.1` and `localhost`. There is no
run log to show, so a job page's log is empty.

#### `animus ui --helix`

Opens Helix's display in your browser, already signed in: it opens
`<url>/#token=<token>` with the address and token you joined with, and the
page keeps the token and takes it out of the address bar. Do not run it on a
shared wall screen: the token can also submit and cancel jobs as you.

### Inside a job's worktree

The implementer runs these during a job. They fail anywhere else.

| Command | What it does |
| --- | --- |
| `animus check` | Runs the job's gates now: the profile's commands, then the criteria's commands (only those of the slices so far, part-way through a sliced job), and `fails-on-base` for a bug. |
| `animus shots [--again]` | Screenshots a UI job's pages. Reuses the last set when the worktree has not changed since, unless `--again`. |
| `animus ui up \| down` | Starts or stops a UI job's app. |

## helix

Run on the Helix machine through the `helix` command in the repository's helix/bin folder, with its files under
`~/.helix` (`HELIX_HOME`). See [helix.md](helix.md) for what Helix is and
[helix-deploy.md](helix-deploy.md) for setting a machine up.

| Command | What it does |
| --- | --- |
| `helix serve` | Listens for submissions and runs them, as many at once as `slots` in `config.yaml`. The service manager runs this. |
| `helix invite <name> [--github <login>] [--slack <member-id>]` | Prints a one-time join code for a person, good for 24 hours, and the `animus join` command to send them. A new invite replaces the old. `--github` takes only a GitHub token that signs in as that login. `--slack` (which needs `--github`) has the Slack bot DM that member the code instead, in one line that installs Animus and joins; joining links their Slack user to the person. The owner runs the same from their laptop as `animus invite`. |
| `helix owner <person>` | Makes someone who has joined the owner (`owner:` in `config.yaml`), replacing any other. From their own laptop the owner invites and removes people, removes any project, cancels any job and sees every job ([helix.md](helix.md#the-owner)). |
| `helix slack setup` | Turns the Slack bot on: asks for the app's bot token, its app token and the owner's Slack member ID, tries both tokens against Slack, keeps them in `~/.helix/credentials/slack.env`, sets `slack: {enabled: true}` in `config.yaml` and links that Slack user to the owner. Refused while there is no owner. Restart `helix serve` to connect. See [helix-deploy.md](helix-deploy.md#the-slack-bot). |
| `helix add-person <name> [--env-file <file>]` | Adds a person by hand instead of an invite, and prints their Helix token once. The file holds `KEY=VALUE` lines set for their jobs only (`CLAUDE_CODE_OAUTH_TOKEN`, `GH_TOKEN`). Run again for a new token. |
| `helix remove-person <name>` | Their token stops working, their queued and running jobs are cancelled, their credentials file and folder are deleted. Prints what is left to revoke on GitHub, Claude and Tailscale. Refused for the owner until another is named. The owner runs the same from their laptop as `animus remove-person`. |
| `helix check [<name>]` | Tries each person's tokens for real: who the GitHub token is, when it ends, whether it may push to each project, whether the Claude token answers; for the whole Helix, whether some person's token can read each project's GitHub comments. Exits 1 if anything but a push fails. |
| `helix add-repo <name> <dir>` | Adds a clone made by hand, ready at once. People add theirs with `animus project add` instead. |
| `helix remove-repo <name>` | Removes any project, whoever added it. Refused while any of its jobs is queued or running. A clone added with `add-repo` stays on disk. |
| `helix image` | Builds the image jobs run in (`animus-job:<version>`). Used when `config.yaml` has a `container:` entry. |
| `helix upgrade <tag>` | Moves the machine to a release: stops starting jobs, waits for the running ones, checks out the tag, installs, runs the tests and typecheck, builds the job image when jobs run in containers, and exits for the service manager to restart it. If any step fails, the checkout goes back. Refused while another upgrade is under way. |
| `helix upgrade --follow` | The same, to the release origin's `stable` branch is at. Does nothing when the machine is already on it, or when that release failed here before (`helix upgrade <tag>` tries it again). `npm run deploy -- <ssh-host>` runs this from your own machine. |

Helix also runs three commands on itself, which you do not type: `helix
verify` (tries a joining person's tokens), `helix check-project <name>` (a
project's check) and `helix setup <worktree>` (a project's setup, in the job
image when jobs run in containers).
