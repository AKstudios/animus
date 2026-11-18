---
name: helix
description: Run Animus's Helix commands for the person - add a project to Helix, list or remove projects, submit a spec there, follow, answer or cancel a job there, join or leave a Helix. Use when the person asks for any of these, or asks what is on Helix or how a Helix job is going.
---

Helix is the shared machine that runs Animus jobs for a team. The person asks, and you run the command; `animus` below is `${CLAUDE_PLUGIN_ROOT}/bin/animus`. Each command says what Helix answered: pass that on in a line or two, not the whole output.

If a command says this machine has not joined a Helix, ask the person for the invite command whoever runs Helix gave them.

## Projects

- Add: from a checkout of the repository, `animus project add` (or `animus project add <name>` when the person names it). Helix clones the repository with the person's GitHub token, checks the token may push, reads `.animus/animus.yaml` and runs its setup once. That can take several minutes, so run it with the Bash tool's `run_in_background` and report when it ends. If it is refused for having no profile, offer to run `animus init`, then to commit and push what it drafts once the person has read it, and add the project again. If it fails for the token, the person adds the repository to their GitHub token on GitHub (Settings, Developer settings, Fine-grained tokens); you cannot do that for them.
- List: `animus project list`.
- Remove: `animus project remove <name>`. Only whoever added a project may remove it. If Helix refuses because someone else added it, say who and that they, or whoever runs Helix, can remove it. Do not retry or look for another way.

Anyone on Helix may submit for any project their GitHub token may push to: there is no member list to add people to.

## Jobs

- Submit: `animus submit <spec.md>` from a checkout of the project (`--draft` for a draft pull request). It returns at once with the job's number; the job runs on Helix, so this session need not stay open. The person's own skills in `~/.animus/config.yaml` go with it. Give the person both links it prints under `watch it:` (Tailscale and office network, whichever Helix has); for a job started on this machine instead (`animus start --local`), offer to run `animus ui` in the background and, on a yes, do.
- Follow: `animus status` for the queue, `animus status <id>` for one job, its links and the end of its log.
- A job that asks a question: tell the person the question, and send their answer with `animus answer <id> "<answer>"`. Never answer for them.
- Cancel: `animus cancel <id>`, only when the person asks. Only whoever submitted a job may cancel it.

## Joining and leaving

- `animus join <url> <code>` asks for two tokens in the terminal, so the person runs it themselves: ask them to type `! animus join <url> <code>`.
- `animus leave` cancels the person's jobs on Helix and deletes their tokens there. Run it only when they ask, as `animus leave --yes`.
