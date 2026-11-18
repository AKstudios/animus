---
size: small
difficulty: routine
type: backend
---
# A change to what ships says so in the changelog

## Problem

PRs 2, 11 and 12 on this repo changed what people use and merged with
nothing under `## Unreleased` in CHANGELOG.md. The entries were written by
hand at release time, from the PRs, and a release can only be cut once
someone notices. Jobs on this repo pass every gate without touching the
changelog, because no gate asks.

## Solution

A script, `scripts/changelog-check.ts`, run as `npm run changelog`, compares
the branch with where it left `main`. When the branch changes a file that
ships and adds no line under `## Unreleased`, it fails, naming the shipped
files that changed and saying to add an entry there. This repo's
`.animus/animus.yaml` runs it as a gate, so a job on this repo writes its
entry before its pull request opens.

## Acceptance criteria

1. On a branch that changes a file under `plugin/src/`, `plugin/skills/`,
   `plugin/config/`, `plugin/display/`, `helix/src/`, `helix/ui/` or
   `helix/deploy/` and adds no line under `## Unreleased`, the script exits
   non-zero and prints the changed shipped files and where the entry goes.
   $ sh scripts/with-tmp.sh node --disable-warning=ExperimentalWarning --test scripts/test/changelog-check.test.ts
2. The same branch with a line added under `## Unreleased` passes, and so
   does a branch that changes only tests, docs, specs, `scripts/` or
   `notes/`, and a branch with no commits past `main`.
   $ sh scripts/with-tmp.sh node --disable-warning=ExperimentalWarning --test scripts/test/changelog-check.test.ts
3. A line added under a released version's heading, not under
   `## Unreleased`, does not count.
   $ sh scripts/with-tmp.sh node --disable-warning=ExperimentalWarning --test scripts/test/changelog-check.test.ts
4. `npm run changelog` exists, `.animus/animus.yaml` lists it under
   `commands`, and `npm test` runs the script's tests.
   $ node -e "const p=require('./package.json');if(!p.scripts.changelog)process.exit(1)" && grep -q "npm run changelog" .animus/animus.yaml

## Decisions

- Where the branch left main is `git merge-base HEAD origin/main`, falling
  back to `main` when there is no `origin/main`.
- A shipped file is one under the folders in criterion 1, test folders
  inside them excepted. The list is a constant at the top of the script.
- "Adds a line" means the diff of CHANGELOG.md from the merge base adds a
  non-blank line between `## Unreleased` and the next `## ` heading.
- The script imports only Node. Its tests make throwaway git repos in a
  temporary folder; none touches this checkout.
- `package.json`'s `test` script adds `'scripts/test/**/*.test.ts'`.

## Out of scope

- Judging whether a change is visible to people; any change to a shipped
  file needs an entry.
- Checking the **Breaking** marking, or the entry's wording.
- A gate for other projects: this is this repository's own profile.
