# Deploying Helix

Helix keeps nothing that cannot be copied or made again. What a machine
running it holds:

| What | Where (the account `desmond` on abstergo) | Can be made again? |
| --- | --- | --- |
| This repository, at a release tag | `~/animus` | yes: clone it |
| Helix's config; `helix.db` with people's token hashes, the projects and the queue; credentials files; each job's spec and log; the clones Helix made of projects people added (`repos/`) | `~/.helix` | no: copy it |
| Each job's state, gate output, review and transcripts; the run log | `~/.animus` | no: copy it to keep history and resume jobs |
| Clones added by hand with `helix add-repo`, and their worktrees | `~/repos`, `~/repos/.worktrees` | yes: clone over https |
| Claude Code, gh, Node 24, agent-browser's Chrome | `~/.local/bin`, `/usr/local/bin`, `~/.agent-browser` | yes |
| The service, Tailscale Serve, no sleep, the browser sandbox | set up by `helix/deploy/ubuntu/setup.sh` | yes |

`helix.db` names the projects' clones and the credentials files by absolute
path. Keep the same account name and the same folders, and a copy of
`~/.helix` works as it is.

## A new machine (Ubuntu), about half an hour

1. Install Ubuntu, sign in once, install Tailscale and `tailscale up`.
2. From your Mac: `scp helix/deploy/ubuntu/setup.sh NEW: && ssh -t NEW sudo
   NEW_HOST=<name> bash setup.sh`. Then sign in as the new account and run
   `finish.sh` to remove the one you set up from.
3. As that account: install Claude Code and `gh`. Clone this repository into
   `~/animus` (a read-only deploy key) and check out the release the team
   runs: `git checkout v<version> && npm ci`.
4. Nothing to clone: once people have joined (step 8), each runs `animus
   project add` from a checkout of a project, and Helix clones it with their
   token. To add one by hand instead, clone it over https into
   `~/repos/<name>` and run `helix/bin/helix add-repo <name> ~/repos/<name>`.
5. Set `url` in `config.yaml` to the address people will reach Helix at
   (`https://helix.<tailnet>.ts.net`, step 7). For each person run `helix invite
   <name>` and send them the command it prints; they run it on their laptop
   once Helix is up (step 7). By hand instead: write their
   `~/.helix/credentials/<name>.env` (mode 600, with
   `CLAUDE_CODE_OAUTH_TOKEN` and `GH_TOKEN`) and run `helix add-person <name>
   --env-file` with it; each gets a new Helix token.
6. For jobs in containers (recommended once more than one person submits):
   install Docker, run setup.sh again for the docker group, run `helix/bin/helix
   image`, and add `container: {memory: 6g, cpus: 2}` to `config.yaml`.
7. Run `helix/bin/helix check`. Then `sudo systemctl start helix.service` and
   `tailscale serve --service=svc:helix --https=443 127.0.0.1:7420`, which gives Helix
   its own name on the tailnet, `https://helix.<tailnet>.ts.net`, apart from
   the machine's. The machine needs a tag, and the service needs approving
   once in Tailscale's admin console (Services).
8. From a laptop, `animus join <url> <code>`, then `animus doctor`, then
   `animus project add` from a checkout of each project.

## Moving abstergo to new hardware, keeping everything

1. On the old machine, wait for running jobs to end (`animus status`), then
   `sudo systemctl stop helix.service`.
2. Set up the new machine with steps 1 to 3 above, using the same account
   name.
3. Copy the state across: `rsync -a ~/.helix ~/.animus ~/repos NEW:`. Do it
   as that account on both machines, so the files keep their owner and the
   credentials files stay mode 600.
4. On the old machine: `tailscale serve clear svc:helix`.
5. On the new machine: `helix check`, start the service, and run
   `tailscale serve --service=svc:helix --https=443 127.0.0.1:7420`. Give it the old
   machine's tag and approve it as `svc:helix`'s host in the admin console.
   The address stays `https://helix.<tailnet>.ts.net`, so what each laptop
   kept when it joined still works, and their Helix tokens still work because
   the hashes came across. A job that was waiting for an answer resumes
   there when it is answered.

## Another system

Helix needs Node 24, git, gh, Claude Code, and something that starts `helix
serve` at boot and starts it again when it stops: launchd on a Mac, a
Windows service, or any process supervisor. `helix upgrade` depends on that
restart. To follow releases there too, run `helix/bin/helix upgrade
--follow` from that system's scheduler every 15 minutes, as the account
Helix runs as. `helix/deploy/ubuntu/setup.sh` is only the Ubuntu way to set this up.

## Someone leaves

On the Helix machine, run `helix/bin/helix remove-person <name>`. Their token
stops working within two seconds. Their queued and running jobs are
cancelled, and their credentials file under `~/.helix` is deleted. It then
prints what is left to do elsewhere: revoke their GitHub token and take them
off the organisation, take them off your Claude organisation, remove them
from the tailnet, and deal with their open `animus/*` pull requests. Their
past jobs stay on the display and in `~/.animus` until `animus cleanup`
removes them.
