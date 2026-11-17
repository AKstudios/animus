#!/usr/bin/env bash
# Makes an Ubuntu machine ready to run Helix with nobody signed in. Run it
# with sudo from the account you sign in with today; it is safe to run again.
#
#   scp helix/deploy/ubuntu/setup.sh MACHINE: && ssh -t MACHINE sudo bash setup.sh
#
# What it does, each step read back at the end:
#   1. names the machine (hostname and Tailscale name)
#   2. makes the account Helix runs as, with your SSH keys and sudo by password
#   3. installs Node 24 from nodejs.org, checked against its published sums
#   4. masks sleep, suspend and hibernate
#   5. lets that account manage Tailscale's serve setting, and nothing else of it
#   6. installs helix.service, which starts at boot once ~/.helix/config.yaml exists,
#      and helix-upgrade.timer, which moves it to each release stable points at
#   7. lets the browser that takes screenshots use its own sandbox
#   8. lets that account run Docker, for jobs in containers (when Docker is installed)
#
# It removes nothing. The old account goes with finish.sh, once the new one works.
set -euo pipefail

NEW_USER="${NEW_USER:-desmond}"
NEW_HOST="${NEW_HOST:-abstergo}"
NODE_MAJOR=24

say() { printf '\n==> %s\n' "$*"; }
die() { printf 'setup: %s\n' "$*" >&2; exit 1; }

[[ $EUID -eq 0 ]] || die "run with sudo"
OLD_USER="${SUDO_USER:-}"
[[ -n $OLD_USER && $OLD_USER != root ]] || die "run with sudo from your own account, not as root"
OLD_HOME="$(getent passwd "$OLD_USER" | cut -d: -f6)"
KEYS="$OLD_HOME/.ssh/authorized_keys"
[[ -s $KEYS ]] || die "$KEYS is empty: the new account would have no way in"

say "1. the machine is named $NEW_HOST"
OLD_HOST="$(hostname)"
if [[ $OLD_HOST != "$NEW_HOST" ]]; then
  hostnamectl set-hostname "$NEW_HOST"
  if grep -qE "^127\.0\.1\.1\s" /etc/hosts; then sed -i -E "s/^127\.0\.1\.1\s.*/127.0.1.1\t$NEW_HOST/" /etc/hosts
  else printf '127.0.1.1\t%s\n' "$NEW_HOST" >> /etc/hosts; fi
fi
command -v tailscale >/dev/null && tailscale set --hostname="$NEW_HOST"

say "2. the account $NEW_USER"
id "$NEW_USER" >/dev/null 2>&1 || adduser --disabled-password --gecos '' "$NEW_USER"
usermod -aG sudo "$NEW_USER"
NEW_HOME="$(getent passwd "$NEW_USER" | cut -d: -f6)"
install -d -m 700 -o "$NEW_USER" -g "$NEW_USER" "$NEW_HOME/.ssh"
# Run again from the new account itself, its keys are already its own.
[[ $KEYS -ef "$NEW_HOME/.ssh/authorized_keys" ]] || install -m 600 -o "$NEW_USER" -g "$NEW_USER" "$KEYS" "$NEW_HOME/.ssh/authorized_keys"
if [[ "$(passwd -S "$NEW_USER" | awk '{print $2}')" != P ]]; then
  echo "Choose $NEW_USER's password. sudo will ask for it; SSH never takes it."
  passwd "$NEW_USER"
fi

say "3. Node $NODE_MAJOR"
have="$(node -v 2>/dev/null | sed -E 's/^v([0-9]+).*/\1/' || true)"
if [[ ${have:-0} -lt $NODE_MAJOR ]]; then
  case "$(uname -m)" in x86_64) arch=x64 ;; aarch64) arch=arm64 ;; *) die "no Node build for $(uname -m)" ;; esac
  base="https://nodejs.org/dist/latest-v$NODE_MAJOR.x"
  tmp="$(mktemp -d)"
  curl -fsSL "$base/SHASUMS256.txt" -o "$tmp/sums"
  file="$(awk -v a="linux-$arch.tar.xz" '$2 ~ a"$" {print $2}' "$tmp/sums")"
  [[ -n $file ]] || die "nodejs.org lists no linux-$arch build"
  curl -fsSL "$base/$file" -o "$tmp/$file"
  (cd "$tmp" && grep " $file\$" sums | sha256sum -c -) || die "the Node download does not match its published sum"
  mkdir -p /usr/local/lib/nodejs
  tar -xJf "$tmp/$file" -C /usr/local/lib/nodejs
  dir="/usr/local/lib/nodejs/${file%.tar.xz}"
  for b in node npm npx; do ln -sf "$dir/bin/$b" "/usr/local/bin/$b"; done
  rm -rf "$tmp"
fi

say "4. the machine never sleeps"
systemctl mask sleep.target suspend.target hibernate.target hybrid-sleep.target >/dev/null

say "5. $NEW_USER may set Tailscale's serve"
command -v tailscale >/dev/null && tailscale set --operator="$NEW_USER"

say "6. helix.service"
cat > /etc/systemd/system/helix.service <<UNIT
[Unit]
Description=Helix: runs Animus jobs
After=network-online.target tailscaled.service
Wants=network-online.target
# Nothing to run until a repository and a person are added.
ConditionPathExists=$NEW_HOME/.helix/config.yaml
StartLimitIntervalSec=0

