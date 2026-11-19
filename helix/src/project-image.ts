// A project's own image (docs/adr/0011): its `.animus/Dockerfile`, on its
// base branch as GitHub has it, built on top of the job image. The build is
// given the Dockerfile alone, on stdin with no context, and the job image as
// ANIMUS_JOB, so those two are its only inputs and their hash is its name: a
// release that leaves the job image as it was rebuilds nothing.
import { spawnSync } from 'node:child_process';
import { createHash } from 'node:crypto';
import { AnimusError, failureExcerpt } from '../../plugin/src/proc.ts';
import { docker as realDocker, type Docker } from './container.ts';
import { cloneBase, freshBase } from './fresh.ts';

export const DOCKERFILE = '.animus/Dockerfile';
/** The repository every project image is a tag of. */
export const PROJECT_IMAGE = 'animus-project';
const BUILD_MS = 30 * 60 * 1000;

/** The Dockerfile at a commit of the base branch as fetched (origin/<base>, or the commit freshBase gives), never a job's branch; undefined when it has none. */
export function readDockerfile(clone: string, commit: string): string | undefined {
  // Not tryGit: its output is trimmed, and the name hashes the text as committed.
  const r = spawnSync('git', ['show', `${commit}:${DOCKERFILE}`], { cwd: clone, encoding: 'utf8' });
  return r.status === 0 ? r.stdout : undefined;
}

/** The Dockerfile a project's jobs build from now, without fetching: its base branch as the machine's clone last fetched it, before its last job (jobImageOf). */
export const currentDockerfile = (clone: string): string | undefined => readDockerfile(clone, `origin/${cloneBase(clone)}`);

export function projectImageName(dockerfile: string, jobImageId: string): string {
  return `${PROJECT_IMAGE}:${createHash('sha256').update(dockerfile).update('\0').update(jobImageId).digest('hex').slice(0, 16)}`;
}

/** Whether the Dockerfile starts from the job image: ARG ANIMUS_JOB, then FROM $ANIMUS_JOB, comments and blank lines aside. */
function startsFromJobImage(dockerfile: string): boolean {
  const [arg, from] = dockerfile.split('\n').map((l) => l.trim()).filter((l) => l && !l.startsWith('#'));
  return /^ARG\s+ANIMUS_JOB$/i.test(arg ?? '') && /^FROM\s+(\$ANIMUS_JOB|\$\{ANIMUS_JOB\})(\s+AS\s+\S+)?$/i.test(from ?? '');
}

/** A project image to build: this command, the Dockerfile on its stdin, stopped after timeout ms. */
export type ImageBuild = { command: string; args: string[]; input: string; timeout: number };

/** A Dockerfile that is refused or does not build: what a change to the Dockerfile can fix, unlike a machine with no Docker or no job image. */
export class ImageFailed extends AnimusError {}

/** Why a build failed, with the end of its output. */
export const didNotBuild = (output: string): string => `the project image did not build from ${DOCKERFILE}:\n${failureExcerpt(output, 30)}`;

/**
 * The image a project's jobs run in: the job image when it has no
 * Dockerfile, else its project image, with the build to run first when
 * Docker does not have it. Throws why when the Dockerfile is refused or the
 * job image is not there.
 */
export function planProjectImage(opts: { dockerfile: string | undefined; jobImage: string; docker?: Docker }): { image: string; build?: ImageBuild } {
  const { dockerfile, jobImage } = opts;
  if (dockerfile === undefined) return { image: jobImage };
  if (!startsFromJobImage(dockerfile)) throw new ImageFailed(`${DOCKERFILE} must start with ARG ANIMUS_JOB then FROM $ANIMUS_JOB, so the project image is built on the job image Helix gives it`);
  const run = opts.docker ?? realDocker;
  const inspect = (image: string) => run(['image', 'inspect', '--format', '{{.Id}}', image]);
  const job = inspect(jobImage);
  if (!job) throw new AnimusError('docker is not installed or not on PATH');
  if (job.status !== 0) throw new AnimusError(`there is no image ${jobImage}: build it with helix image`);
  const image = projectImageName(dockerfile, job.stdout.trim());
  if (inspect(image)?.status === 0) return { image };
  // No context, no secrets: the Dockerfile and the job image are all it is given.
  return { image, build: { command: 'docker', args: ['build', '--tag', image, '--build-arg', `ANIMUS_JOB=${jobImage}`, '-'], input: dockerfile, timeout: BUILD_MS } };
}

/**
 * The image a project's jobs run in, built here when Docker does not have
 * it: what the add check runs in. Says what it does, the build's output
 * included. Throws why when the Dockerfile is refused or does not build.
 */
export function projectImage(opts: { dockerfile: string | undefined; jobImage: string; say: (line: string) => void; base?: string; docker?: Docker }): string {
  const { dockerfile, jobImage, say } = opts;
  const { image, build } = planProjectImage(opts);
  if (dockerfile === undefined) say(`no ${DOCKERFILE} on ${opts.base ?? 'the base branch'}: jobs run in the job image ${jobImage}`);
  else if (!build) say(`the project image ${image} from ${DOCKERFILE} is built already`);
  if (!build) return image;
  say(`building the project image ${image} from ${DOCKERFILE}, on ${jobImage}`);
  const r = (opts.docker ?? realDocker)(build.args, { input: build.input, timeout: build.timeout });
  const output = `${r?.stdout ?? ''}${r?.stderr ?? ''}`.trimEnd();
  // shortcut: the build's output is said once it ends, not as it goes; stream it if people watch long builds.
  for (const line of output.split('\n').filter(Boolean)) say(`  ${line}`);
  if (r?.status !== 0) throw new ImageFailed(didNotBuild(output));
  say(`built ${image}`);
  return image;
}

/** A job's image, for the supervisor: from its project's Dockerfile on the base branch as GitHub has it now, fetched with the job's credentials. */
export const jobImageOf = (opts: { jobImage: string; docker?: Docker }) => (repoDir: string, env: Record<string, string>) =>
  planProjectImage({ ...opts, dockerfile: readDockerfile(repoDir, freshBase(repoDir, env)) });
