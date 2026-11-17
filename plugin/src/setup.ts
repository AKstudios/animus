// `animus setup`: gets a person's machine ready for Animus and asks them what
// only they can answer: whether to take updates by themselves, and which of
// their projects to turn Animus on in. `animus enable` is the last part alone.
//
// install.sh and install.ps1 run this file straight from the marketplace's
// clone, before the plugin is installed and so before its dependencies are, so
// it imports nothing outside Node but ./semver.ts and ./proc.ts.
import { spawnSync } from 'node:child_process';
import { chmodSync, existsSync, mkdirSync, readdirSync, readFileSync, realpathSync, statSync, writeFileSync } from 'node:fs';
import { homedir } from 'node:os';
import { delimiter, join, resolve } from 'node:path';
import { createInterface } from 'node:readline/promises';
import { fileURLToPath } from 'node:url';
import { AnimusError } from './proc.ts';
import { atLeast, MIN_CLAUDE } from './semver.ts';

export const MARKETPLACE = 'akstudios';
export const PLUGIN = `animus@${MARKETPLACE}`;
export const SOURCE = { source: 'github', repo: 'AKstudios/animus', ref: 'stable' } as const;
/** Where Claude Code keeps a plugin turned on for one person in one checkout. */
const LOCAL_SETTINGS = '.claude/settings.local.json';
/** The first line of the `animus` command setup writes, so it knows its own. */
const SHIM_MARK = '// animus: written by animus setup';

export type Run = (command: string, args: string[], opts?: { cwd?: string; interactive?: boolean }) => { ok: boolean; out: string };

export type Io = {
  ask: (question: string) => Promise<string>;
  say: (line: string) => void;
  run: Run;
};

export type Machine = {
  home: string;
  claudeDir: string;
  platform: NodeJS.Platform;
  /** PATH as the person's shell has it (the install scripts pass theirs from before they changed it), to see whether ~/.local/bin is on it. */
  path: string;
  /** The shell the person uses, for the line that puts ~/.local/bin on PATH. */
  shell?: string;
};

export function thisMachine(env = process.env): Machine {
  const home = homedir();
  return { home, claudeDir: env.CLAUDE_CONFIG_DIR ?? join(home, '.claude'), platform: process.platform, path: env.ANIMUS_PATH_BEFORE ?? env.PATH ?? env.Path ?? '', shell: env.SHELL };
}

export const realRun: Run = (command, args, opts = {}) => {
  const r = spawnSync(command, args, {
    cwd: opts.cwd,
    encoding: 'utf8',
    stdio: opts.interactive ? 'inherit' : 'pipe',
  });
  return { ok: r.status === 0, out: `${r.stdout ?? ''}${r.stderr ?? ''}`.trim() };
};

const yes = (answer: string) => answer.trim() === '' || /^y/i.test(answer.trim());

// ---------------------------------------------------------------- the tools

type Install = { command: string; args: string[]; shown: string };

/** How this machine installs gh, or undefined where setup cannot. */
export function ghInstall(m: Machine, run: Run): Install | undefined {
  if (m.platform === 'darwin' && run('brew', ['--version']).ok) return { command: 'brew', args: ['install', 'gh'], shown: 'brew install gh' };
  if (m.platform === 'win32') return { command: 'winget', args: ['install', '--id', 'GitHub.cli', '-e', '--source', 'winget'], shown: 'winget install GitHub.cli' };
  if (m.platform === 'linux') {
    if (run('apt-get', ['--version']).ok) return { command: 'sudo', args: ['apt-get', 'install', '-y', 'gh'], shown: 'sudo apt-get install gh' };
    if (run('dnf', ['--version']).ok) return { command: 'sudo', args: ['dnf', 'install', '-y', 'gh'], shown: 'sudo dnf install gh' };
  }
  return undefined;
}

