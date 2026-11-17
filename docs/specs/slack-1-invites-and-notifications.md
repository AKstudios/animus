---
size: large
difficulty: risky
type: backend
---
# Invite teammates and follow jobs from Slack

## Problem

Inviting a teammate means running `helix invite` on the machine and passing
the join command along by hand, and the teammate has to install Animus first.
Once a job is running, the only way to see it, or see that it needs an
answer, is the CLI or the display page.

## Solution

Helix has a Slack bot. The owner invites someone with `/helix invite @alex
alex-gh`; Alex gets a DM with one line to paste that installs Animus if
needed and joins. Joining links Alex's Slack user to their person on Helix.
Every job a linked person starts, from anywhere, posts its progress to one DM
thread.

## Acceptance criteria

1. The owner runs `helix slack setup`, gives the bot token, the app token and
   their own Slack user; both tokens are tried against Slack, written to
   `~/.helix/credentials/slack.env` (mode 600), and `config.yaml` gets `slack:
   {enabled: true, owner: U…}`. A token Slack refuses is reported with Slack's
   reason and nothing is written.
   $ sh scripts/with-tmp.sh node --disable-warning=ExperimentalWarning --test helix/test/slack-setup.test.ts
2. The owner sends `/helix invite @alex alex-gh` (or runs `helix invite alex
   --github alex-gh --slack U123`), and Alex gets a DM saying to connect
   Tailscale first, with one line: `curl -fsSL …/install.sh | bash -s -- join
   <url> <code>`. A Slack invite without a GitHub login is refused, and anyone
   but the owner who sends `/helix invite` gets a private refusal.
   $ sh scripts/with-tmp.sh node --disable-warning=ExperimentalWarning --test helix/test/slack-invite.test.ts
3. When Alex joins with that code, Alex's Slack user is linked to the person
   `alex`. The owner's `/helix link @user <person>` links someone who joined
   before. `animus leave` and `helix remove-person` remove the link.
   $ sh scripts/with-tmp.sh node --disable-warning=ExperimentalWarning --test helix/test/slack-invite.test.ts
4. `install.sh … join <url> <code>` finishes the install and then runs
   `animus join <url> <code>`; `install.ps1` takes the same arguments.
   $ sh scripts/with-tmp.sh node --disable-warning=ExperimentalWarning --test plugin/test/install.test.ts
5. A Slack user with no link who writes to the bot, or sends any `/helix`
   command, gets a private reply: "You're not on this Helix. Ask <owner> for
   an invite." Nothing is stored.
   $ sh scripts/with-tmp.sh node --disable-warning=ExperimentalWarning --test helix/test/slack-bot.test.ts
6. A linked person's job, whether started from Slack, `animus submit` or the
   CLI on the machine, posts to one DM thread: started, needs input (with the
   question), PR opened (with the link), failed (with the reason).
   `/helix notify off` stops these for that person and `/helix notify on`
   starts them again.
   $ sh scripts/with-tmp.sh node --disable-warning=ExperimentalWarning --test helix/test/slack-notify.test.ts
7. With `slack.enabled` off, `helix serve` opens no connection to Slack. With
   it on, the bot connects over Socket Mode, acknowledges every command
   within Slack's three seconds, and reconnects when Slack drops the socket.
   $ sh scripts/with-tmp.sh node --disable-warning=ExperimentalWarning --test helix/test/slack-socket.test.ts
8. A Slack app manifest is in `helix/deploy/slack/`, and docs/helix-deploy.md
   walks the owner from creating the app to `helix slack setup`; docs/helix.md
   describes the commands.

## Decisions

- What the bot does for a person is recorded as their activity.
- Socket Mode inside `helix serve`, written on Node's own WebSocket and
  `fetch`; no Slack SDK (docs/adr/0002). `yaml` stays the only runtime
  dependency.
- The bot has a core that takes a small transport (events in, Web API calls
  out). Tests drive the core with a fake transport that records what is
  posted. The Socket Mode client is tested once against a fake Slack
  WebSocket server in the test helpers, built on `node:http`'s upgrade. No
  test talks to Slack.
- Slack tokens live in `~/.helix/credentials/slack.env`; `config.yaml` holds
  only `enabled` and the owner's Slack user. One owner; changing it is a
  config edit.
- The Slack link is a column or table in `helix.db`, set when an invite that
  carries a Slack user is used. An invite sent through Slack must name a
  GitHub login, so a stolen code cannot join with another login's token.
- Each job has at most one Slack thread, stored in `helix.db`; notifications
  for a job always go to that thread.
- Every command and button is acknowledged at once and the work is done
  after. A command sent while Helix is down gets Slack's own error; nothing
  is queued for later.
- Notifications are on by default per person.
- Terms are in GLOSSARY.md: person, owner, invite, Slack link.

## Out of scope

- `/helix jobs`, `/helix status`, answering or cancelling from Slack (the next
  spec).
- Drafts and starting jobs from Slack.
- Warnings before a person's tokens expire.
- Inviting people to the tailnet.
