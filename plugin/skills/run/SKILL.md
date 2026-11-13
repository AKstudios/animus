---
name: run
description: Run one Animus job from a spec file to a pull request. Use when the person types /animus:run or asks to run a spec through the factory.
argument-hint: "<spec.md>"
---
Run the spec through the factory. `animus` below is `${CLAUDE_PLUGIN_ROOT}/bin/animus`.

1. `animus plan <spec>`. If it refuses the spec, fix what it names with the person and stop. Otherwise tell them in one line what will run (the labels, and whether it is reviewed).
2. `animus run <spec>` with the Bash tool's `run_in_background`. A job takes from a few minutes to an hour, and it asks nothing while it runs. Its progress goes to stderr, its result to stdout as JSON.
3. When it exits, tell the person the outcome in a few lines:
   - `pr`: the link. They review and merge; the factory never merges.
   - `draft-pr`: the job failed after its fix rounds. Give the reason's first line and the link; the draft holds the failure report and the work so far.
   - `needs-input`: the job's question, word for word. When they answer, run `animus resume <job> --answer "<their answer>"` the same way.
   - `failed`: the reason. Nothing was pushed; the work, if any, is on the job's branch.
4. `animus runs` shows the run log if they ask how past jobs went.

If the Bash tool refuses to start `animus run` because it starts other Claude sessions, ask the person to type `! animus run <spec>` themselves.

The laptop has to stay awake until the job ends. Ask the person nothing about worktrees, branches or retries.