/** Claude Code, signed in and new enough; gh, installed and signed in, and git using it for GitHub. False when setup has to stop. */
async function tools(io: Io, m: Machine): Promise<boolean> {
  const claude = io.run('claude', ['--version']);
  if (!claude.ok) {
    io.say('Claude Code is not installed. Install it (https://code.claude.com), then run this again.');
    return false;
  }
  if (!atLeast(claude.out, MIN_CLAUDE)) {
    io.say(`Claude Code is ${claude.out}; Animus needs ${MIN_CLAUDE} or later. Updating it.`);
    if (!io.run('claude', ['update'], { interactive: true }).ok) {
      io.say('The update failed. Run claude update, then this again.');
      return false;
    }
  }
  const status = io.run('claude', ['auth', 'status', '--json']);
  let signedIn = false;
  try { signedIn = (JSON.parse(status.out) as { loggedIn?: boolean }).loggedIn === true; } catch { /* not JSON: not signed in */ }
  if (signedIn) io.say('✓ Claude Code is signed in');
  else {
    io.say('Claude Code is not signed in. Signing in (a browser opens).');
    if (!io.run('claude', ['auth', 'login'], { interactive: true }).ok) {
      io.say('Signing in did not finish. Run claude auth login, then this again.');
      return false;
    }
  }

  if (!io.run('gh', ['--version']).ok) {
    const how = ghInstall(m, io.run);
    if (!how) {
      io.say('GitHub\'s gh is not installed, and jobs open their pull requests with it. Install it (https://cli.github.com), then run this again.');
      return false;
    }
    if (!yes(await io.ask(`GitHub's gh is not installed; jobs open their pull requests with it. Install it with ${how.shown}? [Y/n] `))) {
      io.say('Install gh (https://cli.github.com), then run this again.');
      return false;
    }
    if (!io.run(how.command, how.args, { interactive: true }).ok || !io.run('gh', ['--version']).ok) {
      io.say(m.platform === 'win32'
        ? 'gh is installed, but this terminal cannot see it yet. Open a new terminal and run the install command again.'
        : `${how.shown} did not work. Install gh (https://cli.github.com), then run this again.`);
      return false;
    }
  }
  if (io.run('gh', ['auth', 'status']).ok) io.say('✓ gh is signed in to GitHub');
  else {
    io.say('gh is not signed in to GitHub. Signing in.');
    if (!io.run('gh', ['auth', 'login', '--hostname', 'github.com', '--git-protocol', 'https', '--web'], { interactive: true }).ok) {
      io.say('Signing in did not finish. Run gh auth login, then this again.');
      return false;
    }
  }
  // Claude Code clones the marketplace, and jobs push, with git's own credentials.
  io.run('gh', ['auth', 'setup-git']);
  return true;
}

// ------------------------------------------------------------ the marketplace

type Known = { name: string; repo?: string; installLocation?: string };

function marketplaces(run: Run): Known[] {
  const r = run('claude', ['plugin', 'marketplace', 'list', '--json']);
  try { return r.ok ? JSON.parse(r.out) as Known[] : []; } catch { return []; }
}

type Installed = Record<string, { scope: string; installPath: string; version: string; projectPath?: string }[]>;

export function installedPlugins(claudeDir: string): Installed {
  try {
    const file = JSON.parse(readFileSync(join(claudeDir, 'plugins', 'installed_plugins.json'), 'utf8')) as { plugins?: Installed };
    return file.plugins ?? {};
  } catch { return {}; }
}

/**
 * Takes away Animus's marketplace under any name but akstudios (it was
 * called animus up to 0.3.5), and the plugin installed from it, wherever it is
 * on. Claude Code knows a marketplace by its source, so akstudios cannot be
 * added beside it: false when the person keeps it.
 */
