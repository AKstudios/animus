// `animus doctor`: whether this machine can run and submit jobs, and what in
// the person's own setup would get in a job's way. It reads; it changes nothing.
import { spawnSync } from 'node:child_process';
import { accessSync, constants, existsSync, mkdirSync, readFileSync } from 'node:fs';
import { homedir } from 'node:os';
import { join } from 'node:path';
import { animusHome } from './log.ts';
import { onPath } from './pipeline.ts';
import { PROFILE_PATH, loadProfile } from './profile.ts';
import { helixVersion } from './remote.ts';
import { animusVersion, atLeast, compatible, MIN_CLAUDE } from './version.ts';

export type Finding = { level: 'ok' | 'warn' | 'fail' | 'info'; what: string; detail: string };

const out = (command: string, args: string[], cwd?: string) => {
  const r = spawnSync(command, args, { encoding: 'utf8', ...(cwd ? { cwd } : {}) });
  return { ok: r.status === 0, text: `${r.stdout ?? ''}${r.stderr ?? ''}`.trim() };
};

/**
 * Orbit, the project Animus replaced, shipped a plugin also called animus from
 * a marketplace also called animus. Where that is still registered, it is the
 * one Claude Code loads.
 */
export function orbitMarketplace(claudeDir: string): string | undefined {
  const file = join(claudeDir, 'plugins', 'known_marketplaces.json');
  if (!existsSync(file)) return undefined;
  try {
    const known = JSON.parse(readFileSync(file, 'utf8')) as Record<string, { source?: unknown; installLocation?: string }>;
    const entry = known.animus;
    if (!entry) return undefined;
    const where = JSON.stringify(entry.source ?? {});
    if (/orbit/i.test(where)) return where;
    const location = entry.installLocation;
    // Orbit's plugin has no planner; Animus's always has.
    if (location && existsSync(join(location, 'plugin')) && !existsSync(join(location, 'plugin', 'src', 'slices.ts'))) return location;
  } catch { /* unreadable: nothing to say */ }
  return undefined;
}

/** Git settings of the person's that reach a job's own commits. */
export function gitFindings(read: (key: string) => string): Finding[] {
  const found: Finding[] = [];
  const hooks = read('core.hooksPath');
  if (hooks) found.push({ level: 'warn', what: 'git hooks', detail: `core.hooksPath is ${hooks} in your git config, so those hooks run on every commit a job makes; a hook that waits for input stops the job` });
  if (/^true$/i.test(read('commit.gpgsign'))) found.push({ level: 'warn', what: 'commit signing', detail: 'commit.gpgsign is on: a job\'s commits are signed too, and a key that asks for a passphrase stops the job until someone types it. Cache the passphrase, or sign only outside jobs' });
  return found;
}

export async function doctor(cwd: string, env = process.env): Promise<Finding[]> {
  const found: Finding[] = [];
  const add = (level: Finding['level'], what: string, detail: string) => found.push({ level, what, detail });

  add('ok', 'animus', `${animusVersion()}`);
  add('ok', 'node', process.version);

  const claude = out('claude', ['--version']);
  if (!claude.ok) add('fail', 'claude', 'Claude Code is not on PATH: every job runs it');
  else if (!atLeast(claude.text, MIN_CLAUDE)) add('fail', 'claude', `${claude.text} is older than ${MIN_CLAUDE}, the oldest a job has run on; update Claude Code`);
  else add('ok', 'claude', claude.text);

  if (!onPath('git')) add('fail', 'git', 'not on PATH');
  if (!onPath('gh')) add('fail', 'gh', 'not on PATH: a job cannot open its pull request');
  else {
    const auth = out('gh', ['auth', 'status']);
    add(auth.ok ? 'ok' : 'fail', 'gh', auth.ok ? 'signed in' : 'not signed in: run gh auth login');
  }

  // In a Claude Code session the plugin puts animus on the Bash tool's PATH; a terminal needs a link.
  if (!onPath('animus')) add('warn', 'animus on PATH', `only inside Claude Code. For a terminal: ln -s "${env.ANIMUS_BIN ?? 'path/to/plugin/bin/animus'}" ~/.local/bin/animus`);

  const orbit = orbitMarketplace(env.CLAUDE_CONFIG_DIR ?? join(homedir(), '.claude'));
  if (orbit) add('fail', 'orbit', `the marketplace called animus is orbit's (${orbit}), whose plugin is also called animus. Remove it in Claude Code (/plugin, Marketplaces) and add Animus's`);

  const home = animusHome();
  try { mkdirSync(home, { recursive: true }); accessSync(home, constants.W_OK); } catch { add('fail', 'ANIMUS_HOME', `${home} cannot be written: a job keeps its state there`); }

  const read = (key: string) => out('git', ['config', '--global', '--get', key]).text;
  found.push(...gitFindings(read));

  const top = out('git', ['rev-parse', '--show-toplevel'], cwd);
  if (top.ok) {
    try {
      loadProfile(top.text);
      add('ok', 'profile', `${PROFILE_PATH} loads`);
    } catch (err) {
      add('warn', 'profile', existsSync(join(top.text, PROFILE_PATH)) ? (err as Error).message : `no ${PROFILE_PATH} here: animus init drafts one`);
    }
    const settings = join(top.text, '.claude', 'settings.json');
    if (existsSync(settings) && /"hooks"\s*:/.test(readFileSync(settings, 'utf8'))) add('info', 'project hooks', `${settings} has hooks; jobs run them, as the project's own rules`);
  }
  add('info', 'isolation', 'jobs load only the project\'s Claude settings and rules, start no MCP server, and get no skills or slash commands of yours');

  const url = env.HELIX_URL;
  if (!url) add('info', 'helix', 'HELIX_URL is not set: jobs run on this machine only');
  else {
    try {
      const theirs = await helixVersion(url);
      add(compatible(theirs, animusVersion()) ? 'ok' : 'fail', 'helix', compatible(theirs, animusVersion()) ? `${url} runs ${theirs}` : `${url} runs ${theirs} and this is ${animusVersion()}: update whichever is older`);
    } catch (err) { add('fail', 'helix', (err as Error).message); }
    if (!env.HELIX_TOKEN) add('fail', 'helix token', 'HELIX_TOKEN is not set: it comes from helix add-person');
  }
  return found;
}

export function describeFindings(found: readonly Finding[]): string {
  const width = Math.max(...found.map((f) => f.what.length));
  return found.map((f) => `${f.level.padEnd(4)}  ${f.what.padEnd(width)}  ${f.detail}`).join('\n');
}
