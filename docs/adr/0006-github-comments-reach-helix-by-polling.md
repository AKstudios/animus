# GitHub comments reach Helix by polling, and Animus answers as the person

Helix opens no inbound port, so it cannot take GitHub's webhooks. It reads new
issue and pull request comments on each of its projects about once a minute
instead, with a person's user token, as it already lists open PRs. A
`/animus` comment counts only when its author's GitHub login is a person on
that Helix; anyone else's is ignored without a reply, so a stranger on a
public repository cannot make Animus post anything.

Animus's own comments are posted with the person's user token, so they show
as that person with the app's badge. A bot account would need the app's
private key on Helix, which ADR 0005 chose not to keep.

GitHub does not notify a person of their own comments, so when a draft is
ready Animus also DMs its person on Slack when they have a Slack link.

## Considered options

- Webhooks through Tailscale Funnel or a relay such as smee: exposes the
  machine that runs jobs, or adds a third party between GitHub and Helix.
- A self-hosted Actions runner: a second service on the machine with its own
  token, for what one more API call per minute does.

## Consequences

A comment is picked up up to a minute late. Helix acts only on comments
created after its stored position and keeps the ones it handled, since
GitHub's `since` goes by update time and an edited old command would come
back; one older than a day when first seen is answered, not acted on. A
project is read with the token of the person who added it, then of another
person who has it. Animus's comments must carry a
marker of their own so Helix never acts on what it posted.
