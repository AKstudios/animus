// A Helix job in a container of its own (docs/factory.md, "Isolation per
// job"). The container gets the submitter's credentials and folders only:
// their clone of the repository, their Animus state and their Claude config,
// each mounted at the same path it has on the machine, so the state files'
// paths mean the same thing inside and out and Helix's display can read them.
// Animus's checkout is mounted read-only. Nothing else of the machine's is
// there: no other person's credentials file, no Docker socket, no published
// port. The container is removed when the job ends.
import { spawnSync } from 'node:child_process';
import { mkdirSync } from 'node:fs';
import { dirname, join } from 'node:path';
import { AnimusError } from '../../plugin/src/proc.ts';
import type { Config } from './config.ts';
import type { HelixJob } from './store.ts';
import { animusArgs, type Launch } from './supervisor.ts';

export type ContainerConfig = NonNullable<Config['container']>;

/** What is a person's own on the machine, under Helix's home: mounted into their jobs and nobody else's. */
export function personDirs(home: string, person: string) {
  const root = join(home, 'people', person);
  return { root, animus: join(root, 'animus'), claude: join(root, 'claude'), repos: join(root, 'repos') };
}

export const containerName = (id: number) => `helix-job-${id}`;
export const imageName = (version: string) => `animus-job:${version}`;

/**
 * The `docker run` for one job. Credentials are passed by name only (`-e
 * NAME`): Docker reads their values from its own environment, so they never
 * appear in a process list.
 */
export function dockerArgs(opts: {
  job: Pick<HelixJob, 'id'>; image: string; limits: ContainerConfig; uid: number; gid: number;
  animusRoot: string; person: ReturnType<typeof personDirs>; specDir: string; envNames: string[]; command: string[];
}): string[] {
  const { limits, person } = opts;
  return [
    'run', '--rm', '--name', containerName(opts.job.id), '--init',
    '--user', `${opts.uid}:${opts.gid}`,
    '--memory', limits.memory ?? '6g', '--cpus', String(limits.cpus ?? 2), '--pids-limit', '4096',
    '--security-opt', 'no-new-privileges', '--cap-drop', 'ALL',
    '-v', `${opts.animusRoot}:${opts.animusRoot}:ro`,
    '-v', `${person.root}:${person.root}`,
    '-v', `${opts.specDir}:${opts.specDir}:ro`,
    // Package downloads are checked against the lockfile's hashes, so one cache serves everyone.
    '-v', 'helix-npm-cache:/home/animus/.npm',
    ...opts.envNames.flatMap((n) => ['-e', n]),
    '-w', person.root,
    opts.image, ...opts.command,
  ];
}

/**
 * What runs inside: the person's clone is made on their first job for that
 * repository, from its GitHub address with their own token, then `animus`.
 */
export function jobCommand(opts: { node: string; cli: string; clone: string; origin: string; animus: string[] }): string[] {
  const script = 'test -d "$1/.git" || git clone --quiet "$2" "$1" || exit 1; shift 2; exec "$@"';
  return ['sh', '-c', script, 'sh', opts.clone, opts.origin, opts.node, '--disable-warning=ExperimentalWarning', opts.cli, ...opts.animus];
}

export function makePersonDirs(dirs: ReturnType<typeof personDirs>): void {
  for (const d of [dirs.animus, dirs.claude, dirs.repos]) mkdirSync(d, { recursive: true, mode: 0o700 });
}

/** The address the machine's clone fetches from, which each person's clone is made from. */
export function originOf(repoDir: string): string {
  const r = spawnSync('git', ['remote', 'get-url', 'origin'], { cwd: repoDir, encoding: 'utf8' });
  const url = r.stdout?.trim();
  if (r.status !== 0 || !url) throw new AnimusError(`${repoDir} has no origin to clone from`);
  if (!url.startsWith('https://')) throw new AnimusError(`${repoDir}'s origin is ${url}: a job clones with its person's token, which needs an https address`);
  return url;
}

/** Ends a job's container, if there is one. Safe to call for one that is gone. */
export function removeContainer(id: number): void {
  spawnSync('docker', ['rm', '--force', containerName(id)], { stdio: 'ignore' });
}

/** Whether Docker answers and the image is there; why not, if not. */
export function containerProblem(image: string): string | undefined {
  const info = spawnSync('docker', ['image', 'inspect', '--format', '{{.Id}}', image], { encoding: 'utf8' });
  if (info.error) return 'docker is not installed or not on PATH';
  if (info.status === 0) return undefined;
  const why = `${info.stderr ?? ''}`.trim();
  if (/permission denied/i.test(why)) return `this account may not use Docker (${why.split('\n')[0]}): add it to the docker group`;
  return `there is no image ${image}: build it with helix image`;
}

/**
 * Starts each job as `docker run` of the job image. Only what the job runs
 * with goes in, by name; the machine's own environment stays outside.
 */
export function containerLaunch(opts: { home: string; animusRoot: string; image: string; limits: ContainerConfig; uid: number; gid: number }): Launch {
  return (job, repoDir, env) => {
    const person = personDirs(opts.home, job.person);
    makePersonDirs(person);
    const clone = join(person.repos, job.repo);
    const extra = { ANIMUS_HOME: person.animus, CLAUDE_CONFIG_DIR: person.claude };
    const command = jobCommand({
      node: 'node', cli: join(opts.animusRoot, 'plugin', 'src', 'cli.ts'), clone,
      origin: job.animus_job ? '' : originOf(repoDir), animus: animusArgs(job, clone),
    });
    const envNames = [...new Set([...Object.keys(env), ...Object.keys(extra)])].sort();
    const args = dockerArgs({ job, image: opts.image, limits: opts.limits, uid: opts.uid, gid: opts.gid, animusRoot: opts.animusRoot, person, specDir: dirname(job.spec), envNames, command });
    return { command: 'docker', args, env: extra, cwd: opts.home };
  };
}
