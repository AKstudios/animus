import assert from 'node:assert/strict';
import { execFileSync } from 'node:child_process';
import { existsSync, mkdirSync, mkdtempSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { test } from 'node:test';
import { makeRepo, write } from '../../plugin/test/helpers.ts';
import { animusCleanups, helixCleanup, staleImages } from '../src/cleanup.ts';
import { personDirs, type Docker } from '../src/container.ts';
import { projectImageName } from '../src/project-image.ts';
import { openStore, type HelixJob } from '../src/store.ts';

const git = (cwd: string, ...args: string[]) => execFileSync('git', args, { cwd, encoding: 'utf8' }).trim();
const OLD = 'ARG ANIMUS_JOB\nFROM $ANIMUS_JOB\nRUN apt-get install -y golang\n';
const NEW = `${OLD}RUN apt-get install -y libvips\n`;
const DAY = 24 * 60 * 60 * 1000;
const NOW = Date.parse('2026-11-30T00:00:00Z');
const ago = (days: number) => new Date(NOW - days * DAY).toISOString();

function helix() {
  const home = mkdtempSync(join(tmpdir(), 'helix-'));
  const store = openStore(join(home, 'helix.db'));
  const add = (over: Partial<HelixJob>) => {
    const job = store.add({ state: 'ended', person: 'ana', repo: 'app', spec: '', title: 't', draft: false, submitted: ago(30), ...over });
    mkdirSync(join(home, 'jobs', String(job.id)), { recursive: true });
    return job.id;
  };
  return { home, store, add };
}

test('Helix keeps every job\'s folder and removes only the job images of other releases', async () => {
  const { home, store, add } = helix();
  const ids = [add({ outcome: 'pr', ended: ago(200) }), add({ state: 'cancelled', ended: ago(200) })];
  const lines: string[] = [];
  const docker: string[][] = [];
  await helixCleanup(store, {
    home, contained: true, days: 30, dryRun: false, version: '0.3.4',
    docker: (args) => { docker.push(args); return { status: 0, stdout: args[2] === 'animus-job' ? '0.3.3\n0.3.4\n' : '' }; },
  }, (l) => lines.push(l));
  assert.deepEqual(docker.filter((a) => a[1] === 'rm'), [['image', 'rm', 'animus-job:0.3.3']]);
  assert.deepEqual(lines, ['removed animus-job:0.3.3']);
  for (const id of ids) assert.equal(existsSync(join(home, 'jobs', String(id))), true);
});

test('animus cleanup runs in each person\'s Animus home with their credentials, or once as the machine without containers', async () => {
  const { home, store } = helix();
  const envFile = join(home, 'ana.env');
  writeFileSync(envFile, 'GH_TOKEN=ghp_ana\nCLAUDE_CODE_OAUTH_TOKEN=sk-ana\n');
  store.putPerson('ana', { token_sha256: 'a', env_file: envFile });
  store.putPerson('bo', { token_sha256: 'b', env_file: join(home, 'gone.env') });
  store.putPerson('cy', { token_sha256: 'c' });
  for (const name of ['ana', 'bo']) mkdirSync(join(personDirs(home, name).animus, 'jobs'), { recursive: true });

  const runs = await animusCleanups(store, { home, contained: true });
  assert.deepEqual(runs.map((r) => r.who), ['ana', 'bo']);
  const ana = personDirs(home, 'ana');
  assert.equal(runs[0]!.env!.GH_TOKEN, 'ghp_ana');
  assert.equal(runs[0]!.env!.ANIMUS_HOME, ana.animus);
  assert.equal(runs[0]!.env!.CLAUDE_CONFIG_DIR, ana.claude);
  assert.ok(runs[0]!.env!.GIT_CONFIG_COUNT);
  assert.match(runs[1]!.why!, /credentials file .* is gone/);

  assert.deepEqual(await animusCleanups(store, { home, contained: false }), [{ who: 'this machine' }]);
});

/**
 * A Helix whose project app had OLD as its Dockerfile and has NEW on GitHub's
 * base branch now, fetched into the machine's clone, with a Docker whose job
 * image is ID sha256:job2 and which has app's images for both Dockerfiles,
 * and one for NEW on the job image before it changed.
 */
function withProjectImages() {
  const { home, store } = helix();
  const source = makeRepo();
  write(source, '.animus/Dockerfile', OLD);
  git(source, 'add', '-A');
  git(source, 'commit', '-qm', 'dockerfile');
  const bare = join(home, 'origin.git');
  git(home, 'clone', '-q', '--bare', source, bare);
  const clone = join(home, 'repos', 'app');
  git(home, 'clone', '-q', bare, clone);
  write(source, '.animus/Dockerfile', NEW);
  git(source, 'commit', '-qam', 'dockerfile');
  git(source, 'push', '-q', bare, 'HEAD:main');
  git(clone, 'fetch', '-q', 'origin', 'main');
  store.putProject({ name: 'app', url: bare, dir: clone, state: 'ready', added: '' });
  const images = [projectImageName(NEW, 'sha256:job2'), projectImageName(OLD, 'sha256:job2'), projectImageName(NEW, 'sha256:job1')];
  const calls: string[][] = [];
  const docker: Docker = (args) => {
    calls.push(args);
    if (args[1] === 'ls') return { status: 0, stdout: args[2] === 'animus-project' ? `${images.map((i) => i.split(':')[1]).join('\n')}\n<none>\n` : '0.3.4\n' };
    if (args[1] === 'inspect') return args.at(-1) === 'animus-job:0.3.4' ? { status: 0, stdout: 'sha256:job2\n' } : { status: 1, stdout: '' };
    return { status: 0, stdout: '' };
  };
  const cleanup = async (dryRun: boolean) => {
    const lines: string[] = [];
    await helixCleanup(store, { home, contained: true, days: 30, dryRun, version: '0.3.4', docker }, (l) => lines.push(l));
    return lines;
  };
  return { images, calls, cleanup };
}

// Protects: criterion 4. Fails when: cleanup keeps a project image after its Dockerfile or the job image changed, or removes the one jobs run in now.
test('cleanup removes the project images no project\'s current Dockerfile and job image give', async () => {
  const { images: [, oldDockerfile, oldJobImage], calls, cleanup } = withProjectImages();
  const lines = await cleanup(false);
  assert.deepEqual(calls.filter((a) => a[1] === 'rm'), [['image', 'rm', oldDockerfile], ['image', 'rm', oldJobImage]]);
  assert.deepEqual(lines, [`removed ${oldDockerfile}`, `removed ${oldJobImage}`]);
});

// Protects: --dry-run. Fails when: a dry run removes a project image.
test('a dry run says which project images it would remove and removes none', async () => {
  const { images: [, oldDockerfile, oldJobImage], calls, cleanup } = withProjectImages();
  assert.deepEqual(await cleanup(true), [`would remove ${oldDockerfile}`, `would remove ${oldJobImage}`]);
  assert.deepEqual(calls.filter((a) => a[1] === 'rm'), []);
});

test('only the job images of other releases are removed', () => {
  assert.deepEqual(staleImages(['0.3.3', '0.3.4', '<none>', '', '0.3.1'], '0.3.4'), ['animus-job:0.3.3', 'animus-job:0.3.1']);
});
