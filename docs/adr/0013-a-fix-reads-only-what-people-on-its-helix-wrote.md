# A fix reads only what people on its Helix wrote

ADR 0009 gives a fix the pull request's reviews and inline comments since
the last push as references. On a repository others can comment on, that
put a stranger's text in front of a session that holds its person's GitHub
and Claude credentials, in a container that can reach the internet. A fix
on Helix now takes only reviews and comments whose author is a person on
that Helix. The rest are dropped, and the fix's comment on the pull request
says how many were left out.

## Considered options

- Keep every comment and mark the outsiders' ones as untrusted: the text
  still reaches the session, and telling a model not to follow it is a
  request, not a control.
- Limit what a job's container can reach on the network: worth doing, but
  it does not stop a comment steering what the fix changes.

## Consequences

A review by someone not on the Helix reaches a fix only when a person on it
repeats what they want in their own comment or in the ask.
