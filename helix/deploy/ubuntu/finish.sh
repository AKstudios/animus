#!/usr/bin/env bash
# Removes the account the machine was set up from, with its home folder.
# Run it signed in as the new account, once that account works:
#
#   ssh -t desmond@MACHINE sudo bash finish.sh OLD_USER
#
# This cannot be undone: it asks you to type the account's name first.
set -euo pipefail

die() { printf 'finish: %s\n' "$*" >&2; exit 1; }

[[ $EUID -eq 0 ]] || die "run with sudo"
OLD_USER="${1:-}"
[[ -n $OLD_USER ]] || die "usage: sudo bash finish.sh OLD_USER"
[[ ${SUDO_USER:-} != "$OLD_USER" ]] || die "you are signed in as $OLD_USER: sign in as the new account"
id "$OLD_USER" >/dev/null 2>&1 || die "there is no account $OLD_USER"
id -nG "${SUDO_USER:-root}" | grep -qw sudo || die "${SUDO_USER:-root} is not in the sudo group: removing $OLD_USER would leave no admin"
OLD_HOME="$(getent passwd "$OLD_USER" | cut -d: -f6)"

echo "This removes the account $OLD_USER and everything in $OLD_HOME:"
du -sh "$OLD_HOME" 2>/dev/null || true
ls -A "$OLD_HOME" | head -40
read -r -p "Type $OLD_USER to remove it: " typed
[[ $typed == "$OLD_USER" ]] || die "not removed"

loginctl terminate-user "$OLD_USER" 2>/dev/null || true
sleep 2
pkill -KILL -u "$OLD_USER" 2>/dev/null || true
deluser --remove-home "$OLD_USER"
echo "$OLD_USER is gone. Accounts that may sign in now:"
awk -F: '$3 >= 1000 && $3 < 60000 {print "  " $1}' /etc/passwd
