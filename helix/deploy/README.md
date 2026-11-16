# Running Helix on another machine

Helix keeps nothing that cannot be copied or made again. What a machine
running it holds:

| What | Where (the account `desmond` on abstergo) | Can be made again? |
| --- | --- | --- |
| This repository, at a release tag | `~/animus` | yes: clone it |
| Helix's config, people's token hashes and credentials files, the queue, each job's spec and log | `~/.helix` | no: copy it |
| Each job's state, gate output, review and transcripts; the run log | `~/.animus` | no: copy it to keep history and resume jobs |
| The repositories jobs run in, and their worktrees | `~/repos`, `~/repos/.worktrees` | yes: clone over https |
| Claude Code, gh, Node 24, agent-browser's Chrome | `~/.local/bin`, `/usr/local/bin`, `~/.agent-browser` | yes |
| The service, Tailscale Serve, no sleep, the browser sandbox | set up by `ubuntu/setup.sh` | yes |

`config.yaml` names the repositories and credentials files by absolute path.
Keep the same account name and the same folders, and a copy of `~/.helix`
works as it is. Otherwise edit those paths in `config.yaml`.

## A new machine (Ubuntu), about half an hour

1. Install Ubuntu, sign in once, install Tailscale and `tailscale up`.
2. From your Mac: `scp helix/deploy/ubuntu/setup.sh NEW: && ssh -t NEW sudo
   NEW_HOST=<name> bash setup.sh`. Then sign in as the new account and run
   `finish.sh` to remove the one you set up from.
3. As that account: install Claude Code and `gh`. Clone this repository into
   `~/animus` (a read-only deploy key) and check out the release the team
   runs: `git checkout v<version> && npm ci`.
4. Clone each repository over https into `~/repos/<name>`, then run
   `helix/bin/helix add-repo <name> ~/repos/<name>` for each one.
5. For each person: write their `~/.helix/<name>.env` (mode 600, with
   `CLAUDE_CODE_OAUTH_TOKEN` and `GH_TOKEN`) and run `helix add-person <name>
   --env-file ~/.helix/<name>.env`. Each gets a new Helix token.
6. Run `helix/bin/helix check`. Then `sudo systemctl start helix.service` and
   `tailscale serve --bg 7420`.
7. From a laptop, run `animus doctor` with the new `HELIX_URL`.

## Moving abstergo to new hardware, keeping everything

1. On the old machine, wait for running jobs to end (`animus status`), then
   `sudo systemctl stop helix.service`.
2. Set up the new machine with steps 1 to 3 above, using the same account
   name.
3. Copy the state across: `rsync -a ~/.helix ~/.animus ~/repos NEW:`. Do it
   as that account on both machines, so the files keep their owner and the
   credentials files stay mode 600.
4. In Tailscale's admin console, rename or remove the old machine, then name
   the new one `abstergo`. The URL stays
   `https://abstergo.<tailnet>.ts.net`, so nobody's `HELIX_URL` changes, and
   their Helix tokens still work because the hashes came across.
5. On the new machine: `helix check`, start the service, and run
   `tailscale serve --bg 7420`. A job that was waiting for an answer resumes
   there when it is answered.

## Another system

Helix needs Node 24, git, gh, Claude Code, and something that starts `helix
serve` at boot and starts it again when it stops: launchd on a Mac, a
Windows service, or any process supervisor. `helix upgrade` depends on that
restart. `setup.sh` is only the Ubuntu way to set this up.

## Someone leaves

On the Helix machine, run `helix/bin/helix remove-person <name>`. Their token
stops working within two seconds. Their queued and running jobs are
cancelled, and their credentials file under `~/.helix` is deleted. It then
prints what is left to do elsewhere: revoke their GitHub token and take them
off the organisation, take them off your Claude organisation, remove them
from the tailnet, and deal with their open `animus/*` pull requests. Their
past jobs stay on the display and in `~/.animus` until `animus cleanup`
removes them.
