---
size: large
difficulty: risky
type: backend
after: docs/specs/slack-1b-owner.md
---
# Join Helix with GitHub's sign-in, across organisations

## Problem

Joining asks for a fine-grained GitHub token, and GitHub limits one of those
to a single user's or organisation's repositories. Someone who works on
repositories in two organisations cannot join with one token, and a classic
token instead reaches every repository they can, with full write access.

## Solution

Helix has a GitHub App. Joining shows a short code to type at
github.com/login/device; afterwards Helix works as that person on every
repository where the app is installed and they have access, in any
organisation. Nobody makes or pastes a GitHub token.

## Acceptance criteria

1. On the machine, the owner runs `helix github setup` with the app's client
   ID; Helix starts a device-code request with it to prove it works and
   writes `github: {client_id: …}` to `config.yaml`. An ID GitHub refuses is
   reported with GitHub's reason and nothing is written.
   $ sh scripts/with-tmp.sh node --disable-warning=ExperimentalWarning --test helix/test/github-app.test.ts
2. On a Helix with an app, `animus join <url> <code>` shows GitHub's code and
   opens github.com/login/device, waits while the person approves, and joins
   them as the GitHub login that approved. It asks for no GitHub token. An
   invite with `--github` is refused for any other login, and the code stays
   usable.
   $ sh scripts/with-tmp.sh node --disable-warning=ExperimentalWarning --test helix/test/github-app.test.ts
3. At the end of the join, the person is told which of Helix's projects the
   app cannot reach for them, each with the app's installation link for its
   owner to install it.
   $ sh scripts/with-tmp.sh node --disable-warning=ExperimentalWarning --test helix/test/github-app.test.ts
4. Before each job starts, before a project check and in `helix check`,
   Helix trades the person's refresh token for a fresh access token, saves
   the new refresh token (credentials file, mode 600), and the job's
   container gets the fresh access token as `GH_TOKEN`. A job submitted for a
   repository the app cannot reach for that person is refused before it
   starts, as one their token cannot push to is now.
   $ sh scripts/with-tmp.sh node --disable-warning=ExperimentalWarning --test helix/test/github-app.test.ts
5. When the refresh fails (revoked, or unused for six months), the job fails
   before it starts with "run `animus github login`", and a linked person
   gets a Slack DM saying so. `animus github login` runs the device flow
   again and replaces the stored tokens; any other login than the person's is
   refused.
   $ sh scripts/with-tmp.sh node --disable-warning=ExperimentalWarning --test helix/test/github-app.test.ts
6. On a Helix with no `github:` entry, `animus join` asks for a pasted token
   exactly as it does now.
   $ sh scripts/with-tmp.sh node --disable-warning=ExperimentalWarning --test helix/test/join.test.ts
7. The app's manifest (contents and pull requests write, metadata read, no
   webhook, device flow on, expiring user tokens, installable by any account)
   is in `helix/deploy/github/`, and docs/helix-deploy.md walks the owner
   through creating it under the AKstudios organisation and running `helix
   github setup`. docs/factory.md's join steps describe the device flow.

## Decisions

- User access tokens from a GitHub App, never installation tokens: the work
  is the person's, and GitHub stays the member list (docs/adr/0005).
- Device flow needs only the client ID: no private key and no client secret
  on Helix. The client ID sits in `config.yaml`; refresh and access tokens sit
  in the person's credentials file under `~/.helix/credentials/`, never in
  their folder that containers mount.
- The device flow runs from the person's laptop through Helix (Helix asks
  GitHub for the code and polls), so the tokens never touch the laptop.
- Tests point GitHub's device, token and API endpoints at a fake GitHub
  server in the test helpers; no test talks to GitHub.
- Nobody has joined any Helix yet, so there is no migration: no move from a
  pasted token to the app for existing people.
- `POST /join`'s body changes for a Helix with an app: a Breaking entry in
  CHANGELOG.md's Unreleased section.
- A job past eight hours cannot push with the token it started with; it fails
  at the push with its branch kept on Helix.

## Out of scope

- A credential helper that hands a running job a fresh token.
- Installation tokens, or pull requests opened as the app.
- Installing the app on organisations (their admins do that on GitHub).
