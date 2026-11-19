# Deploying Helix

Helix keeps nothing that cannot be copied or made again. What a machine
running it holds:

| What | Where (the account `desmond` on abstergo) | Can be made again? |
| --- | --- | --- |
| This repository, at a release tag | `~/animus` | yes: clone it |
| Helix's config; `helix.db` with people's token hashes, the projects and the queue; credentials files; project secrets (`secrets/`); each job's spec and log; the clones Helix made of projects people added (`repos/`) | `~/.helix` | no: copy it |
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
9. Optionally, the Slack bot ([below](#the-slack-bot)), so invites go out
   from Slack and people follow their jobs there.
10. Optionally, Helix's GitHub App ([below](#the-github-app)), so people
    join by approving GitHub's sign-in instead of pasting a token. Set it up
    before inviting anyone.

## The GitHub App

With the app, `animus join` shows a GitHub code to approve instead of asking
for a fine-grained token, and Helix refreshes each person's short-lived token
before every job. It lives under an organisation you own (or are a GitHub App manager of),
written `<org>` below.

1. Go to `https://github.com/organizations/<org>/settings/apps/new`
   (the organisation's **Settings**, **Developer settings**, **GitHub Apps**,
   **New GitHub App**) and fill it in from
   [helix/deploy/github/manifest.json](../helix/deploy/github/manifest.json):
   - **GitHub App name** and **Homepage URL**: its `name` and `url`.
   - **Callback URL**: leave empty. Leave **Expire user authorization
     tokens** ticked: Helix refreshes them.
   - **Enable Device Flow**: tick it. Helix signs people in with nothing
     but it.
   - **Webhook**: untick **Active**. Helix takes no events from GitHub.
   - **Repository permissions**: Contents read and write, Pull requests read
     and write; Metadata read-only comes with them. Nothing else: Workflows in
     particular would let a job change CI, which the factory keeps for people.
     A permission changed later reaches an installation only once its owner
     accepts it (its **Settings**, **GitHub Apps**, the app, **Review
     request**); until then Helix refuses jobs for its repositories, saying so,
     and `animus join` lists them.
   - **Logo**: [helix/deploy/github/logo.png](../helix/deploy/github/logo.png).
   - **Where can this GitHub App be installed?**: **Any account**, so
     projects outside `<org>` can install it too.
2. **Create GitHub App**. On its page, under **About**, copy the **Client
   ID** (`Iv23…`). Helix needs no client secret and no private key, but
   GitHub will not install an app without one: generate one, and keep it off
   the Helix machine (a password manager, or delete it).
3. **Install App**, and install it on `<org>` with the repositories Helix
   takes jobs for (or all of them). The owner of any other project installs
   it on theirs from the app's public page,
   `https://github.com/apps/<app-name>/installations/new`; `animus join`
   and a refused job both print that link.
4. On the Helix machine, as Helix's account, run
   `helix/bin/helix github setup <client-id>`. It tries the ID with a
   device-code request, then writes `github: {client_id}` to `config.yaml`.
   An ID GitHub refuses (most often, device flow is not ticked) is reported
   with GitHub's reason, and nothing is written.
5. `sudo systemctl restart helix.service`. From then on, invites join with
   GitHub's sign-in.

Each person's access and refresh tokens are in
`~/.helix/credentials/<name>.env` (mode 600), never in the folder their jobs
mount. Their current access token alone is also in
`~/.helix/tokens/<name>/gh-token`, mounted read-only into their jobs, which
read it each time they push: Helix renews it in its last hour, and GitHub ends
the old one at once. A job fails with "run `animus github login`" when GitHub stops taking
someone's sign-in (they revoked it, or it went unused for six months); that
command signs them in again, as the same GitHub account.

## The Slack bot

The bot lets you invite people from Slack and posts each job's progress to
the person who started it ([helix.md](helix.md#slack)). It reaches Slack over
Socket Mode, so Helix opens no port for it. You need to be allowed to add
apps to the workspace.

1. Go to <https://api.slack.com/apps>, **Create New App**, **From a
   manifest**, and pick the workspace. Paste
   [helix/deploy/slack/manifest.yaml](../helix/deploy/slack/manifest.yaml)
   on the YAML tab, then **Create**. Rename the app if you like; keep the
   `/animus` command, the scopes, the `message.im` event and Socket Mode as
   they are, since Helix depends on each. Under **Basic Information**,
   **Display Information**, give it the same icon as the GitHub App,
   [helix/deploy/github/logo.png](../helix/deploy/github/logo.png); a
   manifest cannot carry one.
2. **Install App** (or **OAuth & Permissions**), **Install to Workspace**,
   and allow it. Keep the **Bot User OAuth Token** (`xoxb-…`) it shows.
3. **Basic Information**, **App-Level Tokens**, **Generate Token and
   Scopes**: any name, the scope `connections:write`. Keep the token
   (`xapp-…`).
4. In Slack, open the owner's profile, **⋮**, **Copy member ID** (`U…`).
   That Slack user is the bot's owner, the only one who may invite and link.
5. Check `url` is set in `config.yaml`: the line the bot DMs joins at it.
6. On the Helix machine, as Helix's account, name the owner first if there
   is none (`helix/bin/helix owner <person>`), then run
   `helix/bin/helix slack setup`. It asks for the two tokens and the owner's
   member ID, tries both tokens against Slack, keeps them in
   `~/.helix/credentials/slack.env` (mode 600), adds `slack: {enabled:
   true}` to `config.yaml` and links that Slack user to the owner. A token
   Slack refuses is reported with Slack's reason, and nothing is written.
7. `sudo systemctl restart helix.service`. Its log says `Slack: connected`.
8. Anywhere in Slack, send `/animus invite @alex alex-gh`; only you see the
   bot's reply.
   Alex gets a DM to connect Tailscale, then one line that installs Animus
   and joins. Someone who joined before the bot was there is linked with
   `/animus link @alex alex`.

To turn the bot off, set `enabled: false` under `slack:` in `config.yaml`
and restart Helix. To give it a new token, run `helix slack setup` again.
`slack.env` is under `~/.helix`, so it moves with the rest of it.

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
restart. `helix/deploy/ubuntu/setup.sh` is only the Ubuntu way to set this up.

## Someone leaves

On the Helix machine, run `helix/bin/helix remove-person <name>`. Their token
stops working within two seconds. Their queued and running jobs are
cancelled, their credentials file under `~/.helix` is deleted, and their
Slack link is removed. It then
prints what is left to do elsewhere: revoke their GitHub token and take them
off the organisation, take them off your Claude organisation, remove them
from the tailnet, and deal with their open `animus/*` pull requests. Their
folder under `~/.helix/people/` is deleted; their past jobs stay on the
display, and `helix cleanup` removes Helix's folders of them once they are
old.