async function oldName(io: Io, m: Machine): Promise<boolean> {
  const old = marketplaces(io.run).find((k) => k.name !== MARKETPLACE && k.repo?.toLowerCase() === SOURCE.repo.toLowerCase());
  if (!old) return true;
  if (!yes(await io.ask(`You have Animus's marketplace under its old name, ${old.name}. It is called ${MARKETPLACE} now, and Claude Code cannot have both. Move it? (Animus is installed again from ${MARKETPLACE} below.) [Y/n] `))) {
    io.say(`Keeping ${old.name}, so setup stops here. Run it again to move it.`);
    return false;
  }
  for (const where of installedPlugins(m.claudeDir)[`animus@${old.name}`] ?? []) {
    io.run('claude', ['plugin', 'uninstall', `animus@${old.name}`, '--scope', where.scope], where.projectPath ? { cwd: where.projectPath } : {});
  }
  const r = io.run('claude', ['plugin', 'marketplace', 'remove', old.name]);
  if (!r.ok) {
    io.say(`Could not remove the ${old.name} marketplace: ${r.out}. Remove it in Claude Code (/plugin, Marketplaces), then run this again.`);
    return false;
  }
  io.say(`✓ removed the ${old.name} marketplace`);
  return true;
}

/** Adds the akstudios marketplace when it is not there yet. */
function marketplace(io: Io): boolean {
  if (marketplaces(io.run).some((k) => k.name === MARKETPLACE)) return true;
  const r = io.run('claude', ['plugin', 'marketplace', 'add', `${SOURCE.repo}#${SOURCE.ref}`]);
  if (r.ok && marketplaces(io.run).some((k) => k.name === MARKETPLACE)) return true;
  io.say(`Could not add the ${MARKETPLACE} marketplace${r.out ? `: ${r.out}` : ''}`);
  return false;
}

/**
 * Turns on Claude Code's own updates for the marketplace. The entry in the
 * user's settings comes first in Claude Code's order, so it is set there; the
 * toggle under /plugin writes the same.
 */
export function autoUpdate(claudeDir: string): void {
  const file = join(claudeDir, 'settings.json');
  const settings = existsSync(file) ? JSON.parse(readFileSync(file, 'utf8')) as Record<string, unknown> : {};
  const known = (settings.extraKnownMarketplaces ?? {}) as Record<string, Record<string, unknown>>;
  known[MARKETPLACE] = { source: { ...SOURCE }, ...known[MARKETPLACE], autoUpdate: true };
  settings.extraKnownMarketplaces = known;
  mkdirSync(claudeDir, { recursive: true });
  writeFileSync(file, `${JSON.stringify(settings, null, 2)}\n`);
}

export function autoUpdating(claudeDir: string): boolean {
  try {
    const settings = JSON.parse(readFileSync(join(claudeDir, 'settings.json'), 'utf8')) as { extraKnownMarketplaces?: Record<string, { autoUpdate?: boolean }> };
    return settings.extraKnownMarketplaces?.[MARKETPLACE]?.autoUpdate === true;
  } catch { return false; }
}

async function updates(io: Io, m: Machine): Promise<void> {
  if (autoUpdating(m.claudeDir)) { io.say('✓ Animus updates itself'); return; }
  if (!yes(await io.ask('Let Claude Code update Animus by itself when a new release is out? [Y/n] '))) {
    io.say(`  Then update by hand: claude plugin update ${PLUGIN}`);
    return;
  }
  try {
    autoUpdate(m.claudeDir);
    io.say('✓ Animus updates itself, shortly after a Claude Code session starts');
  } catch (err) {
    io.say(`Could not change ${join(m.claudeDir, 'settings.json')} (${(err as Error).message}). Turn it on in Claude Code: /plugin, Marketplaces, ${MARKETPLACE}, Enable auto-update.`);
  }
}

// ---------------------------------------------------------------- projects

/** Folders people keep their checkouts in. Those that exist are searched. */
const PROJECT_FOLDERS = ['Dev', 'dev', 'Developer', 'code', 'Code', 'src', 'projects', 'Projects', 'repos', 'git', 'GitHub', 'workspace', 'Workspace', join('Documents', 'GitHub'), join('Documents', 'Projects')];
const SKIP = new Set(['node_modules', 'vendor', 'target', 'dist', 'build', 'Library']);

