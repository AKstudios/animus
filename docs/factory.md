# Animus Factory: Local and Office Modes

Nov 12, 2026 · @Ajmal

## Summary

Animus takes a spec and returns a pull request with proof that each acceptance criterion is met. The same pipeline runs in two places: on your laptop, or on the always-on machine in your office.

- **Local mode:** you shape the spec with an agent, run the factory on your laptop, and get a PR.
- **Office mode:** you shape the spec the same way, submit it, and close the laptop. The office machine does the work and raises the PR. Jobs can also start from a Slack message or a GitHub issue comment.
- **The middle is deliberately thin:** scripts for setup, gates and the PR, one implementing agent, one fresh reviewing agent. You merge.

The interactive walkthrough of both modes is here: [Animus Factory Workflow](https://claude.ai/artifact/6m3NcPg7eRFkyhPogsVKSS).

## Two ways to run it

Both modes call the same core command. Office mode is a queue and a container placed in front of `animus run`, so anything that works locally works remotely.

|  | Local mode | Office mode |
| --- | --- | --- |
| Start it with | `animus run spec.md` from a Claude Code session | `animus submit spec.md`, a Slack message, or a GitHub issue comment |
| Your laptop | Stays on and awake until the PR opens | Free once the job is submitted, or never needed |
| Spec | Shaped with you in conversation | Shaped in conversation, or the message or issue is the spec |
| Jobs at once | One or two, limited by the laptop | Several, each in its own container, from several people |
| Pipeline | Set up, implement, gates, review, open the PR | The same |
| Good for | Trying the factory, small changes, working away from the office network | Bigger jobs, overnight work, starting work from a phone, teammates |

## Starting a job

Three triggers feed one queue. Whatever the trigger, the job is the same record: repo, base branch, spec, and who submitted it.

| Trigger | What the spec is | How it reaches the office machine | Where the result shows up |
| --- | --- | --- | --- |
| Claude Code session | `spec.md`, written after the agent interviews you | `animus submit` over your private network (Tailscale), by CLI or a small MCP tool | GitHub PR notification |
| Slack message | The message itself, with its own acceptance criteria | A bot on the office machine that connects outward to Slack | Reply in the same thread, plus the PR |
| GitHub issue comment | The issue body; a `/animus` comment starts it | The machine polls GitHub or runs a self-hosted Actions runner | Comment on the issue, plus the PR |

Rules that apply to every trigger:

- **Allow list.** Only named people can start jobs. A trigger launches an agent with open permissions inside its container, so treat it like remote code execution.
- **No inbound ports.** The Slack bot and the GitHub pickup both connect outward. Nothing on the office machine is exposed to the internet.
- **No mid-run questions.** A job that cannot proceed ends as "needs input" with its question. You answer and resubmit.
- **Slack and issue jobs suit well-described work.** Nobody interviews you there, so vague requests come back as questions.

## The pipeline

&#91;embedded content: pipeline · 8 steps, 2 bounded loops\]

Scripts do everything that needs no judgment, one agent implements, a fresh agent reviews, and you merge. Both loops are bounded: the gates send work back at most twice and the review once, after which the job stops as failed with its reason.

| Stage | Done by | What happens |
| --- | --- | --- |
| Shape the spec | You, with an agent | The agent interviews you and writes `spec.md` with acceptance criteria. For Slack and issue triggers, the message or issue is the spec. |
| Queue the job | Script | Office mode only. Records the job, checks the allow list, waits for a free slot. |
| Set up workspace | Script | Fresh container, clone, database, storage, migrations, seed. |
| Implement | Agent | One session plans, writes the code and checks its own work. It splits large specs itself. |
| Run the gates | Script | Lint, type-check, tests, build. Failures go back to the same agent. |
| Review | Fresh agent | Sees only the spec and the diff, and checks the change and its tests against the criteria. |
| Open the PR | Script | Pushes the branch and opens the PR with evidence for each criterion, then deletes the container. |
| Review and merge | You | The factory never merges on its own. |

## Task profiles

Every job carries three labels: size, difficulty and type. Size picks the stages, difficulty picks the model and effort, and type adds a skill, a gate or a kind of evidence. They are separate because a ten-line concurrency bug is small but hard.

**Size picks the stages**

| Size | Looks like | Setup | Gates | Review |
| --- | --- | --- | --- | --- |
| Trivial | Typo, copy, config value, one or two files | Clone and dependencies only | Lint, types, affected tests | Skipped |
| Small | A few files, follows a known pattern | Services only if the tests need them | Full | Fast-tier reviewer |
| Medium | A feature across layers, roughly 5 to 20 files | Full stack | Full | Standard-tier reviewer |
| Large | Multi-module work or schema changes | Not run as one job |  |  |

A large spec is split with `to-issues` into medium jobs at spec time. The factory rejects a spec labelled large.

**Difficulty picks the model and effort**

| Difficulty | Signals | Model tier | Effort |
| --- | --- | --- | --- |
| Routine | Follows an existing pattern in the repo | Fast or standard | Low to medium |
| Hard | Unfamiliar area, cross-cutting change, unclear root cause | Standard or deep | High |
| Risky | Auth, payments, migrations, data deletion | Deep | High, and always reviewed whatever the size |

**Type adds a skill, a gate or evidence**

| Type | What changes |
| --- | --- |
| Bug fix | The `tdd` skill: a failing test first. The reviewer checks the test fails without the fix. |
| UI | Full stack, a browser check, screenshots as evidence, and the design system skill. |
| Backend | Integration tests against the seeded database. No browser. |
| Refactor | Existing tests must pass unmodified. Any edited test file is flagged in the PR. |
| Dependency upgrade | A script does the upgrade. An agent steps in only if the gates fail. |
| Migration | Tested up and down on the database template. Always the risky profile. |
| Performance | A before-and-after benchmark is the evidence. Without one the job is rejected. |
| Docs or tests only | Fast tier. Docs skip the test gates. |
| Investigation | The output is a findings report, not a PR. |

**Who decides**

The profiles are predefined in one config file. An agent only picks and adjusts, because fully agent-decided routing is not repeatable and the run log could not compare like with like.

1. The spec-shaping agent proposes size, difficulty and type in the spec header, where you can change them.
2. Slack and issue jobs take tags in the message, such as `[bug, small]`. Untagged jobs go through a fast-tier classifier and default to medium, routine.
3. The implementer may escalate a profile and logs why. It never downgrades.
4. A failed first gate round raises the model tier by one for the second round.

Start with these three size profiles only. The run log shows which are wrong, for example trivial jobs that never fail review, or small jobs that always need a second gate round.

## Verification and failure handling

The reviewer is independent in context but not in execution. It is a fresh session that sees only the spec and the diff, yet it reads code without running the app, and the gates run tests the implementer wrote.

**Closing the verification gap**

- **Evidence comes from a script, not the implementer.** After the gates pass, a script runs each criterion's check and captures the output: the test result, a command output, or a screenshot.
- **UI jobs get exercised.** The reviewer, or a script, drives the running app in a browser and attaches screenshots.
- **Bug fixes prove the test.** The gate confirms the new test fails on the base branch and passes on the fix.
- **Refactors protect the tests.** A diff that edits existing test files is flagged at the top of the PR.

**When a job fails**

- **Failed after the fix rounds:** push the branch and open a draft PR with the failure report, so the work is not lost.
- **Needs input:** the question goes back to the trigger. The answer resubmits the same job with its history, not a new one.
- **Session dies mid-run:** the implementer commits at each working step, so a retry resumes from the last commit.

**After the PR opens**

A `/animus fix` comment on the PR starts a follow-up job on the same branch, with the review comments as its spec. Without this, every review comment means a manual fix or a fresh job.

**Triggers from Slack and issues**

The person who submits vouches for the content, and the allow list covers who can submit. A `/animus` comment therefore vouches for the whole issue body, including text other people wrote.

**Logging**

Replace "your rough review minutes" with time from PR opened to merged, which GitHub already records. A manual field will go unfilled.

## Model tiers and providers

Profiles name a tier, never a model, so a new model or provider is a one-line change in a map.

| Tier | Used for | Claude today |
| --- | --- | --- |
| Fast | Trivial jobs, classification, small-job review | Haiku 5.5 |
| Standard | Small and medium implementation, medium review | Sonnet 5.5 |
| Deep | Hard and risky jobs | Opus 5.5 |

- Each provider gets its own map from tier to model and effort setting.
- Every agent step goes through one function: tier, effort, prompt and working directory in, transcript and exit status out. Only that function knows which CLI it calls.
- The run log records the resolved model, so tiers can be compared across providers on the replay set.

Only Claude is wired up for now. Supporting other providers later is the main reason to keep Helix thin and your own.

## The office machine

The office machine runs a small supervisor called Helix and one disposable stack per job. Nothing is shared between jobs except CPU, memory and caches.

**Supervisor**

- A queue (a SQLite table is enough) with a concurrency cap set by the machine's memory.
- An HTTP API reachable only on your private network, with a token per person.
- A CLI on top of it: `animus submit`, `animus status`, `animus result`, `animus cancel`.
- Optionally a thin MCP wrapper with the same five actions, so a session can submit and check jobs. Results never depend on it: they land as a PR and a job record.

**Isolation per job**

- One Docker Compose project per job, named after the job ID, with its own network and volumes.
- A fresh clone, a fresh database filled by migrations and a seed script, and a local storage emulator.
- Test-mode keys and mocks for outside services. No production secrets enter a job.
- The submitter's own Claude and GitHub credentials, attached to that job only, so the PR appears as them.
- No ports published to the host, and the Docker socket is never mounted into the agent container.
- Everything is deleted when the job ends.

**Startup speed**

- A prebuilt image per repo with dependencies installed, rebuilt when the lockfile changes.
- A local git mirror, so a clone copies almost nothing over the network.
- A seeded database template instead of running every migration per job.
- Shared package and build caches, which are safe to share because they hold no state.

**Prerequisite in each repo:** one command that brings the whole app up from a clean clone.

## Registration and credentials

Each developer registers once, and Helix stores two credentials per person: a Claude subscription token and a GitHub credential. Every job runs with the credentials of whoever started it, injected into that job's container only.

**Claude subscription**

`claude setup-token` opens the normal browser login and prints a one-year token. Set as `CLAUDE_CODE_OAUTH_TOKEN`, it makes a headless run use that person's Pro, Max, Team or Enterprise subscription. The token can only make model requests, so claude.ai connectors do not work in jobs, and `--bare` mode ignores it ([source](https://code.claude.com/docs/en/authentication.md)).

**GitHub credential options**

| Option | PRs appear as | Effort | Notes |
| --- | --- | --- | --- |
| Fine-grained personal token per developer | The developer | Low | Scoped to chosen repos, with contents and pull request write. Starting point. |
| An Animus GitHub App that each developer authorizes | The developer, via the app | Medium | Short-lived tokens that Helix refreshes. Also provides issue webhooks. |
| The app's own bot identity | `animus[bot]`, with "requested by" in the PR | Low | No personal GitHub credentials on the machine. |

**Registration steps**

1. You invite: `helix invite <github-login>` adds the person to the allow list and prints a one-time code.
2. The developer runs `animus register` on their laptop, over the private network, with the code.
3. A GitHub device login confirms their GitHub username, which becomes their identity in Helix.
4. The command runs `claude setup-token` and sends the token to Helix.
5. It collects the GitHub credential for the chosen option.
6. They link Slack, if that trigger is used, so a Slack user maps to the same record.
7. Helix verifies: in a throwaway container it makes one small Claude call with the token and checks that the GitHub credential belongs to the same username.
8. Helix issues a personal Helix token, which `animus submit` uses from then on.

`animus unregister` removes a person, and Helix warns a developer a month before their Claude token expires.

**How Helix holds credentials**

- Encrypted at rest, readable only by the Helix service user.
- Passed to a job as environment variables, never baked into an image or written to the workspace.
- A person's token is used only for jobs that person started. There is no fallback to someone else's subscription.
- The Claude token is treated like a password: it lasts a year and anything running in the job can read it.

**Jobs started from a GitHub issue**

The person who triggers the job pays for it, not the person who wrote the issue.

1. The comment or label event arrives with the GitHub username of whoever made it. With the app this is a webhook; without it Helix polls.
2. Helix looks the username up. A registered person's job runs with their Claude token and GitHub credential. For anyone else, Helix replies on the issue that they need to register, and starts nothing.
3. Helix posts progress on the issue as the bot, then links the PR.

The issue body may be written by anyone, so it is treated as untrusted text. Only a registered person's comment or label starts a job, and that person vouches for what the issue says.

**To confirm before rollout**

- [ ] Anthropic's terms allow each developer's subscription token to run their own jobs on a shared machine
- [ ] GitHub App user token expiry and refresh behaviour, if that option is chosen
- [ ] Which GitHub credential option to start with

**Capacity**

Plan for two to four full-stack jobs at once, not "several". The machine is an i7-6700K with 4 cores and 32 GB of memory, and each full job runs an app, a database, a storage emulator, a test suite and a build.

- The stack per job sets the limit, not the supervisor, so a different queue will not raise it.
- Trivial and small profiles skip the services, so they can run beside the full jobs. Count slots by weight: a full job takes one slot, a light job a quarter.
- If that is still too few, one shared database server with a database per job costs less memory than a server per job.
- Record peak memory and CPU per job in the run log, then set the slot count from real numbers.

## Skills

Keep the set small and name must-use skills in the spec or the workflow prompt. Each skill is vendored at a reviewed commit, never pulled live inside a job.

| Where it lives | Skills | Why there |
| --- | --- | --- |
| Each repo (`.claude/skills/`, plus `CLAUDE.md`) | How to run and verify the app, code conventions, your design system components | Knowledge no model upgrade can supply; arrives with every clone |
| The factory | A reviewer skill; `tdd`, named only in bug-fix specs; one UI design skill, only for UI repos | They work with nobody answering |
| Your laptop | `grill-me` and `to-prd` for shaping specs; `to-issues` when a spec is too big for one job | They need a conversation with you |

Re-test each public skill when a new model ships: run the same few specs with and without it, and delete it if the PRs are no better.

## What to log

Every run writes one JSON line, in both modes, from the first day. Outcome fields are filled in later from GitHub.

**Per run**

- Job ID, repo, submitter, trigger, and task class (bug, feature, UI, upgrade, refactor)
- Model, effort, factory version (the commit of the prompts and skills), skills used
- Time in queue, setup, implementation, gates and review
- Tokens, cost and turn count
- Gate results per attempt, and the number of fix rounds
- Reviewer findings, and how many were acted on
- Outcome (PR, needs input, failed) with the reason, and where the transcript is

**After the PR**

- Merged or closed, and time to merge
- Human commits added on top
- Reverted, or the same lines changed again, within 30 days
- Your rough review minutes

**Five numbers to watch, split by task class**

1. Merge rate.
2. Share merged with no human commit.
3. Share that passed the gates first time.
4. Cost and wall time per merged PR, not per attempt.
5. Revert and rework rate within 30 days.

## How to improve it

Improvement comes from reading failures and fixing their cause, one change at a time.

- **Weekly review.** Read every failed or reworked run and label the cause.
- **Fix by category.** Each cause has one place to fix it:

| Cause | Fix |
| --- | --- |
| Spec gap | Tighten the spec template or the interview |
| Missing context | Add to `CLAUDE.md` or a project skill |
| Missing tool | Give the agent the tool, such as a browser check |
| Missing gate | Add a script to the gates |
| Model error | Note it; retest when a new model ships |

- **Replay set.** Keep five to ten past specs with known-good outcomes. Re-run them after any factory change or model release. This is the eval.
- **One change at a time.** The factory version is on every run, so before and after can be compared.
- **Try removing things.** When a new model ships, delete a stage or a skill and replay. If results hold, leave it out.

## Build order

Local mode comes first because office mode is the same command behind a queue.

1. `animus run spec.md` on the laptop for one repo: setup script, implement, gates, review, PR.
2. The run log, written from the first run.
3. Container isolation: one Compose project per job, still on the laptop.
4. Helix on the office machine, with `animus submit` over the private network.
5. The GitHub issue comment trigger.
6. The Slack trigger.
7. A second submitter with their own credentials.

Findings from the 2026-11-13 review slot in as follows: task profiles and the draft PR on failure come right after step 2, the evidence script and browser check with step 3, and the `/animus fix` follow-up with step 5.

## Helix or Claude Code self-hosted environments

Keep a thin Helix. Self-hosted environments would replace the queue and the triggers, but they are Claude-only and need a Team or Enterprise plan, and neither fits the direction here.

|  | Helix (this doc) | Self-hosted environments |
| --- | --- | --- |
| Queue and slots | Yours: a SQLite table and a cap | Anthropic hosts the queue; your runner claims sessions up to its capacity |
| Start a job from | CLI, Slack bot, issue comment | Web, mobile, desktop, routines, `claude --cloud`, Slack through Claude Tag |
| GitHub issue comment trigger | Yes | Not a listed surface |
| Several people on one box | One slot pool, per-job credentials | A runner locks to one owner at a time, so one runner per concurrent person |
| Models | Any provider behind the tier map | Anthropic API only; no gateway or other provider |
| Plan | Any, each person on their own subscription | Team or Enterprise, public beta, enabled by an owner |
| Pipeline, gates, review, run log | Yours | Not included; you would add them with wrapper scripts and hooks |
| Upkeep | You maintain the supervisor | You maintain the runner image and runners |

Two cheaper options are worth a test before step 4 of the build order:

- **Anthropic-hosted cloud sessions** remove the office machine's capacity limit and need no upkeep. The repo-level pipeline (skills, scripts, hooks) runs there unchanged.
- **A self-hosted GitHub Actions runner as the queue** gives the issue-comment trigger and job history for almost no code.

Building the pipeline inside the repo keeps all of these open, because the same pipeline runs under Helix, a cloud session or an Actions runner.

Sources, checked 2026-11-13: [Self-hosted environments](https://code.claude.com/docs/en/self-hosted-environments), [Customize sessions](https://code.claude.com/docs/en/self-hosted-environments-configuration), [announcement](https://claude.com/resources/articles/run-claude-code-sessions-on-your-own-compute).

## Open decisions

- [ ] Custom Helix supervisor, or a self-hosted GitHub Actions runner as the queue
- [ ] Build the container layer, or adopt an existing library such as Sandcastle or Coasts
- [ ] Which repo goes through the factory first
- [ ] Who is on the allow list for Slack and GitHub triggers

* [ ] Test Anthropic-hosted cloud sessions on one repo before building Helix
* [ ] Confirm the three size profiles and the tier map after the first 20 runs
* [ ] Evidence script per repo: who writes it and where it lives
* [ ] Slot weights for light and full jobs, set from logged memory and CPU
