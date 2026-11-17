// helix cleanup: what Helix's jobs leave on the machine goes once nobody
// needs it, the way `animus cleanup` does it on a laptop. `helix serve` runs
// it once a day. Each person's Animus home gets `animus cleanup`, run as an
// animus process with that person's credentials (their pull requests and
// branches are theirs), and the job images of other releases go. Every
// job's record stays for analysis: Helix's own folder of it (its spec and
// log.txt), and the person's job folders and transcripts.
import { spawnSync } from 'node:child_process';
import { existsSync } from 'node:fs';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { credentialEnv, personEnv } from './config.ts';
import { imageName, personDirs } from './container.ts';
import type { Store } from './store.ts';

const CLI = join(dirname(fileURLToPath(import.meta.url)), '..', '..', 'plugin', 'src', 'cli.ts');

/** How often `helix serve` cleans up, and how long after it starts it first does. */
export const CLEANUP_EVERY_MS = 24 * 60 * 60 * 1000;
export const CLEANUP_FIRST_MS = 10 * 60 * 1000;

/** Runs docker; undefined when it is not there. Replaced in tests. */
export type Docker = (args: string[]) => { status: number | null; stdout: string } | undefined;

const docker: Docker = (args) => {
  const r = spawnSync('docker', args, { encoding: 'utf8' });
  return r.error ? undefined : { status: r.status, stdout: r.stdout ?? '' };
};

export type CleanupOptions = { home: string; contained: boolean; days: number; dryRun: boolean; docker?: Docker };

/** Each `animus cleanup` to run: one per person's Animus home with containers, else the machine's own once. */
export type AnimusCleanup = { who: string; env?: Record<string, string>; why?: string };

export function animusCleanups(store: Store, opts: Pick<CleanupOptions, 'home' | 'contained'>): AnimusCleanup[] {
  if (!opts.contained) return [{ who: 'this machine' }];
  return Object.entries(store.people()).flatMap(([name, person]): AnimusCleanup[] => {
    const dirs = personDirs(opts.home, name);
    if (!existsSync(join(dirs.animus, 'jobs'))) return [];
    try {
      const theirs = personEnv(person);
      return [{ who: name, env: { ...theirs, ...credentialEnv(theirs), ANIMUS_HOME: dirs.animus, CLAUDE_CONFIG_DIR: dirs.claude } }];
    } catch (err) {
      return [{ who: name, why: (err as Error).message }];
    }
  });
}

/** The job images of other releases, from the tags `docker image ls` gives. */
export function staleImages(tags: readonly string[], version: string): string[] {
  return tags.filter((t) => t && t !== '<none>' && t !== version).map((t) => imageName(t));
}

/** Runs every part of the cleanup; says what it did, a line at a time. */
export function helixCleanup(store: Store, opts: CleanupOptions & { version: string }, say: (line: string) => void): boolean {
  let ok = true;
  const would = opts.dryRun ? 'would remove' : 'removed';
  for (const run of animusCleanups(store, opts)) {
    if (run.why) { say(`${run.who}: animus cleanup did not run: ${run.why}`); ok = false; continue; }
    const r = spawnSync(process.execPath, ['--disable-warning=ExperimentalWarning', CLI, 'cleanup', '--days', String(opts.days), ...(opts.dryRun ? ['--dry-run'] : [])], {
      encoding: 'utf8', env: { ...process.env, ...run.env }, timeout: 30 * 60 * 1000,
    });
    const out = `${r.stdout ?? ''}${r.stderr ?? ''}`.trimEnd();
    if (r.status !== 0) ok = false;
    say(`${run.who}: animus cleanup${r.status === 0 ? '' : ` failed (${r.error?.message ?? `exit ${r.status}`})`}`);
    for (const line of out.split('\n').filter(Boolean)) say(`  ${line}`);
  }
  const run = opts.docker ?? docker;
  const ls = run(['image', 'ls', imageName('').replace(/:$/, ''), '--format', '{{.Tag}}']);
  if (ls?.status === 0) {
    for (const image of staleImages(ls.stdout.split('\n'), opts.version)) {
      // An image a container still runs is refused by Docker, and tried again next time.
      if (opts.dryRun || run(['image', 'rm', image])?.status === 0) say(`${would} ${image}`);
      else say(`${image} could not be removed; it may still be in use`);
    }
  }
  return ok;
}
