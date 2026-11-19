import assert from 'node:assert/strict';
import { execFileSync } from 'node:child_process';
import { mkdtempSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { test } from 'node:test';
import { makeRepo, write } from '../../plugin/test/helpers.ts';
import type { Docker } from '../src/container.ts';
import { projectImage, projectImageName } from '../src/project-image.ts';
import { checkProject, projectDir } from '../src/projects.ts';
import { openStore } from '../src/store.ts';

const git = (cwd: string, ...args: string[]) => execFileSync('git', args, { cwd, encoding: 'utf8' }).trim();
const JOB = 'animus-job:0.7.0';
const DOCKERFILE = '# Go for the API\nARG ANIMUS_JOB\nFROM $ANIMUS_JOB\nUSER root\nRUN apt-get install -y golang\n';

/** A Docker that has the job image (ID sha256:job1) and the images in built, and records each command with what it read. */
function fakeDocker(built: Set<string>, buildOutput = { status: 0, stderr: '#1 RUN apt-get install -y golang\n#1 DONE' }) {
  const calls: { args: string[]; input?: string }[] = [];
  const docker: Docker = (args, opts) => {
    calls.push({ args, ...(opts?.input !== undefined ? { input: opts.input } : {}) });
    if (args[0] === 'image' && args[1] === 'inspect') {
      const image = args.at(-1)!;
      if (image === JOB) return { status: 0, stdout: 'sha256:job1\n' };
      return built.has(image) ? { status: 0, stdout: 'sha256:project\n' } : { status: 1, stdout: '', stderr: `No such image: ${image}` };
    }
    if (args[0] === 'build') {
      if (buildOutput.status === 0) built.add(args[args.indexOf('--tag') + 1]!);
      return { status: buildOutput.status, stdout: '', stderr: buildOutput.stderr };
    }
    return { status: 1, stdout: '' };
  };
  return { docker, calls };
}

// Protects: the image is named by the Dockerfile and the job image's ID only. Fails when: a release that keeps the job image rebuilds, or a changed one does not.
test('a project image is named by its Dockerfile and the job image\'s ID', () => {
  const name = projectImageName(DOCKERFILE, 'sha256:job1');
  assert.match(name, /^animus-project:[0-9a-f]{16}$/);
  assert.equal(projectImageName(DOCKERFILE, 'sha256:job1'), name);
  assert.notEqual(projectImageName(DOCKERFILE, 'sha256:job2'), name);
  assert.notEqual(projectImageName(`${DOCKERFILE}RUN true\n`, 'sha256:job1'), name);
});

// Protects: the build is given the Dockerfile only, on the job image. Fails when: a build context, a secret or the wrong base goes in, or a built image is built again.
test('the project image is built on the job image from the Dockerfile alone, once', () => {
  const built = new Set<string>();
  const { docker, calls } = fakeDocker(built);
  const said: string[] = [];
  const image = projectImage({ dockerfile: DOCKERFILE, jobImage: JOB, say: (l) => said.push(l), docker });
  assert.equal(image, projectImageName(DOCKERFILE, 'sha256:job1'));
  const build = calls.find((c) => c.args[0] === 'build')!;
  assert.deepEqual(build, { args: ['build', '--tag', image, '--build-arg', `ANIMUS_JOB=${JOB}`, '-'], input: DOCKERFILE });
  assert.ok(said.some((l) => l.includes(`building the project image ${image} from .animus/Dockerfile`)), said.join('\n'));
  assert.ok(said.some((l) => l.includes('RUN apt-get install -y golang')), 'the build\'s output is in the check\'s');

  calls.length = 0;
  assert.equal(projectImage({ dockerfile: DOCKERFILE, jobImage: JOB, say: () => {}, docker }), image);
  assert.ok(!calls.some((c) => c.args[0] === 'build'), 'an image that is there is not built again');
});

// Protects: only a Dockerfile on the job image is taken. Fails when: a project could run its jobs on any image it likes.
test('a Dockerfile that does not start from ANIMUS_JOB is refused, with why', () => {
  const { docker, calls } = fakeDocker(new Set());
  for (const dockerfile of ['FROM ubuntu:24.04\nRUN true\n', 'ARG ANIMUS_JOB\nFROM ubuntu:24.04\n', 'FROM $ANIMUS_JOB\n']) {
    assert.throws(() => projectImage({ dockerfile, jobImage: JOB, say: () => {}, docker }), /\.animus\/Dockerfile must start with ARG ANIMUS_JOB then FROM \$ANIMUS_JOB/, dockerfile);
  }
  assert.ok(!calls.some((c) => c.args[0] === 'build'));
});

// Protects: a build that fails says why. Fails when: the add fails with no hint of the failing line.
test('a build that fails throws the end of its output', () => {
  const { docker } = fakeDocker(new Set(), { status: 1, stderr: '#5 RUN apt-get install -y golang-9\nE: Unable to locate package golang-9' });
  assert.throws(() => projectImage({ dockerfile: DOCKERFILE, jobImage: JOB, say: () => {}, docker }), /did not build[\s\S]*Unable to locate package golang-9/);
});

/** A project to check whose base branch may have a Dockerfile, as toCheck in projects.test.ts makes one. */
function toCheck(dockerfile?: string) {
  const home = mkdtempSync(join(tmpdir(), 'helix-project-image-'));
  const source = makeRepo();
  write(source, '.animus/animus.yaml', 'commands:\n  test: "true"\n');
  if (dockerfile) write(source, '.animus/Dockerfile', dockerfile);
  git(source, 'add', '-A');
  git(source, 'commit', '-qm', 'profile');
  const bare = join(home, 'origin.git');
  git(home, 'clone', '-q', '--bare', source, bare);
  writeFileSync(join(home, 'ana.env'), 'GH_TOKEN=github_pat_ana\n');
  const store = openStore(join(home, 'helix.db'));
  store.putPerson('ana', { token_sha256: 'x', env_file: join(home, 'ana.env') });
  store.putProject({ name: 'app', url: bare, dir: projectDir(home, 'app'), state: 'checking', added: '2026-11-16T00:00:00.000Z', added_by: 'ana' });
  return { home, store };
}

// Protects: criterion 1 at the add check. Fails when: the check runs a project with a Dockerfile in the job image, or one without in anything else.
test('the add check builds the project image from the base branch\'s Dockerfile and runs in it; without one, in the job image', () => {
  for (const [dockerfile, says] of [[DOCKERFILE, /building the project image animus-project:/], [undefined, /no \.animus\/Dockerfile on main: jobs run in the job image animus-job:0\.7\.0/]] as const) {
    const c = toCheck(dockerfile);
    const { docker } = fakeDocker(new Set());
    const said: string[] = [];
    let ranIn = '';
    const ok = checkProject({
      store: c.store, home: c.home, name: 'app', say: (l) => said.push(l),
      image: (file, base) => projectImage({ dockerfile: file, base, jobImage: JOB, say: (l) => said.push(l), docker }),
      setup: (_w, _c, _e, image) => { ranIn = image ?? ''; return { code: 0, output: '', gates: [] }; },
    });
    assert.equal(ok, true, said.join('\n'));
    assert.equal(ranIn, dockerfile ? projectImageName(DOCKERFILE, 'sha256:job1') : JOB);
    assert.ok(said.some((l) => says.test(l)), said.join('\n'));
    c.store.close();
  }
});

// Protects: a refused or broken Dockerfile fails the add. Fails when: the check goes on in the job image and takes the project.
test('the add check fails a project whose Dockerfile is refused', () => {
  const c = toCheck('FROM golang:1.23\n');
  let setupRan = false;
  const ok = checkProject({
    store: c.store, home: c.home, name: 'app', say: () => {},
    image: (file) => projectImage({ dockerfile: file, jobImage: JOB, say: () => {}, docker: fakeDocker(new Set()).docker }),
    setup: () => { setupRan = true; return { code: 0, output: '', gates: [] }; },
  });
  assert.equal(ok, false);
  assert.equal(setupRan, false);
  assert.match(c.store.project('app')!.reason!, /must start with ARG ANIMUS_JOB/);
  c.store.close();
});
