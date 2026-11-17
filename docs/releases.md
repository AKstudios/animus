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
follows. It prints the push to make; with `--deploy` it pushes, then moves
that Helix machine to the release (below).

A release that breaks the HTTP API, a spec, a profile or a job's files is
listed under **Breaking** in the changelog, bumps the minor version before
1.0 (the major after) and needs `--breaking`. Helix then refuses older
clients (HTTP 426) with how to update.

## Moving Helix to a release

Helix moves only when someone moves it. From your own machine:

```sh
npm run deploy -- <ssh-host>       # e.g. abstergo; --dir if Animus is not at ~/animus there
```

It runs `helix upgrade --follow` there over ssh and shows its output: when
`stable` is at a release tag the machine is not on, it stops starting jobs,
waits for the running ones, checks out the tag, installs, runs the tests and
typecheck, builds the release's job image when jobs run in containers, and
exits for the service manager to start it again. If any step fails, the
checkout goes back to where it was, and `--follow` does not try that release
again; each try is kept in `helix.db`. `npm run release -- <version> --deploy
<ssh-host>` does the release, the push and this in one go.

On the machine itself, `helix/bin/helix upgrade v<version>` moves to any
tag, including one that failed before or an older one. A second upgrade
while one is under way is refused. Claude Code on the machine is not
updated by either; update it by hand after an upgrade.

## How people get a release

Claude Code updates a marketplace that is not Anthropic's only when told
to. `animus setup` asks each person, and sets `autoUpdate` for them; then
Claude Code checks `stable` shortly after each session starts and installs a
new release. Without it, `claude plugin update animus@akstudios` does the
same by hand. Commits to `main` reach nobody until a release moves `stable`.

The install scripts, `install.sh` and `install.ps1`, are fetched from
`stable` too, so a change to them reaches new people with the next release.

## Keeping a team repository on the latest release

To have Claude Code offer Animus in a repository and keep it up to date, put
this in its `.claude/settings.json`:

```json
{
  "extraKnownMarketplaces": {
    "akstudios": { "source": { "source": "github", "repo": "AKstudios/animus", "ref": "stable" }, "autoUpdate": true }
  },
  "enabledPlugins": { "animus@akstudios": true }
}
```
