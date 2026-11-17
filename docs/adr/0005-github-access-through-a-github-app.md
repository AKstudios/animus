# GitHub access through a GitHub App, as the person

A fine-grained token reaches one account's repositories, so a person working
across organisations could not join with one. Helix now has a GitHub App,
owned by an organisation the Helix owner runs and installable by any
account, and people join with its device flow: they type a short code at
GitHub instead of making and pasting a token. Helix keeps their refresh token and gets an
eight-hour user access token before each job.

User access tokens act as the person and reach only repositories where the
app is installed and the person has access, so pull requests stay theirs and
GitHub stays the member list. Installation tokens were rejected: every pull
request would come from the app, and Helix would need its own list of who may
submit for what.

This supersedes "no GitHub device login" from the invite design, which was
rejected as a second sign-in on top of the token; here it replaces the token.
A Helix with no app still takes a pasted token.

## Consequences

A job that runs past eight hours cannot push with the token it started with.
