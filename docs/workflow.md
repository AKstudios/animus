Animus · software factory

# One pipeline, two places to run it

A spec goes in and a pull request with proof comes out. The steps are the same whether the factory runs on your laptop or on the machine in your office. The job's size decides which of them run. Pick a mode and a size, then step through a job.

Where the factory runs

How the job starts

Job size

You Agent Script

## What changes between the two modes

|  | On my laptop | On the office machine |
| --- | --- | --- |
| Start it with | `animus run spec.md` from a Claude Code session | `animus submit spec.md`, a Slack message, or a comment on a GitHub issue |
| Your laptop | Stays on and awake until the PR opens | Free as soon as the job is submitted, or never needed |
| Spec | Shaped with you in conversation | Shaped in conversation; from Slack, a draft written from your message, revised by your replies in its thread and queued when you press Submit; or the issue is the spec |
| Jobs at once | One or two, limited by the laptop | Two to four full jobs, each in its own container; trivial and small jobs run beside them |
| Pipeline | Identical for the same job size: set up, implement, gates, review, catch up with the base, evidence, open the PR. You merge. |  |
| Good for | Trying the factory, small changes, working offline from the office | Bigger jobs, overnight work, starting work from your phone, teammates |

## Task profiles

Size picks the stages, difficulty picks the model and effort, and type adds a skill, a gate or a kind of evidence. They are separate because a ten-line concurrency bug is small but hard.

| Size | Looks like | Setup | Gates | Review |
| --- | --- | --- | --- | --- |
| Trivial | Typo, copy, config value | Clone and dependencies only | Lint, types, affected tests | Skipped |
| Small | A few files, known pattern | Services only if tests need them | Full | Fast-tier reviewer |
| Medium | A feature across layers | Full stack | Full | Standard-tier reviewer |
| Large | Multi-module or schema work | Full stack | Full | Deep-tier reviewer |

A medium or large spec is cut into slices before any code is written, and each slice is done by a fresh session on the job's branch. It is still one job and one pull request.

| Difficulty | Signals | Model tier | Effort |
| --- | --- | --- | --- |
| Routine | Follows an existing pattern in the repo | Fast or standard | Low to medium |
| Hard | Unfamiliar area, cross-cutting change, unclear root cause | Standard or deep | High |
| Risky | Auth, payments, migrations, data deletion | Deep | High, and always reviewed whatever the size |

| Type | What changes |
| --- | --- |
| Bug fix | A failing test first. The reviewer checks it fails without the fix. |
| UI | Full stack, a browser check, screenshots as evidence, the design system skill. |
| Backend | Integration tests against the seeded database. No browser. |
| Refactor | Existing tests must pass unmodified. Edited test files are flagged in the PR. |
| Dependency upgrade | A script does the upgrade. An agent steps in only if the gates fail. |
| Migration | Tested up and down on the database template. Always the risky profile. |
| Performance | A before-and-after benchmark is the evidence. |
| Docs or tests only | Fast tier. Docs skip the test gates. |
| Investigation | The output is a findings report, not a PR. |

Profiles are predefined in one config file and name a tier (fast, standard, deep), never a model, so another provider is a change to one map. The spec-shaping agent proposes the labels, and the implementer may escalate but never downgrade.