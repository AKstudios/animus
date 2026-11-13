#!/bin/sh
# Runs a command with a TMPDIR of its own, removed after: Animus's tests make
# a repository and worktrees there for nearly every case, thousands a run.
d=$(mktemp -d "${TMPDIR:-/tmp}/animus-tests.XXXXXX") || exit 1
TMPDIR=$d "$@"
s=$?
rm -rf "$d"
exit $s
