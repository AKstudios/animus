# Should-fix findings become GitHub issues

A review grades each finding as a blocker, a should-fix or a note. Blockers
go back to the implementer inside the job. Should-fix findings were listed
in the pull request and, in every job so far, never acted on; one was a
visible bug that shipped. When a pull request opens, Animus now opens one
GitHub issue per should-fix finding, labelled `should-fix` and linked from
the pull request, whether the pull request is ready or a draft. A fix whose
ask names those issues is handed their text, its review says whether each
is settled, and the pull request closes the settled ones when it merges. An
issue whose pull request is closed unmerged is closed as not planned.

## Considered options

- Hand should-fix findings to the fix round a blocker already started: free
  when a round runs, but two thirds of jobs have no round, and the person
  never chose which ones mattered.
- Always run a round for them: every job pays for findings that are, by
  their grade, not defects.
- Leave them as a list in the pull request: what was there, and nobody
  acted on it.

## Consequences

On Helix the GitHub App needs Issues read and write, which a project's
owner must accept. An issue that cannot be opened (the permission not yet
accepted, issues turned off, GitHub unreachable) never fails or refuses a
job: the findings are listed in the pull request instead, with one line
saying why. Notes never become issues. A merged pull request may leave
should-fix issues open; they are the project's backlog from then on.
A project whose profile sets `should_fix_issues: false` gets no issues and
keeps the list in the pull request. Where the profile's `issue_link` is
`refs`, a settled issue is referenced, not closed, as the issue a job was
submitted from is.
