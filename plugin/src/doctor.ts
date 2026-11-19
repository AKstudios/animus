// `animus doctor`: whether this machine can run and submit jobs, and what in
// the person's own setup would get in a job's way. It reads; it changes nothing.
import { spawnSync } from 'node:child_process';
import { accessSync, constants, existsSync, mkdirSync, readFileSync } from 'node:fs';
import { homedir } from 'node:os';
import { join } from 'node:path';
import { animusHome } from './log.ts';
import { openLocalQueue, queueFile } from './local-queue.ts';
import { onPath } from './pipeline.ts';
import { personalConfig, personalFor, snapshotSkills } from './personal.ts';
import { PROFILE_PATH, loadProfile } from './profile.ts';
import { helixLogin, helixVersion } from './remote.ts';
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

/**
 * Animus's own marketplace as it was called up to 0.3.5. Beside akstudios it
 * loads the same skills twice.
 */
export function oldAnimusMarketplace(claudeDir: string): boolean {
  try {
    const known = JSON.parse(readFileSync(join(claudeDir, 'plugins', 'known_marketplaces.json'), 'utf8')) as Record<string, { source?: { repo?: string } }>;
    return /^akstudios\/animus$/i.test(known.animus?.source?.repo ?? '');
  } catch { return false; }
}

/** Git settings of the person's that reach a job's own commits. */
export function gitFindings(read: (key: string) => string): Finding[] {
  const found: Finding[] = [];
  const hooks = read('core.hooksPath');
  if (hooks) found.push({ level: 'warn', what: 'git hooks', detail: `core.hooksPath is ${hooks} in your git config, so those hooks run on every commit a job makes; a hook that waits for input stops the job` });
  if (/^true$/i.test(read('commit.gpgsign'))) found.push({ level: 'warn', what: 'commit signing', detail: 'commit.gpgsign is on: a job\'s commits are signed too, and a key that asks for a passphrase stops the job until someone types it. Cache the passphrase, or sign only outside jobs' });
  return found;
}

// Set by the shell on its own, differing from one terminal to the next; no job needs them.
const SHELL_ONLY = new Set(['_', 'PWD', 'OLDPWD', 'SHLVL']);

/** Variables the shell has that the loop, started from another environment, does not: what a job there would not see. */
export function missingInLoop(loopEnv: readonly string[], shell: Record<string, string | undefined>): string[] {
  const has = new Set(loopEnv);
  return Object.keys(shell).filter((name) => !has.has(name) && !SHELL_ONLY.has(name)).sort();
}

/** The loop's environment against this shell's: a variable set after the loop started (a token, a proxy) does not reach its jobs until it restarts. */
export function loopFindings(shell: Record<string, string | undefined>, home = animusHome()): Finding[] {
  if (!existsSync(queueFile(home))) return [];
  const queue = openLocalQueue(home);
  try {
    const loop = queue.loop();
    if (!loop) return [];
    const missing = missingInLoop(loop.env, shell);
    if (!missing.length) return [];
    const shown = missing.length > 8 ? `${missing.slice(0, 8).join(', ')} and ${missing.length - 8} more` : missing.join(', ');
    return [{ level: 'warn', what: 'loop environment', detail: `the loop on this machine (pid ${loop.pid}) started without ${shown}, which this shell has; its jobs do not see them. They run with the environment of the animus that started the loop: restart it once its jobs end (it exits when nothing is left)` }];
  } finally { queue.close(); }
}

/** helixUrl: a Helix being joined, which this machine has no token for yet. */
export async function doctor(cwd: string, env = process.env, opts: { helixUrl?: string } = {}): Promise<Finding[]> {
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
  if (!onPath('animus')) add('warn', 'animus on PATH', `only inside Claude Code. In a terminal, run "${env.ANIMUS_BIN ?? 'path/to/plugin/bin/animus'}" setup: it puts animus in ~/.local/bin`);

  const claudeDir = env.CLAUDE_CONFIG_DIR ?? join(homedir(), '.claude');
  if (oldAnimusMarketplace(claudeDir)) add('warn', 'old marketplace', 'Animus\'s marketplace is called akstudios now, and the one called animus loads Animus a second time: run animus setup, which removes it, or claude plugin marketplace remove animus and claude plugin install animus@akstudios');
  const orbit = orbitMarketplace(claudeDir);
  if (orbit) add('fail', 'orbit', `the marketplace called animus is orbit's (${orbit}), whose plugin is also called animus. Remove it in Claude Code (/plugin, Marketplaces) and add Animus's`);

  const home = animusHome();
  try { mkdirSync(home, { recursive: true }); accessSync(home, constants.W_OK); } catch { add('fail', 'ANIMUS_HOME', `${home} cannot be written: a job keeps its state there`); }

  const read = (key: string) => out('git', ['config', '--global', '--get', key]).text;
  found.push(...gitFindings(read));
  found.push(...loopFindings(env));

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
    if (existsSync(personalConfig())) {
      try {
        const mine = personalFor(top.text);
        snapshotSkills(mine.skills);
        add('ok', 'your config', [
          mine.run ? `jobs here run ${mine.run.where === 'helix' ? 'on Helix' : 'on this machine'} (${mine.run.from.split(' in ')[0]})` : 'no run: set, so animus start picks',
          mine.skills.length ? `your skills: ${mine.skills.map((k) => `${k.name} (${k.roles.join(', ')})`).join(', ')}` : 'no skills of yours',
        ].join('; '));
      } catch (err) { add('fail', 'your config', (err as Error).message); }
    }
  }
  add('info', 'isolation', 'jobs load only the project\'s Claude settings and rules, start no MCP server, and get no skills or slash commands of yours beyond those named in your config.yaml');

  const login = helixLogin(env);
  const url = opts.helixUrl ?? login?.url ?? env.HELIX_URL;
  if (!url) add('info', 'helix', 'this machine has not joined a Helix (animus join <url> <code>): jobs run here only');
  else {
    try {
      const theirs = await helixVersion(url);
      add(compatible(theirs, animusVersion()) ? 'ok' : 'fail', 'helix', compatible(theirs, animusVersion()) ? `${url} runs ${theirs}` : `${url} runs ${theirs} and this is ${animusVersion()}: update whichever is older`);
    } catch (err) { add('fail', 'helix', (err as Error).message); }
    // Joining: the token comes at the end.
    if (opts.helixUrl) { /* nothing to say yet */ } else if (login) add('ok', 'helix token', `${login.name ? `${login.name}'s, ` : ''}from ${login.from}`);
    else add('fail', 'helix token', 'HELIX_URL is set and HELIX_TOKEN is not: animus join gives this machine one');
  }
  return found;
}

export function describeFindings(found: readonly Finding[]): string {
  const width = Math.max(...found.map((f) => f.what.length));
  return found.map((f) => `${f.level.padEnd(4)}  ${f.what.padEnd(width)}  ${f.detail}`).join('\n');
}
