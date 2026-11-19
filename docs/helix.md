# Helix

The supervisor for a machine that runs Animus jobs for several people
([factory.md](factory.md), "The office machine"). It lives in `helix/`, is
not part of the plugin and is not installed with it. It keeps the queue, the
people and their projects in one SQLite file, starts each job as its own
`animus run` process while slots are free, and answers over HTTP. Setting up
a machine, or moving Helix to another one, is
[helix-deploy.md](helix-deploy.md). Its commands are in [cli.md](cli.md#helix).

## config.yaml

`~/.helix/config.yaml` sets `host` (default 127.0.0.1: never a public
address), `port` (7420), `slots` (2), `url` (the address people reach Helix
at, which `helix invite` puts in the join command it prints), `lan_url` (the
address on the office network, such as `http://<host>.local:7420`, for when
Tailscale is off: invites then print, and the Slack bot DMs, a second join
line with it), `name` (what the
display calls the machine), `owner` ([The owner](#the-owner)), `container`
and `slack` ([Slack](#slack)). Helix reads it again when it changes, for the
slots and the owner; host, port and slack need a restart. People and projects are
in `helix.db`, so changing either needs no restart.

`slots` is the most jobs that ever run at once; before starting each queued
job Helix also checks for room, and a job that does not fit stays queued while
later ones that do fit start. Three keys set the room, and are read again
without a restart:

- `reserve_memory` (default `2g`): memory kept free beyond what a job needs.
- `job_memory` (default `4g`): what a job needs when `container.memory` is not
  set. A job starts only when free memory covers its memory plus
  `reserve_memory` and the 1-minute load average is under the core count (load
  is not checked where the system reports none, as on Windows).
- `tier_limits` (default none): the most jobs at once whose implementer runs on
  a tier, such as `deep: 1`, counted from the spec's labels.

Helix checks again every 30 seconds and when a job ends. With nothing running
the first queued job starts whatever the machine reports. A held job says why
(`waiting for memory: 3.1 GB free, needs 6 GB plus 2 GB kept free`, `waiting
for the deep tier: 1 of 1 running`) in `animus status <id>` and on the display.
Helix's answers to a job's submit and status carry `links`: its job page at
`url` (Tailscale) and `lan_url` (office network), whichever are set, built as
Slack's posts build them and never with a token. `animus submit` and
`animus status <id>` print them under `watch it:`.
A wrong value is refused with its key named. A `config.yaml` from
before 0.3.3 that names `people` and `repos` has them moved into `helix.db`
the first time a `helix` command runs.

## People

`helix invite` prints a one-time code that ends after 24 hours. The person
runs `animus join <url> <code>`, which runs `animus doctor`, then `claude
setup-token`, then opens GitHub's page for a fine-grained token with contents
and pull requests (write) filled in, and sends both tokens. Helix tries them
as `helix check` does and refuses them with the reason, leaving the code
usable, if either fails. A project the GitHub token may not push to does not
stop the join; the person is told which. Helix keeps the tokens in
`~/.helix/credentials/<name>.env` and returns a Helix token, which the laptop
keeps in `~/.animus/helix.json`. With `--github`, only a token that signs in
as that login is taken. With `--slack`, the Slack bot sends the invite
instead ([Slack](#slack)).

Each job runs with its submitter's tokens only, so its pull request is
theirs. `animus leave`, or `helix remove-person`, takes someone off; the
latter prints what is left to revoke on GitHub, Claude and Tailscale.

### The owner

The owner is the one person who may invite and remove people and act on any
project or job. `helix owner <person>` on the machine names them, as `owner:
<person>` in `config.yaml`; the person must have joined already. Only shell
access to the machine sets it, and running it again names another. There is
no second token: on each request Helix compares the person the caller's own
Helix token belongs to with `owner`.

From their own laptop, the owner:

- invites people with `animus invite <name> [--github <login>] [--slack
  <member-id>]`, which prints what `helix invite` does (`--slack` needs the
  Slack bot running);
- removes people with `animus remove-person <name>`, which does what `helix
  remove-person` does and prints the same checklist;
- removes any project with `animus project remove`, still refused while one
  of its jobs is queued or running;
- cancels anyone's job with `animus cancel`;
- sees every person's jobs, with whose each is, with `animus status --all`.

Anyone else is refused these with the owner's name, and sees and cancels
only their own jobs. `helix upgrade`, `helix image`, `helix slack setup`,
`helix owner` and editing `config.yaml` stay on the machine. The owner
cannot `animus leave`, and no path removes them: both are refused with "name
another owner first: helix owner <person> on the machine".

`helix check` asks the services themselves: who the GitHub token is and when
it ends, whether it may push to each project (a push that sends nothing), and
whether the Claude token answers, and whether some person's token can read each project's comments ([GitHub comments](#github-comments)). It exits 1 if anything but a push fails. A
refused push shows as `no`: nobody has to reach every project. Before each
job, Helix checks the GitHub token again with a push to that job's project,
so a token that ended or may not push fails the job at once with the reason.

## Slack

Helix has an optional Slack bot, inside `helix serve` over Socket Mode
([ADR 0002](adr/0002-slack-over-socket-mode-without-an-sdk.md)). Setting it
up, from creating the Slack app with
[helix/deploy/slack/manifest.yaml](../helix/deploy/slack/manifest.yaml), is
in [helix-deploy.md](helix-deploy.md#the-slack-bot).

- In Slack, the owner is the Slack user linked to the owner person
  ([The owner](#the-owner)), so `helix owner` changes who it is.
- `helix slack setup` refuses to run while there is no owner. It asks for
  the app's bot token (`xoxb-`), its app token (`xapp-`, with
  `connections:write`) and the owner's Slack member ID (`U…`). It tries both
  tokens against Slack, keeps them in `~/.helix/credentials/slack.env` (mode
  600), sets `slack: {enabled: true}` in `config.yaml` and links that Slack
  user to the owner. A token Slack refuses is reported with Slack's reason
  and nothing is written. `helix serve` connects only while `slack.enabled`
  is on; turning it on or off takes a restart. A `slack.owner` left in
  `config.yaml` by an earlier setup becomes the owner's Slack link when
  `helix serve` starts, unless the owner has one already, and is dropped.
- `/animus invite @alex alex-gh`, sent by the owner, or `helix invite alex
  --github alex-gh --slack U123` on the machine, makes an invite and has the
  bot DM Alex: connect Tailscale first, then one line, `curl -fsSL
  …/install.sh | bash -s -- join <url> <code>`, that installs Animus where
  it is missing and joins. The code is only in that DM. An invite sent on
  Slack must name a GitHub login, so a stolen code cannot join with another
  login's token. Joining with it links Alex's Slack user to the person
  `alex` (their Slack link).
- `/animus link @alex alex`, sent by the owner, links someone who joined
  before. `animus leave` and `helix remove-person` remove the link.
- Every job a linked person starts, from `animus submit` or anywhere else,
  posts to one DM thread of its own: started (or resumed), needs input with
  the question, the pull request's link, or failed with the reason.
  `/animus notify off` stops these for the person who sends it and
  `/animus notify on` starts them again; they are on by default.
- `/animus jobs` answers privately with the sender's queued, running and
  needs-input jobs, each with its thread or pull request link.
  `/animus status` answers with Helix's slots in use, the queue's length and its
  version.
- A job that needs input is answered by replying in its thread: any reply in
  the DM, or a reply that mentions @Animus in a channel. It resumes as after
  `animus answer`, and the thread says so. Replies from anyone but the job's
  person, and channel replies without the mention, are ignored. The thread's
  first post has a **Cancel job** button, which cancels the job for its person
  or the owner; anyone else gets a private refusal.

Anyone without a Slack link who writes to the bot or sends any `/animus`
command gets a private "You're not on this Helix. Ask <owner> for an
invite.", and nothing they sent is kept. Only the owner may invite and link. Every command is acknowledged at once and answered privately; one
sent while Helix is down gets Slack's own error and is not queued.

## GitHub comments

A person's `/animus` on an issue in a project Helix has starts a draft there,
as `/animus draft` does in Slack ([ADR 0001](adr/0001-slack-jobs-start-from-a-confirmed-draft.md)).
Helix reads GitHub by polling and opens no port
([ADR 0006](adr/0006-github-comments-reach-helix-by-polling.md)): inside `helix
serve`, about once a minute per project, one `GET /repos/{owner}/{repo}/issues/comments?since=`
with the GitHub token of the person who added the project, else another
person's (a read one token fails is logged and the next is tried). Helix keeps
per project a position (the newest comment it handled, starting at the moment
it first watched the project) and the ids of the comments it handled in
`helix.db`, so a comment is acted on once, only when created after the
position: an edited old comment is not. A command is a comment whose first line
starts with `/animus`; the commenter must be a person on this Helix, matched by
their GitHub login, and anyone else is ignored silently, as is a comment
Animus posted (each carries a hidden marker). Comments and reactions are posted
with the person's own token, so they show as that person with the app's badge.

- `/animus <what you want>` gets a 👀 and a draft spec as a comment: the spec
  in a `markdown` block, written from the issue and your comment. Another
  `/animus <changes>` posts the revised draft as a new comment, and editing the
  draft comment by hand works too. One draft is open per person per issue, and
  GitHub and Slack drafts share the limit of 3 open per person, `draft_slots`
  and the 7-day expiry, after which the draft is discarded with a comment. A
  person with a Slack link is DMed a link to each draft and revision.
- `/animus submit` reads the spec block of the latest draft comment as it is on
  GitHub then, hand edits included, admits it as below and queues
  it as your job on that project, with a comment naming the job. A spec that
  is refused gets a comment with the list of problems, an incomplete
  spec, or a comment with no readable spec block, gets a comment saying so, and
  nothing is queued.
- `/animus discard` closes the draft with a comment.
- The pull request says `Closes #<issue>`, or `Refs #<issue>` when the
  project's profile has `issue_link: refs`
  ([configuration.md](configuration.md#the-project-profile)).
- The job comments on the issue when its pull request opens (the pull request
  says `Closes #<issue>`), when it fails, with the reason, and when it needs
  input, with the question. `/animus answer <text>` answers it and resumes the
  job, and `/animus cancel` cancels it. You still get your Slack DM thread.
- `submit`, `discard`, `answer` and `cancel` from anyone but the draft's or
  job's person, or the owner, get a one-line reply that only they may.
- A plain `/animus <what to change>` on an open pull request an Animus job
  opened is a fix: it gets a 👀 and queues a [fix](#fixes) with that text as
  its ask, as `animus start <pr> "<text>" --helix` does.
  `/animus fix <what to change>` does the same. When a job on this Helix
  pushed to the pull request, Helix fetches its review bodies and inline
  comments made since the last push of its latest job and gives them to the
  fix as references. The fix comments on the pull request when it pushed (what
  it changed, its cost and its job page), when it failed or was refused (the
  reason) and when it needs input (the question), and on nothing in between;
  `/animus answer <text>` and `/animus cancel` there act on it, and you still
  get your Slack DM thread. A fix from anyone but the pull request's author's
  person or the owner, one on a pull request whose description holds no spec
  block or that is merged or closed, or one while a fix is queued, running or
  waiting for an answer there (linked) gets a one-line reply and queues
  nothing.
- A `/animus` comment more than 24 hours old when Helix first sees it (left
  while Helix was down) is answered as too old and starts nothing.

`helix check` flags a project that no person's GitHub token can read comments
on: it is never watched, so a `/animus` there goes unanswered.

### Drafts know the project

A draft session is given the project's profile as text a script rendered from
it: the base branch, the gates, the types that run, and each UI target with its
pages. It still reaches nothing itself
([ADR 0003](adr/0003-draft-sessions-see-only-fetched-references.md)). When the
draft's spec has problems, admit's list goes back to the same session once, as
one more turn under the draft's $0.50 cap; a draft that still has problems is
posted with them listed. The posted draft, on GitHub and on Slack, carries
outside its spec a summary of the target, pages, gates, problems and warnings.
Submit is refused with the problems while any remain. A draft's criterion may
have no command, to be judged by the reviewer, but a `bug` spec, or a spec
where no criterion has one, is refused.

## Admit

Helix is where a spec is admitted for `POST /jobs`, Slack and GitHub
([ADR 0007](adr/0007-one-admit-for-every-entry-point.md),
[ADR 0008](adr/0008-helix-reads-the-profile-from-the-base-branch.md)). It
fetches the base branch (the spec's `base`, else the profile's) with the
person's token and reads `.animus/animus.yaml` from `origin/<base>` itself,
never from what the clone has checked out, so a clone left on another branch
cannot give a job an old profile.

- `POST /jobs` answers 400 with the whole list of problems for a spec that is
  refused, and queues nothing. A spec with `after:` is refused with a pointer
  to `animus start --local`, since Helix cannot follow an earlier job yet.
- A submit that carries the checkout's profile gets back `warnings` when it
  differs from the base branch's; `animus start --helix` prints them.
- A queued job is admitted again when it starts, since the profile may have
  changed while it waited. One that no longer passes ends as `refused`, before
  any work, with the list, and reports it where it reports (Slack, the issue).
  A job that is resumed was admitted when it first started.
- A base branch GitHub cannot be reached for, or one with no profile, ends the
  job or draft before any work, with the reason.

## Projects

Anyone on Helix adds a project from a checkout of it, with `animus project
add` or by asking Claude to. Helix clones it with that person's token, checks
the token may push, reads its `.animus/animus.yaml`, and runs the profile's
installs and setup once on its base branch, in the job image when jobs run in
containers. Only then are jobs taken for it. A project that fails the check
says why and can be added again.

GitHub is the member list: anyone on Helix whose token may push to a project
may submit for it. Only whoever added a project, or the owner, removes it
over the API; `helix remove-repo` removes any. Removing one deletes the clones Helix and
people's jobs made of it, and keeps a clone added with `add-repo`.

## Containers

With `container: {memory: 6g, cpus: 2}` in `config.yaml`, each job runs in a
Docker container of its own, from the image `helix image` builds
(`helix/deploy/image/Dockerfile`). It sees only its submitter's folder under
`~/.helix/people/` (their clone, job state and Claude config), Animus
read-only and their credentials, with no Docker socket and no published port.
Without it, jobs run in worktrees on the machine and share its tools, ports
and network.

## Running unattended

[helix/deploy/ubuntu/setup.sh](../helix/deploy/ubuntu/setup.sh) sets up an Ubuntu machine:
an account for Helix, Node 24, no sleep, and a systemd unit that starts it at
boot and again whenever it stops. Anything else that does that works too.
With Tailscale, leave `host` at 127.0.0.1, run `tailscale serve
--service=svc:helix --https=443 127.0.0.1:7420` once, and approve the service
in the admin console: the tailnet reaches Helix at
`https://helix.<tailnet>.ts.net`, a name that stays when Helix moves machine.
Without something like it, traffic is plain HTTP: keep Helix on a private
network.

To also see the display from the office network with Tailscale off, set
`host: 0.0.0.0`, restart Helix, and let the LAN through the firewall to the
port (`sudo ufw allow from <lan>/24 to any port 7420 proto tcp`). Tailscale
Serve keeps working, since it still forwards to 127.0.0.1. With avahi
running, as on Ubuntu desktop, the machine answers to `<hostname>.local`, so
the display is at `http://<hostname>.local:7420` whatever address DHCP gives
it. Anyone on that network can then read the display, and a token sent
there travels in plain HTTP, so keep `url:` and `animus` on the Tailscale
address and use the LAN one in a browser only.

A job that was running when Helix stopped is queued again when it comes back
and resumes from its own files; one found running three times is ended
instead. `helix upgrade` stops starting jobs, waits for running ones, checks
out the tag and runs the tests, goes back if they fail, then stops `helix
serve` for its service manager to start again. `npm run deploy -- <ssh-host>`
moves it to the release `stable` points at ([releases.md](releases.md)).

## Fixes

A fix runs where its session is: on the laptop whose job opened the pull
request, and on Helix when a job here opened it or no session can be reached
([cli.md](cli.md#fixing-a-pull-request)). `animus start <pr> "<text>"` from
a laptop that has joined this Helix, when no job on that laptop opened the
pull request (or with `--helix`), or a plain `/animus <text>` comment on the
pull request ([GitHub comments](#github-comments)),
submits a **fix** to `POST /jobs/fix` and prints where to watch it, as
`animus submit` does. A comment reaches only Helix: a laptop never watches
GitHub.

Helix fixes any open pull request an Animus job opened, wherever it ran, and
tells one from GitHub itself: its description holds Animus's spec block and
its author's GitHub login is a person on this Helix, the person the job opened
it for. One without the spec block is refused with a one-line 400, one whose
author is not a person here with a 403, and one merged or closed, or with a
fix queued, running or waiting for an answer on it here, with a 409 naming
that fix. Only the author's person, or the owner, may ask; anyone else gets a
one-line 403.

The fix is a job of its own, queued like any other, that runs as the author's
person, whose token pushes to the branch. When a job on this Helix opened or
last pushed to the pull request, the fix continues it: that job's folder holds
the worktree, the session it resumes and the personal skills it uses.
Otherwise it runs from the pull request alone: the spec from its description,
the branch from GitHub and a fresh session, with the skills sent with the fix
only when the author asked for it, and none otherwise. Helix keeps no person's
personal skills between jobs. Helix starts it only as an `animus fix` process,
in a new container where containers are on; a container is never kept, and the
session lives in the person's Claude config, so it resumes across containers.
A fix is not admitted again: the process reads the spec of the job it
continues, or of the pull request. Its push is never forced, so one whose
branch changed on GitHub while it ran pushes nothing and ends failed with "the
branch changed while this fix ran: fix again". Its job page names and links
the job it fixes.

## Lessons

`helix serve` looks hourly (first, fifteen minutes after it starts) for a
ready project with no retro in the last 7 days and runs `animus retro
--project <name> --json` for it, in a process of its own as Helix's account.
The time is kept in `helix.db` when the retro starts, so one that fails, or
has no runs to read, waits for next week. The lessons are kept in Helix's own
Animus home (`ANIMUS_HOME`, `~/.animus` unless set). The retro reads the run
records there and, with containers, in each person's Animus home too, where
those jobs write theirs (Helix hands them over in `ANIMUS_RETRO_HOMES`). A
container job gets Helix's `lessons.json` read-only (`ANIMUS_LESSONS_FILE`)
once there is one, and Helix counts the uses from the `lessons` ids on the
run line the job wrote when it ends. When a retro proposed any, the Slack
channels set for the project with `/animus project <name>` get a message with
the count and `animus lessons`. `animus lessons` and `accept` / `dismiss`
from a checkout of a Helix project call `GET /lessons` and
`POST /lessons/<id>` instead of reading the laptop's file. They say where they
acted; `accept` and `dismiss` stop, rather than act on this machine's own
lessons, when a Helix you are signed in to does not answer (`--local` is the
way to say you mean this machine).

## Cleanup

`helix serve` runs `helix cleanup` ten minutes after it starts and then
once a day, in a process of its own; `helix cleanup [--days <n>]
[--dry-run]` runs it by hand. It:

- runs `animus cleanup` in each person's Animus home
  (`~/.helix/people/<person>/animus`) with their credentials: a merged or
  closed PR's worktree goes at once and its branches `--days` after it
  ended (default 30). Without containers it runs once, as the machine's
  account.
- removes `animus-job` images of other releases. Docker refuses one a
  container still uses, and the next run tries again.

Every job's record stays for analysis: Helix's own folder of it
(`~/.helix/jobs/<id>/`: the spec and `log.txt`), its row in `helix.db`,
and the person's job folders and Claude transcripts.

A job's UI server (`animus ui up`, `animus shots`) is stopped when the job's
process ends, however it ends, so a cancelled job leaves nothing serving.

## The display

Helix serves a page at its own address showing the slots, each running job's
stage, the queue, jobs waiting for an answer, the ten newest open pull
requests its jobs opened (drafts marked), and the jobs that failed or were
cancelled. Helix finds the open PRs by asking GitHub, once a minute per
project, with the GitHub token of the person whose job opened one; a PR
whose person has left Helix is not listed. It needs
no sign-in: anyone who can reach Helix can read it. It only reads; submitting,
answering and cancelling need a person's token. Click a project to narrow the
page to it; `?theme=dark` or `?theme=light` fixes the theme.

Every job on it links to its own page, `/jobs/<id>`, an address that can be
shared and opened cold. A job page needs a sign-in: paste your Helix token
(`~/.animus/helix.json`), or open an address ending `#token=<token>`, which
that browser keeps and takes out of the address bar; `animus ui --helix`
opens Helix that way, signed in as you. Sign out from the
header. Do not sign in on a shared wall screen: the token can also submit and
cancel jobs as you.

Every person named on the overview or a job page links to their page,
`/people/<name>`. `/people` (the header's PEOPLE) lists each person on the
Helix, for anyone signed in: their GitHub login, the day they joined (blank
for a person who joined before Helix kept it), jobs submitted, PRs opened,
total spent and their last activity. Someone who has left is not listed.

A person's page, `/people/<name>`, shows those numbers, their jobs newest first
(thirty at a time, with SHOW MORE for older ones), each linking to its job page,
and their activity newest first: what they submitted, answered (with the
answer's text), cancelled, joined, left, and the projects they added or
removed. Their jobs come from the jobs table, so jobs from before Helix kept
activity show too. Someone who has left keeps a page that says so.

The same page is also the local display, `animus ui`, which answers the same
shapes from `~/.animus` with `local` set on `GET /display`. Its job ids are
the jobs' folder names (`/jobs/<name>`), it needs no sign-in, and it has no
people pages: those are Helix's alone. The files both serve and the reading of
a job's folder live in the plugin (`plugin/src/assets.ts`,
`plugin/src/job-folder.ts`), which Helix imports.

A job page shows the job's project, person, state, outcome, pull request,
cost and times; its spec as submitted; how long it spent in each stage,
summed over its runs, and its slices when it was cut; the checks of its
latest gate run, with what a failed one printed; every review round's
findings; each question it asked with the answer it was given; its latest
screenshots, for a UI job; and Helix's log of it. The checks, reviews,
questions and screenshots come from the job's Animus folder, which keeps each gate run as `gates/run-<n>.txt`. While the job is
queued or running the page reads it again every two seconds and keeps the log
at its end, unless you have scrolled up in it; once it has ended the log is
there whole.

## HTTP API

Every route but the display's pages, `/display`, `/version`, `/invite` and
`/join` needs a person's Helix token as `Authorization: Bearer <token>`. The
client sends its version, and Helix answers 426 to one it cannot work with;
the display's own request for a job page's data sends none.

| Route | What it does |
| --- | --- |
| `GET /` | The display page |
| `GET /jobs/<id>`, `/people`, `/people/<name>` | The display page, to a browser asking for HTML |
| `GET /jobs/<id>/page-data` | What a job page shows, for any person; besides the job's folder it carries `run` (fix rounds, flaky checks, each agent session's cost and tool calls, review findings' fates, `animus tools` as text), `after` (human commits and lines after the job, the 30-day watch) and `lessons` citing the job |
| `GET /people/page-data` | What the people list shows, for any person |
| `GET /people/<name>/page-data[?before=<job id>]` | What a person's page shows: their numbers, thirty jobs older than that one, and all their activity; 404 for a name Helix never heard of |
| `GET /insights-data[?scope=<project>]` | What the Insights page (`/insights`) shows, for any person: `{ at, scope, projects, runs, outcomes, lessons }`, the run lines of the last 60 days from Helix's own Animus home and each person's (trimmed to what the page sums), the outcomes of their PRs, and Helix's lessons; `scope` is `factory` (the default) or a project's name, which keeps only that project's runs and lessons |
| `GET /job-list[?result=&project=&person=&before=<submitted>]` | What the Jobs page (`/jobs`) shows, for any person: `{ at, jobs, more }`, thirty jobs newest first from the whole table, filtered by result (`all`, `merged`, `open`, `failed`, `needs input`), project and person, each with `pr_state` (`open`, `merged`, `closed`) where GitHub has said, and `fix_rounds` where its gates ran; 400 for an unknown result |
| `GET /jobs/<id>/shots/<name>` | One of a job's screenshots, by its name in `shots/manifest.json`; nothing outside its shots folder |
| `GET /display` | What the display shows, as JSON, with the open PRs of the jobs (`prs`) |
| `GET /version` | Helix's version |
| `POST /invite` | Who an invite code is for, and the projects there |
| `POST /join` | Join with a code and both tokens; returns the Helix token |
| `POST /leave` | Take yourself off; refused for the owner |
| `POST /people` | The owner only: invite `name`, optionally with `github` and `slack` |
| `DELETE /people/<name>` | The owner only: take a person off, as `helix remove-person` does |
| `GET /projects` | The projects |
| `POST /projects` | Add a project; its check runs in the background (202) |
| `GET /projects/<name>` | One project, with its check's log |
| `DELETE /projects/<name>` | Remove a project you added, or any for the owner |
| `GET /lessons[?project=<name>]` | The lessons in Helix's Animus home, with a project's and the factory's only when one is named: `{ lessons }` |
| `POST /lessons/<id>` | `action`: `accept` or `dismiss` (404 for an unknown id, 409 for one that cannot change that way); the lesson |
| `GET /jobs` | The slots and your jobs; `?all`, every person's, for the owner only |
| `POST /jobs` | Submit: `repo`, `spec`, and optionally `name`, `draft`, `skills`, `profile` (the checkout's profile text, to warn when it differs from the base branch's). The spec is admitted first: 400 with the list of problems when it is refused; the answer's `warnings` when it is admitted with any |
| `POST /jobs/fix` | Submit a fix (`animus start <pr>`): `repo`, `pr` (a number, `#number` or URL) and `ask`, and optionally `skills`. 400 when its description holds no spec block, 404 when GitHub has no such pull request, 403 when its author is not a person here or for anyone but the author's person or the owner, 409 when it is merged or closed or a fix is queued, running or waiting for an answer; the answer is the job, as submit's |
| `GET /jobs/<id>` | One job, with the end of its log |
| `POST /jobs/<id>/answer` | Answer its question (`answer`); it is queued again |
| `POST /jobs/<id>/cancel` | Cancel your job, or anyone's for the owner |
