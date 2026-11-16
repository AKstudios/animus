---
name: to-spec
description: Turn the design agreed in the conversation into an Animus spec file, with the size, difficulty and type labels in its header and a check command under each acceptance criterion, or into several spec files when the work is too large for one job. No interview, just synthesis. Use after grilling, once the person has confirmed the design.
---
<!-- From mattpocock/skills, skills/engineering/to-spec at 49dd158 (MIT, see ../NOTICE.md), adapted for Animus. -->

Take the conversation and your understanding of the codebase and write the spec. Do NOT interview the person again, and do not stop to show them the spec: once it is written and checked, the job starts. `animus` below is `${CLAUDE_PLUGIN_ROOT}/bin/animus`.

## Process

1. Explore the repo to understand the current state of the code, if you haven't already. Use the project's domain vocabulary throughout, and respect any ADRs in the area you're touching.

2. Propose the three labels. They decide what the factory runs, so pick them from what the work is, not from how important it feels:

   - **size**: `trivial` (a typo, copy, a config value, one or two files), `small` (a few files, follows a known pattern), `medium` (a feature across layers, roughly 5 to 20 files), `large` (multi-module work or a schema change). The factory refuses `large`: write several specs instead of one, as "Large work" below says.
   - **difficulty**: `routine` (follows an existing pattern in the repo), `hard` (unfamiliar area, cross-cutting change, unclear root cause), `risky` (auth, payments, migrations, data deletion). They are separate from size: a ten-line concurrency bug is small but hard.
   - **type**: `feature`, `backend`, `ui` or `bug` run today. A `bug` spec needs a `$ command` under at least one criterion that runs the test reproducing the bug: the factory checks that it fails without the fix. `refactor`, `upgrade`, `migration`, `performance`, `docs`, `tests` and `investigation` are defined but not built; `animus plan` says so. A `ui` spec may name the profile's target and pages (`ui: { target: app, pages: [home] }`) and design files (`design: [design/shop.png]`).

3. Write the spec with the template below to `docs/specs/<slug>.md`, unless the project keeps specs elsewhere. Keep it short. It does not need to be committed: the factory copies it when the job starts.

4. Run `animus plan <file>`. It checks the spec and prints the stages, models and criteria the labels give. Fix what it refuses.

5. Start the job, without asking: `animus run <file>` from the repo, with the Bash tool's `run_in_background`. A job takes from a few minutes to an hour and asks nothing while it runs. Tell the person in a line or two the labels and what they run (from the plan's output), and that this session has to stay open until the job ends: compacting is fine, closing or clearing it stops the job. If the Bash tool refuses to start it because it starts other Claude sessions, ask the person to type `! animus run <file>`.

6. When it exits, tell the person the outcome from its JSON, in a few lines. `pr`: the link; they review and merge. `draft-pr`: the job failed after its fix rounds; give the reason's first line and the link. `needs-input`: the job's question, word for word; when they answer, run `animus resume <job> --answer "<their answer>"` the same way. `failed`: the reason; nothing was pushed and the work, if any, is on the job's branch. A job that was cut off is picked up with `animus resume <job>`.

## Large work

The factory cuts a medium spec into slices itself and does each in a fresh session, toward one pull request. It does not yet do that for a large one. So work that is multi-module or changes a schema is split here, with the person, into several medium specs, each run as its own job with its own pull request.

- Cut by behaviour, not by layer. Each spec goes through every layer it needs (schema, logic, UI) for one piece of what the person asked for, leaves the app working, and can merge by itself. A spec that only "adds the table" proves nothing until a later one lands.
- Each spec is complete: its own labels (none `large`), its own acceptance criteria and check commands. It must make sense to an agent that has read nothing else.
- Name them in order, `docs/specs/<slug>-1-<part>.md`, `-2-`, and so on. A job starts from the base branch as the remote has it, so a spec that needs an earlier one names it in its header: `after: docs/specs/<slug>-1-<part>.md`. Its job then waits until the earlier spec's pull request is merged and starts from the base that holds it. Prefer specs that do not depend on each other: those can run at once.
- Run `animus plan` on each, then start every spec with `animus run <file>` in the background, the waiting ones too. Tell the person the list: one line per spec with its title, labels and what it waits for. A waiting job starts by itself once they merge the earlier pull request, and stops if they close it unmerged. The session has to stay open for it.

## Acceptance criteria

Write each criterion as something a person using the product can do or see, and that the product could not do before. The factory cuts a medium spec into slices along its criteria and grades each slice by the criteria it holds, so the criteria decide the shape of the work:

- A criterion goes through every layer it needs. "A note typed on a planned meal is still there after a reload" is one criterion; "notes can be stored", "notes are loaded at start" and "the meal card has a note field" are the same behaviour cut by layer, and each of them alone shows nobody anything.
- A function, a table, a type or a module that has to exist is a decision, and goes under Decisions. It is a criterion only when the thing the person asked for is itself an interface (a library, a CLI, an API), and then the criterion is a call and what it returns.
- Put the thinnest path that works first: the one behaviour the rest build on. Later criteria each add one behaviour to it (an edge, a second place it shows, what happens on delete).
- The check command proves the behaviour at the highest seam the repo's tests reach. A unit test of a helper is fine as proof only when that is where the behaviour lives.
- Test each criterion: if only this one were built, could the person see something new? If not, fold it into the criterion that uses it.

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
