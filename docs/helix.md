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
at, which `helix invite` puts in the join command it prints), `name` (what the
display calls the machine) and `container`. Helix reads it again when it
changes, for the slots; host and port need a restart. People and projects are
in `helix.db`, so changing either needs no restart. A `config.yaml` from
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
as that login is taken.

Each job runs with its submitter's tokens only, so its pull request is
theirs. `animus leave`, or `helix remove-person`, takes someone off; the
latter prints what is left to revoke on GitHub, Claude and Tailscale.

`helix check` asks the services themselves: who the GitHub token is and when
it ends, whether it may push to each project (a push that sends nothing), and
whether the Claude token answers. It exits 1 if anything but a push fails. A
refused push shows as `no`: nobody has to reach every project. Before each
job, Helix checks the GitHub token again with a push to that job's project,
so a token that ended or may not push fails the job at once with the reason.

## Projects

Anyone on Helix adds a project from a checkout of it, with `animus project
add` or by asking Claude to. Helix clones it with that person's token, checks
the token may push, reads its `.animus/animus.yaml`, and runs the profile's
installs and setup once on its base branch, in the job image when jobs run in
containers. Only then are jobs taken for it. A project that fails the check
says why and can be added again.

GitHub is the member list: anyone on Helix whose token may push to a project
may submit for it. Only whoever added a project removes it over the API;
`helix remove-repo` removes any. Removing one deletes the clones Helix and
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
stage, the queue, jobs waiting for an answer, and jobs that ended. It needs
no sign-in: anyone who can reach Helix can read it. It only reads; submitting,
answering and cancelling need a person's token. Click a project to narrow the
page to it; `?theme=dark` or `?theme=light` fixes the theme.

Every job on it links to its own page, `/jobs/<id>`, an address that can be
shared and opened cold. A job page needs a sign-in: paste your Helix token
(`~/.animus/helix.json`), or open an address ending `#token=<token>`, which
that browser keeps and takes out of the address bar. Sign out from the
header. Do not sign in on a shared wall screen: the token can also submit and
cancel jobs as you. `/people` and `/people/<name>` are still to come.

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
| `GET /jobs/<id>/page-data` | What a job page shows, for any person |
| `GET /jobs/<id>/shots/<name>` | One of a job's screenshots, by its name in `shots/manifest.json`; nothing outside its shots folder |
| `GET /display` | What the display shows, as JSON |
| `GET /version` | Helix's version |
| `POST /invite` | Who an invite code is for, and the projects there |
| `POST /join` | Join with a code and both tokens; returns the Helix token |
| `POST /leave` | Take yourself off |
| `GET /projects` | The projects |
| `POST /projects` | Add a project; its check runs in the background (202) |
| `GET /projects/<name>` | One project, with its check's log |
| `DELETE /projects/<name>` | Remove a project you added |
| `GET /jobs` | The slots and the queue |
| `POST /jobs` | Submit: `repo`, `spec`, and optionally `name`, `draft`, `skills` |
| `GET /jobs/<id>` | One job, with the end of its log |
| `POST /jobs/<id>/answer` | Answer its question (`answer`); it is queued again |
| `POST /jobs/<id>/cancel` | Cancel it |
