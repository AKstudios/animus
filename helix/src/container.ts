// A Helix job in a container of its own (docs/factory.md, "Isolation per
// job"). The container gets the submitter's credentials and folders only:
// their clone of the repository, their Animus state and their Claude config,
// each mounted at the same path it has on the machine, so the state files'
// paths mean the same thing inside and out and Helix's display can read them.
// Animus's checkout is mounted read-only. Nothing else of the machine's is
// there: no other person's credentials file, no Docker socket, no published
// port. The container is removed when the job ends.
import { spawnSync } from 'node:child_process';
import { existsSync, mkdirSync, readdirSync } from 'node:fs';
import { basename, dirname, join } from 'node:path';
import { GIVEN_FILE, lessonsFile } from '../../plugin/src/lessons.ts';
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

/** The Animus home of everyone who has had a folder here, those who left included: where their jobs wrote their records. */
export const personHomes = (home: string): string[] => existsSync(join(home, 'people')) ? readdirSync(join(home, 'people')).map((p) => personDirs(home, p).animus) : [];

export const containerName =(id: number) => `helix-job-${id}`;
export const imageName = (version: string) => `animus-job:${version}`;

/** Runs docker, with input on its stdin; undefined when it is not there. Replaced in tests. */
export type Docker = (args: string[], opts?: { input?: string; timeout?: number }) => { status: number | null; stdout: string; stderr?: string } | undefined;

export const docker: Docker = (args, opts = {}) => {
  const r = spawnSync('docker', args, { encoding: 'utf8', maxBuffer: 64 * 1024 * 1024, ...opts });
  if ((r.error as NodeJS.ErrnoException | undefined)?.code === 'ENOENT') return undefined;
  return { status: r.status, stdout: r.stdout ?? '', stderr: `${r.stderr ?? ''}${r.error ? `\n${r.error.message}` : ''}` };
};

export type Mount = { path: string; readOnly?: boolean };

/**
 * A `docker run` of the job image under Helix's limits: the account's uid, no
 * capabilities, no new privileges, folders mounted at the same paths they
 * have on the machine, and nothing else of the machine's. Credentials are
 * passed by name only (`-e NAME`): Docker reads their values from its own
 * environment, so they never appear in a process list.
 */
export function runArgs(opts: {
  name: string; image: string; limits: ContainerConfig; uid: number; gid: number;
  mounts: Mount[]; envNames: string[]; workdir: string; command: string[];
}): string[] {
  const { limits } = opts;
  return [
    'run', '--rm', '--name', opts.name, '--init',
    '--user', `${opts.uid}:${opts.gid}`,
    '--memory', limits.memory ?? '6g', '--cpus', String(limits.cpus ?? 2), '--pids-limit', '4096',
    '--security-opt', 'no-new-privileges', '--cap-drop', 'ALL',
    ...opts.mounts.flatMap((m) => ['-v', `${m.path}:${m.path}${m.readOnly ? ':ro' : ''}`]),
    // Package downloads are checked against the lockfile's hashes, so one cache serves everyone.
    '-v', 'helix-npm-cache:/home/animus/.npm',
    ...opts.envNames.flatMap((n) => ['-e', n]),
    '-w', opts.workdir,
    opts.image, ...opts.command,
  ];
}

/** The `docker run` for one job: Animus read-only, the person's folder, and the job's spec read-only. */
export function dockerArgs(opts: {
  job: Pick<HelixJob, 'id'>; image: string; limits: ContainerConfig; uid: number; gid: number;
  animusRoot: string; person: ReturnType<typeof personDirs>; specDir: string; envNames: string[]; command: string[];
  /** The person's live token folder (github-app.ts liveTokenDir), read-only, when they signed in with the GitHub App. */
  tokens?: string;
  /** Helix's lessons.json, read-only: the lessons the job's agents are given (lessons.ts GIVEN_FILE). */
  lessons?: string;
}): string[] {
  return runArgs({
    name: containerName(opts.job.id), image: opts.image, limits: opts.limits, uid: opts.uid, gid: opts.gid,
    mounts: [{ path: opts.animusRoot, readOnly: true }, { path: opts.person.root }, { path: opts.specDir, readOnly: true }, ...(opts.tokens ? [{ path: opts.tokens, readOnly: true }] : []), ...(opts.lessons ? [{ path: opts.lessons, readOnly: true }] : [])],
    envNames: opts.envNames, workdir: opts.person.root, command: opts.command,
  });
}

