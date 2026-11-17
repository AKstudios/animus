# Animus

A software factory on Claude Code. A spec goes in and a pull request comes
out, with proof for each acceptance criterion. You merge.

## Install

You need [Claude Code](https://code.claude.com) signed in, Node 24, git, and
for jobs on your own machine the GitHub CLI `gh` signed in.

```sh
claude plugin marketplace add AKstudios/animus#stable
claude plugin install animus@animus
```

Then ask Claude Code to run `animus doctor`, which lists anything missing.

## Use

1. In the target repository, run `animus init` once. It drafts
   `.animus/animus.yaml`, the setup and gate commands. Check it and commit it.
2. Run `/animus:grill-with-docs` and describe what you want. It asks
   questions until the design is clear, then writes the spec and starts the
   job. If you already know what you want, `/animus:to-spec` writes the spec
   from the conversation and starts it.
3. Review and merge the PR.

The job runs on your machine, or on Helix if you have joined one that has the
repository. Say "run it locally" or "run it on Helix" to choose. On your
machine, keep the session open until the job ends; on Helix it can close.

To join a Helix, run the `animus join <url> <code>` command whoever runs it
gives you. Then ask Claude to add your repository to Helix, and to tell you
how your jobs are going.

## Docs

Commands, the spec format, configuration, Helix and how it all works are in
[docs/](docs/README.md).