[Service]
User=$NEW_USER
WorkingDirectory=$NEW_HOME/animus
Environment=PATH=$NEW_HOME/.local/bin:/usr/local/bin:/usr/bin:/bin
# Claude Code moves only when Helix does (helix upgrade, then update it by hand):
# a job never meets a new Claude Code halfway through a release.
Environment=DISABLE_AUTOUPDATER=1
ExecStart=/usr/local/bin/node --disable-warning=ExperimentalWarning $NEW_HOME/animus/helix/src/cli.ts serve
Restart=always
RestartSec=5
# A job is a tree of processes: when Helix stops, all of it stops, and the
# next start finds the job in the table and resumes it.
KillMode=control-group
TimeoutStopSec=30

[Install]
WantedBy=multi-user.target
UNIT
# Every 15 minutes, helix upgrade --follow: when origin's stable branch is at a
# release this machine is not on, it drains, installs, tests and restarts Helix,
# going back if anything fails. A release that failed is not tried again on its
# own. Off: sudo systemctl disable --now helix-upgrade.timer
cat > /etc/systemd/system/helix-upgrade.service <<UNIT
[Unit]
Description=Helix: move to the release origin's stable branch is at
After=network-online.target
Wants=network-online.target
ConditionPathExists=$NEW_HOME/.helix/config.yaml

[Service]
Type=oneshot
User=$NEW_USER
WorkingDirectory=$NEW_HOME/animus
Environment=PATH=$NEW_HOME/.local/bin:/usr/local/bin:/usr/bin:/bin
Environment=DISABLE_AUTOUPDATER=1
# It waits for running jobs to end, however long they take.
TimeoutStartSec=infinity
ExecStart=/usr/local/bin/node --disable-warning=ExperimentalWarning $NEW_HOME/animus/helix/src/cli.ts upgrade --follow
UNIT
cat > /etc/systemd/system/helix-upgrade.timer <<UNIT
[Unit]
Description=Helix: look for a new release every 15 minutes

[Timer]
OnBootSec=15min
OnUnitActiveSec=15min

[Install]
WantedBy=timers.target
UNIT
# The account may start, stop and read its own services without the password; nothing else.
cat > /etc/sudoers.d/helix <<SUDO
$NEW_USER ALL=(root) NOPASSWD: /usr/bin/systemctl start helix.service, /usr/bin/systemctl stop helix.service, /usr/bin/systemctl restart helix.service, /usr/bin/systemctl status helix.service, /usr/bin/systemctl start helix-upgrade.service, /usr/bin/systemctl status helix-upgrade.service
SUDO
chmod 440 /etc/sudoers.d/helix
visudo -cf /etc/sudoers.d/helix >/dev/null || { rm -f /etc/sudoers.d/helix; die "the sudoers rule did not parse and was removed"; }
systemctl daemon-reload
systemctl enable helix.service >/dev/null 2>&1
systemctl enable --now helix-upgrade.timer >/dev/null 2>&1

say "7. the screenshot browser may use its sandbox"
# Ubuntu stops a program from making user namespaces unless AppArmor has a
# profile for it, and Chrome's sandbox needs them. This names agent-browser's
# Chrome, as Ubuntu's own profile names /opt/google/chrome/chrome.
if [[ -d /etc/apparmor.d ]] && command -v apparmor_parser >/dev/null; then
  cat > /etc/apparmor.d/agent-browser-chrome <<PROFILE
abi <abi/4.0>,
include <tunables/global>

profile agent-browser-chrome $NEW_HOME/.agent-browser/browsers/*/chrome flags=(unconfined) {
  userns,
  include if exists <local/agent-browser-chrome>
}
PROFILE
  apparmor_parser -r /etc/apparmor.d/agent-browser-chrome
fi

say "8. $NEW_USER may run Docker"
# Membership of the docker group is as good as root on this machine: the
# account already has sudo, and only Helix uses it. Jobs never get the socket.
if getent group docker >/dev/null; then usermod -aG docker "$NEW_USER"
else echo "  Docker is not installed: jobs run on the machine until it is (see docs/helix-deploy.md)"; fi

say "read back"
printf '  %-22s %s\n' \
  hostname "$(hostname)" \
  tailscale "$(tailscale status --self --peers=false 2>/dev/null | awk '{print $2; exit}')" \
  "tailscaled at boot" "$(systemctl is-enabled tailscaled 2>&1)" \
  "ssh at boot" "$(systemctl is-enabled ssh 2>&1)" \
  "ssh passwords" "$(sshd -T 2>/dev/null | awk '/^passwordauthentication/ {print $2}')" \
  "$NEW_USER groups" "$(id -nG "$NEW_USER")" \
  "$NEW_USER keys" "$(grep -cE '^(ssh-|ecdsa-|sk-)' "$NEW_HOME/.ssh/authorized_keys")" \
  node "$(node -v)" \
  sleep "$(systemctl is-enabled sleep.target 2>&1)" \
  "helix at boot" "$(systemctl is-enabled helix.service 2>&1)" \
  "helix upgrades" "$(systemctl is-enabled helix-upgrade.timer 2>&1), next $(systemctl show helix-upgrade.timer -p NextElapseUSecRealtime --value 2>/dev/null)"

cat <<NEXT

Next, from your own computer:
  ssh $NEW_USER@$NEW_HOST          (check it works before anything else)
Then, signed in as $NEW_USER, finish.sh removes $OLD_USER.
NEXT
