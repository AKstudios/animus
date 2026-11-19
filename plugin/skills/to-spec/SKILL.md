---
name: to-spec
description: Turn the design agreed in the conversation into an Animus spec file, with the size, difficulty and type labels in its header and a check command under each acceptance criterion, or into several spec files when the person wants parts of the work to merge separately. No interview, just synthesis. Use after grill-with-docs, once the person has confirmed the design.
---
<!-- From mattpocock/skills, skills/engineering/to-spec at 49dd158 (MIT, see ../NOTICE.md), adapted for Animus. -->

Take the conversation and your understanding of the codebase and write the spec. Do NOT interview the person again, and do not stop to show them the spec: once it is written and checked, the job starts. `animus` below is `${CLAUDE_PLUGIN_ROOT}/bin/animus`.

## Process

1. Explore the repo to understand the current state of the code, if you haven't already. Use the project's domain vocabulary throughout, and respect any ADRs in the area you're touching.

2. Propose the three labels. They decide what the factory runs, so pick them from what the work is, not from how important it feels:

   - **size**: `trivial` (a typo, copy, a config value, one or two files), `small` (a few files, follows a known pattern), `medium` (a feature across layers, roughly 5 to 20 files), `large` (multi-module work or a schema change). A medium or large spec is cut into slices by the factory and still ends as one pull request: see "Large work" below.
   - **difficulty**: `routine` (follows an existing pattern in the repo), `hard` (unfamiliar area, cross-cutting change, unclear root cause), `risky` (auth, payments, migrations, data deletion). They are separate from size: a ten-line concurrency bug is small but hard.
   - **type**: `feature`, `backend`, `ui` or `bug` run today. A `bug` spec needs a `$ command` under at least one criterion that runs the test reproducing the bug: the factory checks that it fails without the fix. `refactor`, `upgrade`, `migration`, `performance`, `docs`, `tests` and `investigation` are defined but not built; `animus plan` says so. A `ui` spec may name the profile's target and pages (`ui: { target: app, pages: [home] }`) and design files (`design: [design/shop.png]`).

3. Write the spec with the template below to `docs/specs/<slug>.md`, unless the project keeps specs elsewhere. Keep it short. It does not need to be committed: the factory copies it when the job starts.

4. Run `animus plan <file>`. It checks the spec and prints the stages, models and criteria the labels give. Fix what it refuses.

5. Start the job, without asking: `animus start <file>` from the repo, with the Bash tool's `run_in_background`. Add `--helix` if the person said in this conversation to run it on Helix, or `--local` if they said to run it here or on their machine. Otherwise add neither: the command decides from their `~/.animus/config.yaml` and whether Helix has the repository, and its first line says where the job runs and why. Never pick for them.

   - **On this machine**: the command queues the job and returns at once with its number; a loop of this machine, in a process of its own, runs it. Tell the person in a line or two the labels and what they run (from the plan's output), the number, and that the session can close: the job runs on, and a new session in the project lists what needs them (a question, a failure, a pull request). `animus status <id>` follows it, and a question it asks is answered with `animus answer <id> "<answer>"`. Then offer to run `animus ui` to watch it (the output names the job's page, `/jobs/<job>`); on a yes, run it with `run_in_background` and give the address it prints. If the Bash tool refuses to start it because it starts other Claude sessions, ask the person to type `! animus start <file>` with the same flag.
   - **On Helix**: the command returns at once with the job's number. Tell the person the labels, the number, and that the session can close. Give both links from its `watch it:` lines (Tailscale and office network, whichever it printed). `animus status <id>` follows it, and a question it asks is answered with `animus answer <id> "<answer>"`.

6. When the person asks how a job on this machine went (or `animus status` lists it ended), tell the outcome from `animus result <id>`, in a few lines. `pr`: the link; they review and merge. `draft-pr`: the job failed after its fix rounds; give the reason's first line and the link. `needs-input`: the job's question, word for word; when they answer, run `animus answer <id> "<their answer>"`. `failed`: the reason; nothing was pushed and the work, if any, is on the job's branch. A job the machine stopped under (sleep, crash, restart) is resumed by the loop on its own.

## Large work

Large work is still one spec, one job and one pull request. The factory cuts a medium or large spec into slices itself, along the acceptance criteria, and does each slice in a fresh session on the job's branch. Do not split the work into several specs to make it fit, and do not write the slices yourself.

- Label it `large` when it is multi-module or changes a schema. A large spec is reviewed at the deep tier and runs only as slices, so it needs enough criteria to cut along: one per behaviour, as "Acceptance criteria" below says.
- Write several specs only when the person wants the parts to merge separately: different outcomes that happen to be asked for together, or a first part they want in use before the rest is built. Each is then complete by itself, with its own labels and criteria. Name them in order, `docs/specs/<slug>-1-<part>.md`, `-2-`, and so on.
- A job starts from the base branch as the remote has it, so a spec that needs an earlier one names it in its header: `after: docs/specs/<slug>-1-<part>.md`. Its job waits until the earlier spec's pull request is merged and starts from the base that holds it. Run `animus plan` on each, start every one with `animus start <file>` (and the same `--helix` or `--local` for all) in the background, the waiting ones too, and tell the person the list: one line per spec with its title, labels and what it waits for. Either way a waiting job sits in the queue with no process, and no slot on Helix, until the earlier pull request merges, so the session need not stay open.

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