/** Git checkouts under the person's usual folders, to depth four, not looking inside one. */
export function findRepos(home: string, extra: string[] = [], depth = 4, max = 300): string[] {
  const found = new Set<string>();
  const walk = (dir: string, left: number) => {
    if (found.size >= max) return;
    if (existsSync(join(dir, '.git'))) { found.add(dir); return; }
    if (left === 0) return;
    let entries: string[] = [];
    try { entries = readdirSync(dir).sort(); } catch { return; }
    for (const name of entries) {
      if (name.startsWith('.') || SKIP.has(name)) continue;
      const path = join(dir, name);
      try { if (statSync(path).isDirectory()) walk(path, left - 1); } catch { /* unreadable */ }
    }
  };
  // ~/dev and ~/Dev are one folder where names ignore case, as on a Mac.
  const roots = new Set<string>();
  for (const root of [...extra, ...PROJECT_FOLDERS.map((f) => join(home, f))]) {
    try { roots.add(realpathSync.native(root)); } catch { /* not there */ }
  }
  for (const root of roots) walk(root, depth);
  return [...found];
}

/**
 * What the person picked from a numbered list of n: numbers and ranges such
 * as "1 3 5-7", "all", or nothing. A string is a reason it could not be read.
 */
export function parsePicks(answer: string, n: number): number[] | string {
  const text = answer.trim().toLowerCase();
  if (text === '') return [];
  if (text === 'all') return Array.from({ length: n }, (_, i) => i);
  const picks = new Set<number>();
  for (const part of text.split(/[\s,]+/)) {
    const m = /^(\d+)(?:-(\d+))?$/.exec(part);
    if (!m) return `${part} is not a number or a range such as 2-4`;
    const from = Number(m[1]), to = Number(m[2] ?? m[1]);
    if (from < 1 || to > n || from > to) return `${part} is not between 1 and ${n}`;
    for (let i = from; i <= to; i++) picks.add(i - 1);
  }
  return [...picks].sort((a, b) => a - b);
}

const tilde = (path: string, home: string) => (path.startsWith(home) ? `~${path.slice(home.length)}` : path);

/** Whether Animus is on in every project: installed for the user. */
export function everywhere(claudeDir: string): boolean {
  return (installedPlugins(claudeDir)[PLUGIN] ?? []).some((p) => p.scope === 'user');
}

/** Turns Animus on in one checkout, for this person only: Claude Code keeps it in the checkout's .claude/settings.local.json. */
export function enable(io: Io, dir: string): boolean {
  const top = io.run('git', ['rev-parse', '--show-toplevel'], { cwd: dir });
  if (!top.ok) { io.say(`${dir} is not a git checkout`); return false; }
  const r = io.run('claude', ['plugin', 'install', PLUGIN, '--scope', 'local'], { cwd: top.out });
  if (!r.ok) { io.say(`Could not turn Animus on in ${tilde(top.out, homedir())}: ${r.out}`); return false; }
  // The settings file is this person's alone: kept out of git in the checkout's own exclude file, which is never committed.
  if (!io.run('git', ['check-ignore', '-q', LOCAL_SETTINGS], { cwd: top.out }).ok) {
    const exclude = io.run('git', ['rev-parse', '--git-path', 'info/exclude'], { cwd: top.out });
    if (exclude.ok) {
      const file = resolve(top.out, exclude.out);
      const before = existsSync(file) ? readFileSync(file, 'utf8') : '';
      mkdirSync(join(file, '..'), { recursive: true });
      writeFileSync(file, `${before}${before && !before.endsWith('\n') ? '\n' : ''}${LOCAL_SETTINGS}\n`);
    }
  }
  io.say(`✓ Animus is on in ${tilde(top.out, homedir())}`);
  return true;
}

