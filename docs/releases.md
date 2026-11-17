# Releases

There is one version, in `plugin/.claude-plugin/plugin.json`. The plugin and
Helix ship from the same tag.

## Cutting a release

```sh
npm run release -- <version> [--breaking] [--deploy <ssh-host>]
```

From a clean `main`, it needs `CHANGELOG.md`'s Unreleased section filled in.
It runs the tests and typecheck, turns Unreleased into the release, tags
`v<version>` and moves the `stable` branch, which teammates' Claude Code
and Helix's upgrade timer follow. It prints the push to make; with
`--deploy` it pushes, then moves that Helix machine to the release at once
(below).

A release that breaks the HTTP API, a spec, a profile or a job's files is
listed under **Breaking** in the changelog, bumps the minor version before
1.0 (the major after) and needs `--breaking`. Helix then refuses older
clients (HTTP 426) with how to update.

## Moving Helix to a release

Helix follows `stable` by itself. A systemd timer (`helix-upgrade.timer`,
installed by `setup.sh`) runs `helix upgrade --follow` every 15 minutes:
when `stable` is at a release tag the machine is not on, it stops starting
jobs, waits for the running ones, checks out the tag, installs, runs the
tests and typecheck, builds the release's job image when jobs run in
containers, and exits for the service manager to start it again. If any
step fails, the checkout goes back to where it was, and the timer does not
try that release again. Each try is kept in `helix.db`.

Sooner than the timer, from your own machine:

```sh
npm run deploy -- <ssh-host>       # e.g. abstergo; --dir if Animus is not at ~/animus there
```

It runs the same `helix upgrade --follow` over ssh and shows its output. On
the machine itself, `helix/bin/helix upgrade v<version>` moves to any tag,
including one that failed before or an older one. A second upgrade while
one is under way is refused, so the timer and a deploy never overlap.

Turn the timer off with `sudo systemctl disable --now helix-upgrade.timer`.
`sudo journalctl -u helix-upgrade` shows what it did. Claude Code on the machine
is not updated by either; update it by hand after an upgrade.

## Keeping a team repository on the latest release

To have Claude Code offer Animus in a repository and keep it up to date, put
this in its `.claude/settings.json`:

```json
{
  "extraKnownMarketplaces": {
    "animus": { "source": { "source": "github", "repo": "AKstudios/animus", "ref": "stable" }, "autoUpdate": true }
  },
  "enabledPlugins": { "animus@animus": true }
}
```
