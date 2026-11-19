#!/bin/sh
# Runs a command with a TMPDIR of its own, removed after: Animus's tests make
# a repository and worktrees there for nearly every case, thousands a run.
# A node command also gets limits, so a test that never settles fails after a
# minute and a server a test leaves open cannot keep the run alive after the
# last test: without them a broken test hangs until whoever ran it gives up.
# Node refuses these flags in NODE_OPTIONS, so they go on the command itself.
# ANIMUS_HOME goes there too, so no test reads or writes the real Animus home,
# whatever helper it builds on.
d=$(mktemp -d "${TMPDIR:-/tmp}/animus-tests.XXXXXX") || exit 1
if [ "$1" = node ]; then
  shift
  set -- node --test-timeout=60000 --test-force-exit "$@"
fi
TMPDIR=$d ANIMUS_HOME=$d/animus-home "$@"
s=$?
rm -rf "$d"
exit $s
