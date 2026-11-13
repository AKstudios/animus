---
name: to-spec
description: Turn the design agreed in the conversation into an Animus spec file, with the size, difficulty and type labels in its header and a check command under each acceptance criterion. No interview, just synthesis. Use after grilling, once the person has confirmed the design.
---
<!-- From mattpocock/skills, skills/engineering/to-spec at 49dd158 (MIT, see ../NOTICE.md), adapted for Animus. -->

Take the conversation and your understanding of the codebase and write the spec. Do NOT interview the person again. `animus` below is `${CLAUDE_PLUGIN_ROOT}/bin/animus`.

## Process

1. Explore the repo to understand the current state of the code, if you haven't already. Use the project's domain vocabulary throughout, and respect any ADRs in the area you're touching.

2. Propose the three labels. They decide what the factory runs, so pick them from what the work is, not from how important it feels:

   - **size**: `trivial` (a typo, copy, a config value, one or two files), `small` (a few files, follows a known pattern), `medium` (a feature across layers, roughly 5 to 20 files), `large` (multi-module work or a schema change). The factory refuses `large`: split it with `to-issues` instead of writing one spec.
   - **difficulty**: `routine` (follows an existing pattern in the repo), `hard` (unfamiliar area, cross-cutting change, unclear root cause), `risky` (auth, payments, migrations, data deletion). They are separate from size: a ten-line concurrency bug is small but hard.
   - **type**: `feature`, `backend` or `ui` run today. `bug`, `refactor`, `upgrade`, `migration`, `performance`, `docs`, `tests` and `investigation` are defined but not built; `animus plan` says so. A `ui` spec may name the profile's target and pages (`ui: { target: app, pages: [home] }`) and design files (`design: [design/shop.png]`).

3. Write the spec with the template below to `docs/specs/<slug>.md`, unless the project keeps specs elsewhere. Keep it short. It does not need to be committed: the factory copies it when the job starts.

4. Run `animus plan <file>`. It checks the spec and prints the stages, models and criteria the labels give. Fix what it refuses.

5. Show the person the plan's output and the path, and say they can change the labels in the header. Then stop: they start the job with `/animus:run <file>`.

Every acceptance criterion is one list item. A line under it starting with `$ ` is the command that proves it, run from the repo root; the factory runs it as a gate and puts its output in the pull request as that criterion's evidence. A test file that does not exist yet is fine: the implementer writes it. A criterion with no command is judged by the reviewer alone, and the pull request says so.

The pull request's title is the spec's title, so make it the outcome in a few words: "Sort the shopping list by aisle", not "Implement sorting feature".

<spec-template>

---
size: small
difficulty: routine
type: feature
---
# <the outcome in a few words>

## Problem

The problem the person has, from their side.

## Solution

What will be true afterwards, from their side.

## Acceptance criteria

1. <a statement someone could check>
   $ <the command that proves it>
2. <another>
   $ <its command>

## Decisions

What was decided in the interview: the modules that change and their interfaces, the seam the tests sit at, contracts, technical clarifications. No file paths or code snippets, which go stale; a type shape or state machine that encodes a decision more exactly than prose is the exception.

## Out of scope

What this job does not do.

</spec-template>
