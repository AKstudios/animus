# On Helix, a project's profile is the base branch as GitHub has it

Helix's clones went stale: a person's clone was made on their first job and
never updated, so a profile fixed on GitHub was not what the next job read.
Helix now fetches the base branch, with the person's token, before it admits a
spec, writes a draft or starts a job, and reads the profile from it. A
laptop's `--local` job still reads its own checkout, so an unpushed profile
works there; `animus start --helix` warns when the checkout's profile differs
from the base branch's, since Helix will not see it.
