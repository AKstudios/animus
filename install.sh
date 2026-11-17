#!/usr/bin/env bash
# Installs Animus on macOS or Linux:
#
#   curl -fsSL https://raw.githubusercontent.com/AKstudios/animus/stable/install.sh | bash
#
# It gets what Animus's own setup needs before it can start (git, Node 24 and
# Claude Code), asking before it installs any of them, adds the akstudios
# marketplace to Claude Code, and hands over to `animus setup` for the rest.
# Windows: install.ps1.
set -euo pipefail

# Setup asks to put ~/.local/bin on PATH if the person's own PATH lacks it;
# this script adds it to its own, so it passes the one it started with.
export ANIMUS_PATH_BEFORE="${ANIMUS_PATH_BEFORE:-$PATH}"

REPO="AKstudios/animus"
REF="${ANIMUS_REF:-stable}"
MARKET="akstudios"

say() { printf '%s\n' "$*"; }
ok() { printf '✓ %s\n' "$*"; }
die() { printf 'animus install: %s\n' "$*" >&2; exit 1; }
have() { command -v "$1" >/dev/null 2>&1; }
os="$(uname -s)"

# Piped into bash, the script is stdin: questions are asked on the terminal.
if ! { : </dev/tty; } 2>/dev/null; then die "run this from a terminal: it asks before installing anything"; fi
ask() {
  local answer
  read -r -p "$1 [Y/n] " answer </dev/tty || true
  [[ -z $answer || $answer =~ ^[Yy] ]]
}
stop() { say "$1"; say "Then run the install command again."; exit 1; }

say "Animus install"
say ""

# git: Claude Code clones the marketplace with it, and every job works in it.
if have git && git --version >/dev/null 2>&1; then
  ok "git"
elif [[ $os == Darwin ]]; then
  if have brew; then
    ask "git is not installed. Install it with brew install git?" || stop "Install git."
    brew install git
  else
    say "git is not installed. macOS installs it with its Command Line Tools: a window opens."
    xcode-select --install || true
    stop "When the Command Line Tools have finished installing,"
  fi
elif have apt-get; then
  ask "git is not installed. Install it with sudo apt-get install git?" || stop "Install git."
  sudo apt-get update -qq && sudo apt-get install -y git
elif have dnf; then
  ask "git is not installed. Install it with sudo dnf install git?" || stop "Install git."
  sudo dnf install -y git
else
  stop "git is not installed. Install it with your package manager."
fi

# Node 24 or later: the animus command, and everything a job runs, is Node.
node_major() { node -p 'process.versions.node.split(".")[0]' 2>/dev/null || echo 0; }
load_nvm() {
  export NVM_DIR="${NVM_DIR:-$HOME/.nvm}"
  # shellcheck disable=SC1091
  [[ -s $NVM_DIR/nvm.sh ]] && . "$NVM_DIR/nvm.sh"
}
if ! have node || (( $(node_major) < 24 )); then load_nvm || true; fi
if have node && (( $(node_major) >= 24 )); then
  ok "node $(node --version)"
else
  found="$(have node && node --version || echo none)"
  if [[ $os == Darwin ]] && have brew; then
    ask "Animus needs Node 24 or later (found: $found). Install it with brew install node?" || stop "Install Node 24 or later (https://nodejs.org)."
    brew install node
  else
    ask "Animus needs Node 24 or later (found: $found). Install Node 24 with nvm, for your user only?" || stop "Install Node 24 or later (https://nodejs.org)."
    if ! load_nvm || ! have nvm; then
      curl -fsSL https://raw.githubusercontent.com/nvm-sh/nvm/v0.40.3/install.sh | bash
      load_nvm
    fi
    nvm install 24
    nvm alias default 24 >/dev/null
  fi
  hash -r
  (( $(node_major) >= 24 )) || stop "Node 24 did not install."
  ok "node $(node --version)"
fi

# Claude Code: its native installer, which puts claude in ~/.local/bin.
export PATH="$HOME/.local/bin:$PATH"
if have claude; then
  ok "claude $(claude --version 2>/dev/null | head -1)"
else
  ask "Claude Code is not installed. Install it with its own installer (claude.ai/install.sh)?" || stop "Install Claude Code (https://code.claude.com)."
  curl -fsSL https://claude.ai/install.sh | bash
  hash -r
  have claude || stop "Claude Code did not install."
fi

# The marketplace. https, so a machine with no GitHub ssh key can clone it.
export CLAUDE_CODE_PLUGIN_PREFER_HTTPS=1
if claude plugin marketplace list --json 2>/dev/null | grep -q "\"name\": *\"$MARKET\""; then
  claude plugin marketplace update "$MARKET" >/dev/null 2>&1 || true
else
  claude plugin marketplace add "$REPO#$REF" || die "could not add the $MARKET marketplace"
fi
ok "the $MARKET marketplace is in Claude Code"
say ""

where="$(claude plugin marketplace list --json | node -e '
  let s = ""; process.stdin.on("data", (d) => (s += d)).on("end", () => {
    const m = JSON.parse(s).find((k) => k.name === process.argv[1]);
    if (m) console.log(m.installLocation);
  });' "$MARKET")"
[[ -n $where && -f $where/plugin/src/setup.ts ]] || die "the $MARKET marketplace has no plugin/src/setup.ts at ${where:-an unknown place}"
exec node --disable-warning=ExperimentalWarning "$where/plugin/src/setup.ts" </dev/tty
