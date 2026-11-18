# Animus

A software factory: a spec goes in, a pull request with proof for each
acceptance criterion comes out. Helix runs it for several people on one
shared machine.

## People and access

**Helix**:
The supervisor on a shared machine that takes in jobs from several people
and runs Animus for each of them. What people type to start or follow work,
in Slack or on GitHub, is named Animus, never Helix.
_Avoid_: Animus server, the bot

**Person**:
Someone who has joined a Helix, with their own Claude and GitHub tokens on it.
_Avoid_: User, member, account

**Owner**:
The one person on a Helix who may invite and remove people and act on any
project or job, named from the machine itself. Running the machine and being
its owner are separate: the owner works from their own laptop or Slack.
_Avoid_: Admin, superuser, privileged user

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

**Admit**:
To decide, before a job is queued and again when it starts, whether a spec
can run on a project, against both the factory and the project's profile,
listing every problem at once.
_Avoid_: Preflight, validate, lint

**Profile**:
A project's own description of how its work is set up, checked and shown,
kept in the project; on Helix, read as the base branch has it on GitHub.
_Avoid_: Config, settings, task profile

**UI target**:
One app a project's profile says a UI job can run and screenshot; a UI spec
names one when the profile has several.
_Avoid_: App, frontend, surface

**Page**:
One place in a UI target that a UI job screenshots, named in the profile or
given as a path in the spec.
_Avoid_: Route, screen, view

**Job**:
One run of the factory on one spec, ending in a pull request, a question, or
a failure.
_Avoid_: Run, build, task

**Catch-up**:
Bringing what the base branch gained since a job started into the job's
branch, just before its pull request opens.
_Avoid_: Sync, rebase, update branch

**Fix**:
A job that continues an open pull request another job opened, from what a
person asked on it, and updates that same pull request. Not a gate's fix
round, which is a retry inside one job.
_Avoid_: Follow-up, revision, amendment

**Draft**:
A spec written from a Slack message or a GitHub comment and its references,
waiting for its person to submit, revise or discard it.
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
