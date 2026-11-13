---
name: to-issues
description: Split a design too large for one Animus job into medium specs, each a GitHub issue that can run by itself. Use when the work is multi-module or changes a schema, or when animus plan refuses a spec as large.
---
The factory does not run a large spec as one job. Split the agreed design into medium jobs, each one a vertical slice that leaves the app working and can merge by itself.

1. Cut by behaviour, not by layer: each slice goes through every layer it needs (schema, logic, UI) for one piece of what the person asked for. A slice that only "adds the table" or "writes the API" proves nothing until a later one lands, so avoid those.
2. Order the slices. Where one needs another merged first, say so in its body ("After #<n>"). Prefer slices that do not depend on each other, since they can run at once.
3. Write each slice as a complete spec with the `to-spec` template: its own header labels (none of them `large`), its own acceptance criteria, and a `$ command` under each. A slice must make sense to an agent that has read nothing else.
4. Show the person the list: one line per slice with its title, labels and what it depends on. Creating issues is visible to everyone on the repo, so wait for their yes.
5. For each slice, in order: `gh issue create --title "<title>" --body-file <file>`. The issue body is the spec, header included, so the issue can start a job by itself once the issue trigger is built. Until then the person runs each with `/animus:run <file>`.

Tell the person the issue links and which slices can run now.
