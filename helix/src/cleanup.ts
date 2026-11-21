// helix cleanup: what Helix's jobs leave on the machine goes once nobody
// needs it, the way `animus cleanup` does it on a laptop. `helix serve` runs
// it once a day. Each person's Animus home gets `animus cleanup`, run as an
// animus process with that person's credentials (their pull requests and
// branches are theirs), then `animus outcomes` as them, so a merged pull
// request gets its outcome a day later, and the job images of other releases go, with the
// project images no project's current Dockerfile and job image give. Every
// job's record stays for analysis: Helix's own folder of it (its spec and
// log.txt), and the person's job folders and transcripts.
import { spawnSync } from 'node:child_process';
import { existsSync } from 'node:fs';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { credentialEnv, personEnv } from './config.ts';
import { docker, imageName, personDirs, type Docker } from './container.ts';
import { currentDockerfile, PROJECT_IMAGE, projectImageName } from './project-image.ts';
import type { Store } from './store.ts';

const CLI = join(dirname(fileURLToPath(import.meta.url)), '..', '..', 'plugin', 'src', 'cli.ts');

/** How often `helix serve` cleans up, and how long after it starts it first does. */
export const CLEANUP_EVERY_MS = 24 * 60 * 60 * 1000;
export const CLEANUP_FIRST_MS = 10 * 60 * 1000;

type Outcomes = (env?: Record<string, string>) => { status: number | null; stdout?: string; stderr?: string; error?: Error };

export type CleanupOptions = { home: string; contained: boolean; days: number; dryRun: boolean; docker?: Docker; fresh?: (person: string) => Promise<unknown>; outcomes?: Outcomes };

const animusOutcomes: Outcomes = (env) => spawnSync(process.execPath, ['--disable-warning=ExperimentalWarning', CLI, 'outcomes'], {
  encoding: 'utf8', env: { ...process.env, ...env }, timeout: 10 * 60 * 1000,
});

/** Each `animus cleanup` to run: one per person's Animus home with containers, else the machine's own once. */
export type AnimusCleanup = { who: string; env?: Record<string, string>; why?: string };

export async function animusCleanups(store: Store, opts: Pick<CleanupOptions, 'home' | 'contained' | 'fresh'>): Promise<AnimusCleanup[]> {
  if (!opts.contained) return [{ who: 'this machine' }];
  const runs: AnimusCleanup[] = [];
  for (const [name, person] of Object.entries(store.people())) {
    const dirs = personDirs(opts.home, name);
    if (!existsSync(join(dirs.animus, 'jobs'))) continue;
    try {
      // A sign-in through the GitHub App is refreshed first: animus cleanup reads each PR's state with it.
      await opts.fresh?.(name);
      const theirs = personEnv(person);
      runs.push({ who: name, env: { ...theirs, ...credentialEnv(theirs), ANIMUS_HOME: dirs.animus, CLAUDE_CONFIG_DIR: dirs.claude } });
    } catch (err) {
      runs.push({ who: name, why: (err as Error).message });
    }
  }
  return runs;
}

/** The job images of other releases, from the tags `docker image ls` gives. */
export function staleImages(tags: readonly string[], version: string): string[] {
  return tags.filter((t) => t && t !== '<none>' && t !== version).map((t) => imageName(t));
}

/** Runs every part of the cleanup; says what it did, a line at a time. */
export async function helixCleanup(store: Store, opts: CleanupOptions & { version: string }, say: (line: string) => void): Promise<boolean> {
  let ok = true;
  const would = opts.dryRun ? 'would remove' : 'removed';
  for (const run of await animusCleanups(store, opts)) {
    if (run.why) { say(`${run.who}: animus cleanup did not run: ${run.why}`); ok = false; continue; }
    const r = spawnSync(process.execPath, ['--disable-warning=ExperimentalWarning', CLI, 'cleanup', '--days', String(opts.days), ...(opts.dryRun ? ['--dry-run'] : [])], {
      encoding: 'utf8', env: { ...process.env, ...run.env }, timeout: 30 * 60 * 1000,
    });
    const out = `${r.stdout ?? ''}${r.stderr ?? ''}`.trimEnd();
    if (r.status !== 0) ok = false;
    say(`${run.who}: animus cleanup${r.status === 0 ? '' : ` failed (${r.error?.message ?? `exit ${r.status}`})`}`);
    for (const line of out.split('\n').filter(Boolean)) say(`  ${line}`);
    // Their merged pull requests get an outcome a day later. Not reaching GitHub is said and skipped: it must not stop the others.
    if (opts.dryRun) continue;
    const o = (opts.outcomes ?? animusOutcomes)(run.env);
    if (o.status !== 0) say(`${run.who}: animus outcomes failed (${o.error?.message ?? `exit ${o.status}`}); skipped`);
    for (const line of `${o.stdout ?? ''}${o.stderr ?? ''}`.trimEnd().split('\n').filter(Boolean)) if (o.status !== 0) say(`  ${line}`);
  }
  const run = opts.docker ?? docker;
  const tags = (repository: string) => {
    const ls = run(['image', 'ls', repository, '--format', '{{.Tag}}']);
    return ls?.status === 0 ? ls.stdout.split('\n').filter((t) => t && t !== '<none>') : [];
  };
  const jobImage = run(['image', 'inspect', '--format', '{{.Id}}', imageName(opts.version)]);
  const current = new Set(jobImage?.status === 0 ? store.projects().flatMap((p) => {
    const dockerfile = currentDockerfile(p.dir);
    return dockerfile === undefined ? [] : [projectImageName(dockerfile, jobImage.stdout.trim())];
  }) : []);
  const stale = [
    ...staleImages(tags(imageName('').replace(/:$/, '')), opts.version),
    ...tags(PROJECT_IMAGE).map((t) => `${PROJECT_IMAGE}:${t}`).filter((image) => !current.has(image)),
  ];
  for (const image of stale) {
    // An image a container still runs is refused by Docker, and tried again next time.
    if (opts.dryRun || run(['image', 'rm', image])?.status === 0) say(`${would} ${image}`);
    else say(`${image} could not be removed; it may still be in use`);
  }
  return ok;
}