async function projects(io: Io, m: Machine, cwd: string): Promise<void> {
  if (everywhere(m.claudeDir)) { io.say('✓ Animus is on in every project'); return; }
  const which = (await io.ask('Turn Animus on in every project, or only in the ones you pick? [every/pick] (pick) ')).trim().toLowerCase();
  if (which.startsWith('e')) {
    const r = io.run('claude', ['plugin', 'install', PLUGIN, '--scope', 'user']);
    io.say(r.ok ? '✓ Animus is on in every project' : `Could not install Animus: ${r.out}`);
    return;
  }
  const here = io.run('git', ['rev-parse', '--show-toplevel'], { cwd });
  const repos = findRepos(m.home, here.ok ? [here.out] : []);
  if (repos.length) {
    io.say('Your git checkouts:');
    repos.forEach((r, i) => io.say(`  ${String(i + 1).padStart(3)}  ${tilde(r, m.home)}`));
  } else io.say('No git checkouts found in your usual folders.');
  for (;;) {
    const answer = await io.ask(repos.length
      ? 'Which ones? Numbers or ranges (1 3 5-7), all, a path, or Enter for none: '
      : 'A path to a checkout, or Enter for none: ');
    const trimmed = answer.trim();
    if (/[/\\~]/.test(trimmed)) {
      enable(io, resolve(trimmed.replace(/^~(?=$|[/\\])/, m.home)));
      continue;
    }
    const picks = parsePicks(trimmed, repos.length);
    if (typeof picks === 'string') { io.say(picks); continue; }
    for (const i of picks) enable(io, repos[i]!);
    return;
  }
}

// ---------------------------------------------------------------- the command

/**
 * The `animus` command a terminal runs: it finds the newest installed copy of
 * the plugin and runs that one, so updates need nothing more. CommonJS in a
 * .cjs file, so a package.json above it cannot make it a module.
 */
export function shim(): string {
  return `${SHIM_MARK}. It runs the newest copy of the ${PLUGIN} plugin Claude Code installed.
'use strict';
const { spawnSync } = require('node:child_process');
const { readFileSync } = require('node:fs');
const { homedir } = require('node:os');
const { join } = require('node:path');
const major = Number(process.versions.node.split('.')[0]);
if (major < 24) { console.error('animus: needs Node 24 or later; this is ' + process.version); process.exit(1); }
const dir = process.env.CLAUDE_CONFIG_DIR || join(homedir(), '.claude');
let copies = [];
try { copies = JSON.parse(readFileSync(join(dir, 'plugins', 'installed_plugins.json'), 'utf8')).plugins['${PLUGIN}'] || []; } catch {}
const n = (v) => String(v).split('.').map(Number);
const newer = (a, b) => { const x = n(a.version), y = n(b.version); for (let i = 0; i < 3; i++) if (x[i] !== y[i]) return x[i] > y[i] ? a : b; return a; };
if (!copies.length) { console.error('animus: the ${PLUGIN} plugin is not installed; run animus setup, or claude plugin install ${PLUGIN}'); process.exit(1); }
const root = copies.reduce(newer).installPath;
const r = spawnSync(process.execPath, ['--disable-warning=ExperimentalWarning', join(root, 'src', 'cli.ts'), ...process.argv.slice(2)], {
  stdio: 'inherit', env: { ...process.env, ANIMUS_BIN: join(root, 'bin', 'animus') },
});
process.exit(r.status === null ? 1 : r.status);
`;
}

/** The launchers next to the shim: a shell script, and a .cmd for Windows. */
export const LAUNCHERS = {
  sh: `#!/bin/sh\n${SHIM_MARK.replace('//', '#')}\nexec node "$(dirname "$0")/animus.cjs" "$@"\n`,
  cmd: `@rem ${SHIM_MARK.slice(3)}\r\n@node "%~dp0animus.cjs" %*\r\n`,
};

/** The rc file and line that put ~/.local/bin on PATH, for the shell in use. */
export function pathLine(m: Machine): { file: string; line: string } | undefined {
  if (m.platform === 'win32') return undefined;
  const shell = (m.shell ?? '').split('/').pop();
  const file = shell === 'zsh' ? '.zshrc' : shell === 'fish' ? join('.config', 'fish', 'config.fish') : m.platform === 'darwin' ? '.bash_profile' : '.bashrc';
  const line = shell === 'fish' ? 'fish_add_path $HOME/.local/bin' : 'export PATH="$HOME/.local/bin:$PATH"';
  return { file: join(m.home, file), line };
}

