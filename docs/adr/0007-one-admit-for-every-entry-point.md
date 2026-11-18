# One admit decides whether a spec runs, at every entry point and at job start

A spec used to be checked only against the factory before it was queued;
the project's profile was first read once the job had started, so a draft
could pass Submit and fail seconds into its job (a UI spec naming no target,
2026-11-18). Now one script, admit, checks a spec against the factory and the
project's profile and lists every problem at once, each marked as fixed in
the spec or in the profile. `animus plan`, `run`, `start`, `submit`, Helix's
`POST /jobs`, draft Submit on Slack and GitHub, and the job's own start all
call it; a job that starts never fails for a reason admit did not name.

Admit is a script that only reads. It does not run the target's `serve`, the
acceptance commands, or a model. Whether a check proves its criterion stays
the reviewer's judgement; admit only warns when every check is a gate or all
are one command.

## Considered options

- Each entry point adding the checks it was missing: what drifted apart once
  would drift again.
- A model judging the spec at Submit: routes work, against ADR 0001's rule that
  scripts decide.

## Consequences

Unknown header keys are refused, which breaks specs that carried their own.
`after:` is refused on Helix until Helix can follow an earlier job itself.
