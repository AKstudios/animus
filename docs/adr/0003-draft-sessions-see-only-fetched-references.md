# Draft sessions see only fetched references, and jobs see only the spec

A draft is written from text other people wrote: issue bodies, Slack messages,
public pages. Any of it may carry instructions aimed at the session. So a
script fetches every reference before the draft session starts, and the
session gets the Claude token only: no GitHub token and no network beyond
Claude. The job that follows gets the spec its person confirmed, not the raw
references, so a person has read everything a job acts on.

## Consequences

A draft cannot follow a link the script did not fetch. A reference type is
added by adding a fetcher to the script, never by giving the session a tool.