/** Puts `animus` in ~/.local/bin, unless something else of that name is there. */
async function command(io: Io, m: Machine): Promise<void> {
  const bin = join(m.home, '.local', 'bin');
  const file = join(bin, m.platform === 'win32' ? 'animus.cmd' : 'animus');
  if (existsSync(file) && !readFileSync(file, 'utf8').includes(SHIM_MARK.slice(3))) {
    io.say(`✓ ${tilde(file, m.home)} is already there, and not setup's: left as it is`);
  } else {
    mkdirSync(bin, { recursive: true });
    writeFileSync(join(bin, 'animus.cjs'), shim());
    if (m.platform === 'win32') writeFileSync(join(bin, 'animus.cmd'), LAUNCHERS.cmd);
    else { writeFileSync(file, LAUNCHERS.sh); chmodSync(file, 0o755); }
    io.say(`✓ the animus command is in ${tilde(bin, m.home)}`);
  }
  const onPath = m.path.split(m.platform === 'win32' ? ';' : delimiter).some((p) => resolve(p.replace(/^~(?=$|[/\\])/, m.home)) === bin);
  if (onPath) return;
  const rc = pathLine(m);
  if (!rc) {
    io.say(`  ${bin} is not on your PATH. Add it under Settings, System, About, Advanced system settings, Environment Variables.`);
    return;
  }
  if (yes(await io.ask(`${tilde(bin, m.home)} is not on your PATH, so a terminal cannot find animus. Add it in ${tilde(rc.file, m.home)}? [Y/n] `))) {
    mkdirSync(join(rc.file, '..'), { recursive: true });
    const before = existsSync(rc.file) ? readFileSync(rc.file, 'utf8') : '';
    if (!before.includes(rc.line)) writeFileSync(rc.file, `${before}${before && !before.endsWith('\n') ? '\n' : ''}\n# animus, Claude Code\n${rc.line}\n`);
    io.say('✓ done; it takes effect in a new terminal');
  } else io.say(`  To add it yourself: ${rc.line}`);
}

export async function setup(io: Io, m: Machine, cwd: string): Promise<boolean> {
  io.say('Animus setup\n');
  if (!await tools(io, m)) return false;
  if (!await oldName(io, m)) return false;
  if (!marketplace(io)) return false;
  io.say('');
  await updates(io, m);
  io.say('');
  await projects(io, m, cwd);
  io.say('');
  await command(io, m);
  io.say(`
Animus is ready. In a project where it is on:
  1. animus init, once: it drafts .animus/animus.yaml. Read it and commit it.
  2. In Claude Code: /animus:grill-with-docs to shape the work, or
     /animus:to-spec when you already know it. The job starts by itself.
  3. Review the pull request and merge.

To turn it on in another project later, from inside that project:
  animus enable
or run animus setup again. To use the team's Helix, ask whoever runs it for
an invite.`);
  return true;
}

/** Questions on the terminal; setup cannot run without one. */
export function terminalIo(run: Run = realRun): Io {
  if (!process.stdin.isTTY) throw new AnimusError('animus setup asks questions, so it runs in a terminal');
  // One readline per question: between questions, sign-ins started here have the terminal to themselves.
  const ask = async (q: string) => {
    const rl = createInterface({ input: process.stdin, output: process.stdout });
    try { return await rl.question(q); } finally { rl.close(); }
  };
  return { ask, say: (line) => console.log(line), run };
}

// install.sh and install.ps1 run this file directly.
if (process.argv[1] && resolve(process.argv[1]) === fileURLToPath(import.meta.url)) {
  try {
    process.exitCode = await setup(terminalIo(), thisMachine(), process.cwd()) ? 0 : 1;
  } catch (err) {
    console.error(`animus setup: ${(err as Error).message}`);
    process.exitCode = 1;
  }
}
