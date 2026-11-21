// Process helpers. Everything here is synchronous: hooks and CLI commands run
// one thing at a time and exit.
import { spawnSync } from 'node:child_process';
import { existsSync } from 'node:fs';

/** An error meant for the person or agent running animus: printed without a stack trace. */
export class AnimusError extends Error {}

export class GitError extends Error {}

/**
 * How an agent should call this CLI. A plugin's bin/ is on PATH after any
 * other `animus` (an older install wins), so messages name the plugin's copy.
 */
export function animusCommand(): string {
  const bin = process.env.ANIMUS_BIN ?? (process.env.CLAUDE_PLUGIN_ROOT ? `${process.env.CLAUDE_PLUGIN_ROOT}/bin/animus` : undefined);
  return bin ? `"${bin}"` : 'animus';
}

export function git(cwd: string, args: string[], env?: NodeJS.ProcessEnv): string {
  const r = spawnSync('git', args, { cwd, encoding: 'utf8', ...(env ? { env: { ...process.env, ...env } } : {}) });
  if (r.status !== 0) {
    // Without a cwd git never starts: no status and no output to read.
    const why = existsSync(cwd) ? (r.stderr || r.stdout || r.error?.message || '').trim() : 'the directory does not exist';
    throw new GitError(`git ${args.join(' ')} failed in ${cwd}: ${why}`);
  }
  return r.stdout.trim();
}

export function tryGit(cwd: string, args: string[]): string | undefined {
  try { return git(cwd, args); } catch { return undefined; }
}

export type ShResult = { code: number; output: string; ms: number };

const CHECK_TIMEOUT_MS = 20 * 60 * 1000;

/** Runs a profile command through the shell, stdout and stderr together. */
export function sh(command: string, cwd: string, env: NodeJS.ProcessEnv = {}, timeout = CHECK_TIMEOUT_MS): ShResult {
  const started = Date.now();
  // stderr is joined to stdout before the command is read, so a command the shell cannot parse shows why.
  const r = spawnSync('/bin/sh', ['-c', 'exec 2>&1; eval "$1"', 'sh', command], {
    cwd, encoding: 'utf8', env: { ...process.env, ...env }, timeout, maxBuffer: 64 * 1024 * 1024,
  });
  const code = r.status ?? (r.signal ? 128 : 1);
  return { code, output: r.stdout ?? '', ms: Date.now() - started };
}

/** Why the shell cannot parse a command, or undefined when it can. Reads the command without running it. */
export function shellSyntaxError(command: string): string | undefined {
  const r = spawnSync('/bin/sh', ['-n', '-c', command], { encoding: 'utf8' });
  if (r.status === 0) return undefined;
  return (r.stderr || r.error?.message || `sh exited ${r.status}`).trim().split('\n')[0];
}

export const ANSI =/\x1b\[[0-9;?]*[A-Za-z]/g;
const ERROR_LINE = /\b(error|errors|failed|failure|fail|exception|traceback|not found|no such file|cannot|can't|no tests ran|assert\w*)\b|✗|×|✖/i;

/**
 * What a failed command printed, short enough for an agent's context: colour
 * codes removed, the lines that look like errors first (a long log buries them
 * under warnings), then its last lines.
 */
export function failureExcerpt(text: string, lines: number): string {
  // A minified bundle or a JSON dump is one line: cut each, and the whole.
  const all = text.replace(ANSI, '').trimEnd().split('\n').map((l) => (l.length > EXCERPT_LINE ? `${l.slice(0, EXCERPT_LINE)}… (${l.length} characters)` : l));
  const last = all.slice(-lines);
  const earlier = all.slice(0, -lines).filter((l) => ERROR_LINE.test(l)).slice(-15);
  const out = earlier.length ? `Error lines above the tail:\n${earlier.join('\n')}\n\nLast lines:\n${last.join('\n')}` : last.join('\n');
  return out.length > EXCERPT_MAX ? `…\n${out.slice(-EXCERPT_MAX)}` : out;
}

/**
 * Why a process that should have printed JSON did not: its start, where a CLI
 * says what it refused, and its end, where a crash says how it ended.
 */
export function exitExcerpt(text: string, chars = 400): string {
  const t = text.replace(ANSI, '').trim();
  return t.length <= chars * 2 ? t : `${t.slice(0, chars)}\n…\n${t.slice(-chars)}`;
}

const EXCERPT_LINE = 300;
const EXCERPT_MAX = 8_000;
