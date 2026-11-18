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
| `ui` | For a `ui` spec: `{ target, pages }`, naming a target in the profile and the pages to screenshot. Each page is a name from the target's `pages`, or a path starting with `/` (see [Literal pages](#literal-pages)). |
| `design` | Files or folders in the repository the UI work should match. |

Any other key is refused, with "did you mean" for a likely misspelling:
`sise:` is not read as a spec with no size. The same goes for a key under `ui`
other than `target` and `pages`.

What each label does exactly is in `plugin/config/profiles.yaml`
([configuration.md](configuration.md#task-profiles)). Other types (refactor,
upgrade, migration, performance, docs, tests, investigation) are defined
there but not built, and a spec with one is refused with the reason.

### Literal pages

A `ui` spec's `pages` may give a path such as `/masjid/subscribe` where the
profile has no name for it. The job screenshots that path on the target's
`url`, as it does a named page, and names the screenshot from the path. Any
entry that starts with `/` is a path; a path is for web targets, since an app
target's `capture` command takes page names. Without `pages`, a job shows
every page of the target.

With one `ui` target in the profile, the job uses it. With several, the spec
names one in `ui: { target: <name> }`; nothing is guessed from the spec's
prose.

## Acceptance criteria

Each list item under "Acceptance criteria" is one criterion. A `$ command`
under it is its check: Animus runs it as a gate and puts its output in the PR
as proof. A criterion with no command is judged by the reviewer alone, but a
spec needs at least one criterion with a command, and a `bug` spec needs a
command that fails on the base commit.

Write criteria by behaviour, something a person could see work, not by layer
("the function", "the API", "the tab"). The planner cuts a medium or large
spec along its criteria, one or more per slice, so criteria written by layer
give slices that show nothing until the last one.

The rest of the spec (Decisions, Out of scope, notes) is given to every
session in full.

## Checking a spec

`animus plan <spec.md>` prints what the spec would run without starting a
job, and `--slices` shows how the planner would cut it.

Before a job is queued, and again when it starts, the spec is admitted
([ADR 0007](adr/0007-one-admit-for-every-entry-point.md)): a script, with no
model, checks it against the factory and the project's profile and lists every
problem at once, so a job never fails at its start for a reason that was not
named. Each problem says whether it is fixed in the spec or in the profile; a
profile problem gives the YAML to add and the branch the profile was read
from. It refuses:

- an unknown header key, or a `ui` that is not `{ target, pages }`;
- a `ui` spec whose profile has no target, whose named target is not there, or
  that names none among several targets (the list is shown);
- a page that is neither a name of the target nor a path;
- a `design` file that is not on the base branch, or a base branch that does
  not exist;
- a type that is not built yet;
- a `bug` spec with no command, or a spec where no criterion has one.

It only warns, and still admits, when every criterion's command is one of the
profile's gates, or all criteria run the same one, since the check then proves
little.

`animus plan` shows a spec's target, pages, base, gates, problems and
warnings, and exits 1 for a spec that is refused. A draft on Slack or GitHub
carries the same, apart from its spec, and Submit is refused while problems
remain ([helix.md](helix.md#drafts-know-the-project)).
