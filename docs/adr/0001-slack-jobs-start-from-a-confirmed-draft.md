# Slack jobs start from a confirmed draft, not from the message

A Slack message is not a spec: it almost never carries acceptance criteria
with a check for each. So the bot does not run a job from a message. A short
read-only session on the person's own Claude writes a draft from the message
and its references, the person submits, edits or discards it, and a script
refuses a draft that lacks what a spec needs. This replaces factory.md's
earlier "the message is the spec, with tags".

## Considered options

- The message is the spec, tagged like `[bug, small]`: most messages would come
  back as "needs input".
- A full interview in the Slack thread: a chat agent living in Slack, far
  larger to build.

## Since: GitHub comments too

A `/animus` comment on a GitHub issue starts a draft the same way, posted
back on the issue, and runs nothing until its person submits it. This
replaces factory.md's "the issue is the spec": most issues lack acceptance
criteria with a check for each, and an issue carries text other people wrote.
