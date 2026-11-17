# The spec

One spec is one job and one pull request. `/animus:grill-with-docs` and
`/animus:to-spec` write specs for you; this is the format they write.

```markdown
---
size: small          # trivial | small | medium | large
difficulty: routine  # routine | hard | risky
type: feature        # feature | backend | ui | bug
---
# Sort the shopping list by aisle

## Acceptance criteria

1. Items are grouped under their aisle.
   $ npx vitest run src/lib/shopping.test.js
2. An empty list shows a hint.

## Decisions

Aisles come from the item's category; there is no new field.

## Out of scope

Reordering aisles by hand.
```

## The header

| Key | What it does |
| --- | --- |
| `size` | Picks the stages: setup, gates and reviewer. Medium and large specs are cut into slices. Default `medium`. |
| `difficulty` | Picks the model tier and effort. `risky` is always reviewed by the deep tier. Default `routine`. |
| `type` | Adds a gate, a reviewer or evidence: `ui` takes screenshots and a UI reviewer; `bug` needs a test that fails on the base commit. Default `feature`. |
| `title` | The title, when the first heading should not be it. |
| `base` | The branch to start from and open the PR against, instead of the profile's `base`. |
| `after` | A spec file, or a list, whose PR must be merged before this job starts. |
| `ui` | For a `ui` spec: `{ target, pages }`, naming a target in the profile and the pages to screenshot. |
| `design` | Files or folders in the repository the UI work should match. |

What each label does exactly is in `plugin/config/profiles.yaml`
([configuration.md](configuration.md#task-profiles)). Other types (refactor,
upgrade, migration, performance, docs, tests, investigation) are defined
there but not built, and a spec with one is refused with the reason.

## Acceptance criteria

Each list item under "Acceptance criteria" is one criterion. A `$ command`
under it is its check: Animus runs it as a gate and puts its output in the PR
as proof. A criterion with no command is judged by the reviewer alone.

Write criteria by behaviour, something a person could see work, not by layer
("the function", "the API", "the tab"). The planner cuts a medium or large
spec along its criteria, one or more per slice, so criteria written by layer
give slices that show nothing until the last one.

The rest of the spec (Decisions, Out of scope, notes) is given to every
session in full.

## Checking a spec

`animus plan <spec.md>` prints what the spec would run without starting a
job, and `--slices` shows how the planner would cut it.
