// A project's own image (docs/adr/0011): its `.animus/Dockerfile`, on its
// base branch as GitHub has it, built on top of the job image. The build is
// given the Dockerfile alone, on stdin with no context, and the job image as
// ANIMUS_JOB, so those two are its only inputs and their hash is its name: a
// release that leaves the job image as it was rebuilds nothing.
import { spawnSync } from 'node:child_process';
import { createHash } from 'node:crypto';
import { AnimusError, failureExcerpt } from '../../plugin/src/proc.ts';
import { docker as realDocker, type Docker } from './container.ts';

export const DOCKERFILE = '.animus/Dockerfile';
/** The repository every project image is a tag of. */
export const PROJECT_IMAGE = 'animus-project';
const BUILD_MS = 30 * 60 * 1000;

/** The Dockerfile on the base branch as last fetched (origin/<base>), never a job's branch; undefined when it has none. */
export function readDockerfile(clone: string, base: string): string | undefined {
  // Not tryGit: its output is trimmed, and the name hashes the text as committed.
  const r = spawnSync('git', ['show', `origin/${base}:${DOCKERFILE}`], { cwd: clone, encoding: 'utf8' });
  return r.status === 0 ? r.stdout : undefined;
}

export function projectImageName(dockerfile: string, jobImageId: string): string {
  return `${PROJECT_IMAGE}:${createHash('sha256').update(dockerfile).update('\0').update(jobImageId).digest('hex').slice(0, 16)}`;
}

/** Whether the Dockerfile starts from the job image: ARG ANIMUS_JOB, then FROM $ANIMUS_JOB, comments and blank lines aside. */
function startsFromJobImage(dockerfile: string): boolean {
  const [arg, from] = dockerfile.split('\n').map((l) => l.trim()).filter((l) => l && !l.startsWith('#'));
  return /^ARG\s+ANIMUS_JOB$/i.test(arg ?? '') && /^FROM\s+(\$ANIMUS_JOB|\$\{ANIMUS_JOB\})(\s+AS\s+\S+)?$/i.test(from ?? '');
}

/**
 * The image a project's jobs run in: the job image when it has no
 * Dockerfile, else its project image, built here when Docker does not have
 * it. Says what it does, the build's output included. Throws why when the
 * Dockerfile is refused or does not build.
 */
export function projectImage(opts: { dockerfile: string | undefined; jobImage: string; say: (line: string) => void; base?: string; docker?: Docker }): string {
  const { dockerfile, jobImage, say } = opts;
  const run = opts.docker ?? realDocker;
  if (dockerfile === undefined) {
    say(`no ${DOCKERFILE} on ${opts.base ?? 'the base branch'}: jobs run in the job image ${jobImage}`);
    return jobImage;
  }
  if (!startsFromJobImage(dockerfile)) throw new AnimusError(`${DOCKERFILE} must start with ARG ANIMUS_JOB then FROM $ANIMUS_JOB, so the project image is built on the job image Helix gives it`);
  const inspect = (image: string) => run(['image', 'inspect', '--format', '{{.Id}}', image]);
  const job = inspect(jobImage);
  if (!job) throw new AnimusError('docker is not installed or not on PATH');
  if (job.status !== 0) throw new AnimusError(`there is no image ${jobImage}: build it with helix image`);
  const image = projectImageName(dockerfile, job.stdout.trim());
  if (inspect(image)?.status === 0) {
    say(`the project image ${image} from ${DOCKERFILE} is built already`);
    return image;
  }
  say(`building the project image ${image} from ${DOCKERFILE}, on ${jobImage}`);
  // No context, no secrets: the Dockerfile and the job image are all it is given.
  const r = run(['build', '--tag', image, '--build-arg', `ANIMUS_JOB=${jobImage}`, '-'], { input: dockerfile, timeout: BUILD_MS });
  const output = `${r?.stdout ?? ''}${r?.stderr ?? ''}`.trimEnd();
  // shortcut: the build's output is said once it ends, not as it goes; stream it if people watch long builds.
  for (const line of output.split('\n').filter(Boolean)) say(`  ${line}`);
  if (r?.status !== 0) throw new AnimusError(`the project image did not build from ${DOCKERFILE}:\n${failureExcerpt(output, 30)}`);
  say(`built ${image}`);
  return image;
}
