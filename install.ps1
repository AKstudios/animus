# Installs Animus on Windows, in PowerShell:
#
#   irm https://raw.githubusercontent.com/AKstudios/animus/stable/install.ps1 | iex
#
# It gets what Animus's own setup needs before it can start (git, Node 24 and
# Claude Code), asking before it installs any of them with winget, adds the
# akstudios marketplace to Claude Code, and hands over to `animus setup` for
# the rest. macOS and Linux: install.sh.
$ErrorActionPreference = 'Stop'

$Repo = 'AKstudios/animus'
$Ref = if ($env:ANIMUS_REF) { $env:ANIMUS_REF } else { 'stable' }
$Market = 'akstudios'

function Ok($what) { Write-Host "✓ $what" }
function Have($command) { [bool](Get-Command $command -ErrorAction SilentlyContinue) }
function Ask($question) {
  $answer = Read-Host "$question [Y/n]"
  return ($answer -eq '' -or $answer -match '^[Yy]')
}
function Stop-Install($why) {
  Write-Host $why
  Write-Host 'Then run the install command again.'
  exit 1
}
# winget changes PATH for new terminals only; this one reads it again.
function Update-Path {
  $env:Path = [Environment]::GetEnvironmentVariable('Path', 'Machine') + ';' + [Environment]::GetEnvironmentVariable('Path', 'User')
}
function Install-Winget($id, $what) {
  if (-not (Have 'winget')) { Stop-Install "$what is not installed, and this machine has no winget to install it with. Install $what." }
  if (-not (Ask "$what is not installed. Install it with winget install $id?")) { Stop-Install "Install $what." }
  winget install --id $id -e --source winget --accept-package-agreements --accept-source-agreements
  Update-Path
}

Write-Host "Animus install`n"

# git, with its Git Bash: Claude Code runs commands in it on Windows.
if (Have 'git') { Ok 'git' } else {
  Install-Winget 'Git.Git' 'git'
  if (-not (Have 'git')) { Stop-Install 'git is installed, but this terminal cannot see it yet. Open a new terminal.' }
}

# Node 24 or later: the animus command, and everything a job runs, is Node.
function Node-Major { if (Have 'node') { [int](node -p 'process.versions.node.split(".")[0]') } else { 0 } }
if ((Node-Major) -ge 24) { Ok "node $(node --version)" } else {
  Install-Winget 'OpenJS.NodeJS' 'Node 24 or later'
  if ((Node-Major) -lt 24) { Stop-Install 'Node is installed, but this terminal cannot see it yet. Open a new terminal.' }
  Ok "node $(node --version)"
}

# Claude Code: its native installer.
if (Have 'claude') { Ok "claude $(claude --version)" } else {
  if (-not (Ask 'Claude Code is not installed. Install it with its own installer (claude.ai/install.ps1)?')) { Stop-Install 'Install Claude Code (https://code.claude.com).' }
  Invoke-RestMethod https://claude.ai/install.ps1 | Invoke-Expression
  $env:Path = "$env:USERPROFILE\.local\bin;$env:Path"
  if (-not (Have 'claude')) { Stop-Install 'Claude Code is installed, but this terminal cannot see it yet. Open a new terminal.' }
}

# The marketplace. https, so a machine with no GitHub ssh key can clone it.
$env:CLAUDE_CODE_PLUGIN_PREFER_HTTPS = '1'
$known = claude plugin marketplace list --json | ConvertFrom-Json
if ($known | Where-Object { $_.name -eq $Market }) {
  claude plugin marketplace update $Market *> $null
} else {
  claude plugin marketplace add "$Repo#$Ref"
  if ($LASTEXITCODE -ne 0) { Stop-Install "Could not add the $Market marketplace." }
  $known = claude plugin marketplace list --json | ConvertFrom-Json
}
Ok "the $Market marketplace is in Claude Code`n"

$where = ($known | Where-Object { $_.name -eq $Market }).installLocation
$setup = Join-Path $where 'plugin\src\setup.ts'
if (-not (Test-Path $setup)) { Stop-Install "The $Market marketplace has no plugin\src\setup.ts at $where." }
node --disable-warning=ExperimentalWarning $setup
exit $LASTEXITCODE
