# Releases

There is one version, in `plugin/.claude-plugin/plugin.json`. The plugin and
Helix ship from the same tag.

## Cutting a release

```sh
npm run release -- <version> [--breaking]
```

From a clean `main`, it needs `CHANGELOG.md`'s Unreleased section filled in.
It runs the tests and typecheck, turns Unreleased into the release, tags
`v<version>` and moves the `stable` branch, which teammates' Claude Code
follows.

A release that breaks the HTTP API, a spec, a profile or a job's files is
listed under **Breaking** in the changelog, bumps the minor version before
1.0 (the major after) and needs `--breaking`. Helix then refuses older
clients (HTTP 426) with how to update.

## Moving Helix to a release

On the Helix machine: `helix/bin/helix upgrade v<version>`. It stops
starting jobs, waits for the running ones, checks out the tag, installs,
runs the tests and typecheck, builds the release's job image when jobs run
in containers, and exits for the service manager to start it again. If any
step fails, the checkout goes back to where it was.

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
