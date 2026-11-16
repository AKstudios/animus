How this skill applies inside Animus:

- There is no tracker and nobody to quiz. Skip steps 4 and 5: publish nothing, write no file, and return the breakdown as your structured answer. A script checks it and sends it back once if it breaks a rule.
- A ticket is a slice of one job. The slices run in order on one branch, each in a fresh session that has read only its own part of the spec and your brief, and the job ends as one pull request. So the "integration branch" of a wide refactor is the job's branch.
- Blocking edges are `after`: the numbers of the slices that must be done before this one starts. List a slice after everything it names.
- The acceptance criteria are the spec's, by number. Do not write new ones. Give each criterion to the one slice that finishes it; a slice is graded by the criteria it holds.
- "What it delivers" is `delivers`: what someone could see working once this slice is done and no later one is. A slice with no such sentence is a layer, not a slice.
- Work that fits in one fresh context window is one slice. Do not cut it finer to look thorough: most reported failures of this skill are too many tickets.
- You have no Skill tool: where the skill names another skill or a setup command, skip it.
- Where it and your instructions above differ, your instructions win.
