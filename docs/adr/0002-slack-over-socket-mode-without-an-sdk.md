# The Slack bot is Socket Mode inside `helix serve`, without Slack's SDK

Helix opens no inbound port, so the bot reaches Slack over Socket Mode, an
outbound WebSocket. It runs inside `helix serve` and is written against
Node's own WebSocket and `fetch` rather than Bolt, so `yaml` stays Animus's
only runtime dependency. Slack's tokens live in
`~/.helix/credentials/slack.env`; `config.yaml` only turns the bot on.
Socket Mode apps cannot be listed in Slack's marketplace, which a bot for one
workspace does not need.
