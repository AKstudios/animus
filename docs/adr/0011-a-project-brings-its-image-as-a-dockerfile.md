# A project brings its image as a Dockerfile, and adding it runs every gate

Every Helix job ran in one shared image, so a project that needed Go or a
system library passed `animus project add` (which ran only setup) and failed
at its first job. A project now commits `.animus/Dockerfile`, built on top of
the Animus job image, and Helix builds it per project, named by the file's
hash and the job image's ID: at the add check, and when a job finds it
missing. The build is given no files, so the Dockerfile is the image's only
input and its hash says when to rebuild. The add check runs setup and every gate on the base branch in that
image, and any failure fails the add.

## Considered options

- A list of system packages and tool versions in the profile: simpler to
  read, but Animus would have to understand each package manager and
  language, and it ties the profile to one distribution.
- The repo's `.devcontainer/devcontainer.json`: a standard, but it brings
  the devcontainer CLI and its features into Helix.
- Telling a missing tool from a failing test in the add check: no script can
  do it reliably, and a red base branch fails every job's gates anyway.

## Consequences

- When the add check fails, Helix queues a provision job. A job's container
  has no Docker, so a script on the machine runs the loop: an agent session
  edits the Dockerfile and setup, Helix builds and checks again, up to five
  times, and the result is a pull request.
- A job runs in the image of the base branch's Dockerfile, as it reads the
  base branch's profile (ADR 0008): a Dockerfile change takes effect once it
  is merged, never inside the job that makes it.
- A release that leaves the job image unchanged rebuilds no project image.
- On one machine there is no container: the Dockerfile is not read, and the
  person's own machine is the environment.
