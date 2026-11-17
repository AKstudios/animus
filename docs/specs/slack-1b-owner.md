---
size: medium
difficulty: risky
type: backend
after: docs/specs/slack-2-control-from-threads.md
---
# The owner runs Helix from their laptop

## Problem

Inviting or removing people, removing someone else's project and cancelling
someone else's job all need an ssh session on the Helix machine. The Slack
bot knows an owner only as a Slack user id in `config.yaml`, unrelated to
anyone who has joined Helix.

## Solution

The owner is a person on Helix, named on the machine with `helix owner
<person>`. From their own laptop, with their own Helix token, they invite and
remove people, remove any project, cancel any job and see every job. In
Slack, the owner is whoever is linked to that person.

## Acceptance criteria

1. On the machine, `helix owner ajmal` makes the person `ajmal` the owner
   (`owner: ajmal` in `config.yaml`); naming someone who is not on Helix is
   refused. With the owner's token, `animus invite sam --github sam-gh
   [--slack U123]` prints the same join line `helix invite` does; from anyone
   else it is refused with who the owner is.
   $ sh scripts/with-tmp.sh node --disable-warning=ExperimentalWarning --test helix/test/owner.test.ts
2. With the owner's token, `animus remove-person sam` does what `helix
   remove-person sam` does and prints the same checklist; from anyone else it
   is refused.
   $ sh scripts/with-tmp.sh node --disable-warning=ExperimentalWarning --test helix/test/owner.test.ts
3. The owner's `animus project remove <name>` removes any project, under the
   same rule that none of its jobs is queued or running; others still remove
   only projects they added.
   $ sh scripts/with-tmp.sh node --disable-warning=ExperimentalWarning --test helix/test/owner.test.ts
4. The owner's `animus cancel <id>` cancels anyone's job, and `animus status
   --all` lists every person's jobs with whose each is; for anyone else
   `--all` is refused and `cancel` works on their own jobs only.
   $ sh scripts/with-tmp.sh node --disable-warning=ExperimentalWarning --test helix/test/owner.test.ts
5. `animus leave` from the owner, and `remove-person` of the owner from any
   path, are refused with "name another owner first: helix owner <person> on
   the machine".
   $ sh scripts/with-tmp.sh node --disable-warning=ExperimentalWarning --test helix/test/owner.test.ts
6. In Slack, the owner is the Slack user linked to the owner person: only
   they invite, link, and cancel other people's jobs. `helix slack setup`
   asks for the owner's Slack user and links it to the owner person, and
   refuses to run while there is no owner. `slack.owner` is gone from
   `config.yaml`; one left there from an earlier setup is moved into a link
   when Helix starts.
   $ sh scripts/with-tmp.sh node --disable-warning=ExperimentalWarning --test helix/test/slack-invite.test.ts helix/test/slack-control.test.ts helix/test/owner.test.ts
7. docs/helix.md, docs/cli.md and docs/configuration.md describe the owner,
   `helix owner` and the owner's commands.

## Decisions

- One owner, a person's name in `config.yaml` as `owner:`. Only `helix
  owner` on the machine sets it: shell access is the root of trust.
- The owner is checked by Helix on each request from the person's own Helix
  token; there is no second token or role table.
- The owner's laptop commands are invite, remove-person, removing any
  project, cancelling any job and `status --all`. `upgrade`, `image`, `slack
  setup`, `helix owner` and editing `config.yaml` stay on the machine.
- The owner cannot leave or be removed until another owner is named.
- Neither `slack.owner` nor the owner exists in a release yet, so no
  Breaking entry in CHANGELOG.md.
- Terms are in GLOSSARY.md: owner, person, invite, Slack link.

## Out of scope

- Several owners or roles.
- Changing the machine (upgrades, images, Slack tokens) from a laptop.
