// A clone's base branch as GitHub has it (docs/adr/0008). A clone made on a
// person's first job is never brought up to date by anything else, so a profile
// fixed on GitHub would not be what the next job reads. This fetches the base
// branch with the person's credentials in env and moves the clone's checked-out
// base branch forward to it; other branches and uncommitted work stay as they are.
import { spawnSync } from 'node:child_process';
import { existsSync, readFileSync } from 'node:fs';
import { join } from 'node:path';
import { AnimusError } from '../../plugin/src/proc.ts';
import { parseProfile, PROFILE_PATH } from '../../plugin/src/profile.ts';

const FETCH_MS = 120_000;

export const git = (dir: string, args: string[], env: Record<string, string>) => {
  const r = spawnSync('git', args, { cwd: dir, encoding: 'utf8', timeout: FETCH_MS, env: { ...process.env, ...env, GIT_TERMINAL_PROMPT: '0' } });
  const text = `${r.stderr ?? ''}${r.stdout ?? ''}`.trim();
  return { ok: r.status === 0, out: r.stdout?.trim() ?? '', why: text.split('\n').pop() || r.error?.message || 'git did not answer' };
};

/** The base a profile's text names, `main` when it names none; nothing when there is no text or it cannot be read. */
const baseOf = (text: string | undefined): string | undefined => {
  if (text === undefined) return undefined;
  try { return parseProfile(text).base; } catch { return undefined; }
};

/**
 * Fetches the project's base branch and returns the commit GitHub has it at.
 * The base is the profile's `base` as GitHub has it: the clone's profile says
 * which branch to fetch, and the fetched one is read again in case it names
 * another. Throws why when the fetch fails.
 */
export function freshBase(dir: string, env: Record<string, string> = {}): string {
  const file = join(dir, PROFILE_PATH);
  let base = baseOf(existsSync(file) ? readFileSync(file, 'utf8') : undefined) ?? 'main';
  // shortcut: a profile that names a base that names another is followed twice, then the third is taken as it is.
  for (let tries = 0; ; tries++) {
    const got = git(dir, ['fetch', '--quiet', 'origin', `+refs/heads/${base}:refs/remotes/origin/${base}`], env);
    if (!got.ok) throw new AnimusError(`could not fetch ${base} from GitHub: ${got.why}`);
    const shown = git(dir, ['show', `origin/${base}:${PROFILE_PATH}`], env);
    const next = baseOf(shown.ok ? shown.out : undefined);
    if (next === undefined || next === base || tries >= 2) break;
    base = next;
  }
  if (git(dir, ['symbolic-ref', '--quiet', '--short', 'HEAD'], env).out === base) {
    const moved = git(dir, ['merge', '--ff-only', '--quiet', `origin/${base}`], env);
    if (!moved.ok) throw new AnimusError(`${dir}'s ${base} cannot be brought up to date with GitHub's: ${moved.why}`);
  }
  return git(dir, ['rev-parse', `origin/${base}`], env).out;
}
