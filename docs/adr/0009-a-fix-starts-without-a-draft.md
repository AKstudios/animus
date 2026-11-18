# A fix starts without a draft

ADR 0001 has a comment start a draft and never a job. A fix is the
exception: `/animus fix <text>` on a pull request a job opened queues a new
job on that pull request's branch straight away. The spec was confirmed
when the first job was submitted and stays the spec; the comment, and the
pull request's review comments since the last push, are what the fix is
asked to change, and the reviewer judges the result against them as well
as the spec's criteria. A fix is its own job, linked to the one that opened
the pull request, so a failed fix leaves the first job's record as it was.

## Considered options

- A drafted amendment to the spec, then `/animus submit`: a second round
  trip for what is mostly "rename this" or "address the review".
- Reopening the first job: one record for two runs, and a failed fix would
  rewrite how the first one ended.

## Consequences

Only pull requests a job opened can be fixed, and only by that job's person
or the owner. A fix's ask has no check command of its own; the spec's
criteria are proved again and the reviewer judges the rest.