/**
 * What runs inside: the person's clone is made on their first job for that
 * repository, from its GitHub address with their own token, its base branch
 * is fetched as GitHub has it now (`helix fresh-base`, helix/src/fresh.ts),
 * then `animus`. A fetch that fails ends the job here, with the reason.
 */
export function jobCommand(opts: { node: string; cli: string; fresh: string; clone: string; origin: string; animus: string[] }): string[] {
  const script = 'test -d "$1/.git" || git clone --quiet "$2" "$1" || exit 1; "$4" --disable-warning=ExperimentalWarning "$3" fresh-base "$1" || exit 1; shift 3; exec "$@"';
  return ['sh', '-c', script, 'sh', opts.clone, opts.origin, opts.fresh, opts.node, '--disable-warning=ExperimentalWarning', opts.cli, ...opts.animus];
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

/** What a draft session may know of its person: their Claude sign-in and who they are. Never a GitHub token. */
const DRAFT_ENV = ['ANTHROPIC_API_KEY', 'CLAUDE_CODE_OAUTH_TOKEN', 'ANIMUS_USER'];

/**
 * Starts `animus draft` for one draft (plugin/src/draft.ts) in a container of
 * its own. It reads the repository from a clone of the machine's mirror,
 * mounted read-only and checked out at the base commit (the caller resolves
 * it, so the container needs no network but Claude's), and writes only the
 * draft's folder and the person's Claude config. Its references were fetched
 * before it started, by Helix, with the tokens that stay out here.
 */
export function draftLaunch(opts: { home: string; animusRoot: string; image: string; limits: ContainerConfig; uid: number; gid: number }) {
  return (draft: { id: string; person: string; folder: string; mirror: string; base: string }, env: Record<string, string>) => {
    const person = personDirs(opts.home, draft.person);
    makePersonDirs(person);
    const clone = join('/tmp', basename(draft.mirror));
    const extra = { CLAUDE_CONFIG_DIR: person.claude };
    const script = 'git clone --quiet --shared --no-checkout "$1" "$2" && git -C "$2" checkout --quiet --detach "$3" || exit 1; shift 3; exec "$@"';
    const command = ['sh', '-c', script, 'sh', draft.mirror, clone, draft.base, 'node', '--disable-warning=ExperimentalWarning', join(opts.animusRoot, 'plugin', 'src', 'cli.ts'), 'draft', draft.folder, '--repo', clone];
    const args = runArgs({
      name: `helix-draft-${draft.id}`, image: opts.image, limits: opts.limits, uid: opts.uid, gid: opts.gid,
      mounts: [{ path: opts.animusRoot, readOnly: true }, { path: draft.mirror, readOnly: true }, { path: person.claude }, { path: draft.folder }],
      envNames: [...Object.keys(env).filter((n) => DRAFT_ENV.includes(n)), ...Object.keys(extra)].sort(), workdir: draft.folder, command,
    });
    return { command: 'docker', args, env: extra, cwd: opts.home };
  };
}

/**
 * Starts each job as `docker run` of the job image. Only what the job runs
 * with goes in, by name; the machine's own environment stays outside.
 */
export function containerLaunch(opts: { home: string; animusRoot: string; image: string; limits: ContainerConfig; uid: number; gid: number }): Launch {
  return (job, repoDir, env, image = opts.image) => {
    const person = personDirs(opts.home, job.person);
    makePersonDirs(person);
    const clone = join(person.repos, job.repo);
    // Only when there are lessons: Docker would make a folder of a file that is not there.
    const lessons = existsSync(lessonsFile()) ? lessonsFile() : undefined;
    const extra = { ANIMUS_HOME: person.animus, CLAUDE_CONFIG_DIR: person.claude, ...(lessons ? { [GIVEN_FILE]: lessons } : {}) };
    const command = jobCommand({
      node: 'node', cli: join(opts.animusRoot, 'plugin', 'src', 'cli.ts'), fresh: join(opts.animusRoot, 'helix', 'src', 'cli.ts'), clone,
      origin: job.animus_job ? '' : originOf(repoDir), animus: animusArgs(job, clone),
    });
    const envNames = [...new Set([...Object.keys(env), ...Object.keys(extra)])].sort();
    const tokens = env.ANIMUS_GH_TOKEN_FILE ? dirname(env.ANIMUS_GH_TOKEN_FILE) : undefined;
    const args = dockerArgs({ job, image, limits: opts.limits, uid: opts.uid, gid: opts.gid, animusRoot: opts.animusRoot, person, specDir: dirname(job.spec), envNames, command, ...(tokens ? { tokens } : {}), ...(lessons ? { lessons } : {}) });
    return { command: 'docker', args, env: extra, cwd: opts.home };
  };
}
