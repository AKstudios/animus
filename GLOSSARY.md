# Animus

A software factory: a spec goes in, a pull request with proof for each
acceptance criterion comes out. Helix runs it for several people on one
shared machine.

## People and access

**Person**:
Someone who has joined a Helix, with their own Claude and GitHub tokens on it.
_Avoid_: User, member, account

**Owner**:
The person who runs the Helix machine; the only one who may invite.
_Avoid_: Admin

**Invite**:
A one-time code that lets one named person join a Helix, optionally tied to
their Slack user.
_Avoid_: Invitation link, signup

**Slack link**:
The tie between a Slack user and a person, made when an invite sent to that
Slack user is used to join.
_Avoid_: Slack account, Slack mapping

## Work

**Spec**:
The description of one piece of work, with acceptance criteria and a check
for each.
_Avoid_: Ticket, task, request

**Job**:
One run of the factory on one spec, ending in a pull request, a question, or
a failure.
_Avoid_: Run, build, task

**Draft**:
A spec written from a Slack message and its references, waiting for its
person to submit, edit or discard it.
_Avoid_: Proposal, pending spec

**Reference**:
A GitHub issue or pull request, Slack message or file, or public page that a
draft was written from, saved with it.
_Avoid_: Attachment, context, source

## Seeing the work

**Display**:
The pages that show what a Helix, or one machine's Animus, is doing: the
overview, a job page and a person page.
_Avoid_: Dashboard, web UI, Helix UI

**Job page**:
Everything about one job on one page: its spec, stages, checks, review,
questions and answers, log and screenshots.
_Avoid_: Job detail, job view

**Person page**:
One person's jobs and activity on a Helix.
_Avoid_: Profile, user page

**Activity**:
One thing a person did on a Helix, kept with when they did it: submitting,
answering or cancelling a job, joining or leaving, adding or removing a
project, and talking to the Slack bot.
_Avoid_: Interaction, event, audit log

**Open PR**:
A pull request a job opened that GitHub still shows as open.
_Avoid_: Active PR, pending PR

**Local display**:
The display of the jobs one machine's Animus has run itself, outside any
Helix.
_Avoid_: Local Helix, local mode
