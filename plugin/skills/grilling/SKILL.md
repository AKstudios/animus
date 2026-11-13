---
name: grilling
description: Interview the person about what they want built until you share one design, round by round, ending with a critique of that design. Use before writing an Animus spec, or when the person asks to be grilled.
---
<!-- From mattpocock/skills, skills/productivity/grilling at 49dd158 (MIT, see ../NOTICE.md), adapted for Animus. -->

Interview the person relentlessly until you reach a shared understanding. Map this as a **design tree**: every decision branches into the decisions that hang off it.

Work the tree in **rounds**. The **frontier** is every decision whose prerequisites are already settled: the questions you can ask _now_ without guessing at answers you haven't heard yet. Ask the whole frontier in one round: number each question and give your recommended answer. Then wait for the person's answers before the next round.

Format a round like so:

```
❓ **Q1** - **<question title>**: <question body, might be multiple paragraphs, including multiple choices>

➡️ <your recommended answer>

---

❓ **Q2** - **<question title>**: <question body, might be multiple paragraphs, including multiple choices>

➡️ <your recommended answer>
```

Word each question so "yes" accepts your recommended answer.

Each round the person answers reshapes the tree: settled decisions push the frontier outward and unblock questions that depended on them. Recompute the frontier and ask the next round. A question whose answer depends on another question still open in this round belongs to a _later_ round, not this one.

Finding _facts_ is your job, never the person's. When a frontier question needs a fact from the environment (filesystem, tools, etc.), dispatch a sub-agent to find it; don't ask the person for anything you could look up yourself. Don't block on it: a running exploration is an unsettled prerequisite, so only the questions downstream of it wait for the sub-agent to report; ask the rest of the frontier now. The _decisions_ are the person's: put each to them and wait.

Ask about the product, the architecture, and money. Never ask about Animus's machinery (worktrees, branches, gates, reviews): that is decided already.

The factory asks no questions mid-run, so the interview is the only time to settle things. Three things the tree must settle before it is done:

- **The acceptance criteria.** Each one a statement someone could check, in the person's words.
- **The check for each criterion.** A command that proves it, usually one test file run alone. Agree the seam the test sits at: prefer one the code already has, and the highest one possible. A criterion no command can prove (a look, a feel) is settled as "the reviewer judges it".
- **The size.** If the work is multi-module or changes a schema, it is large, and the factory does not run large specs: say so now and plan to split it with `to-issues`.

**The last round is a critique.** When the frontier is empty, review the design you agreed as a skeptical senior engineer would: what breaks first, what is over-built, what was assumed and never said. Put each point as a question in the same format. Then ask whether you have reached a shared understanding.

Do not act on the design until the person confirms it. Once they do, go on to `to-spec` without asking.

A small request (a typo, a config value, a quick change) skips the interview: ask what should be true afterwards and how to check it, then go straight to `to-spec`.
