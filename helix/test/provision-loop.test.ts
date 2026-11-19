import assert from 'node:assert/strict';
import { execFileSync } from 'node:child_process';
import { existsSync, mkdtempSync, readFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { test } from 'node:test';
import { loadFactory } from '../../plugin/src/profiles.ts';
import { fakeAgent, makeRepo, write, type Step } from '../../plugin/test/helpers.ts';
import { hashToken } from '../src/config.ts';
import { ImageFailed } from '../src/project-image.ts';
import { projectDir, type SetupRun } from '../src/projects.ts';
import { queueProvision } from '../src/provision.ts';
import { runProvision } from '../src/provision-loop.ts';
import { setSecret } from '../src/secrets.ts';
import { openStore } from '../src/store.ts';
import { supervise } from '../src/supervisor.ts';

const git = (cwd: string, ...args: string[]) => execFileSync('git', args, { cwd, encoding: 'utf8' }).trim();
const DOCKERFILE = 'ARG ANIMUS_JOB\nFROM $ANIMUS_JOB\n';
const NO_CURL = { code: 0, output: '', gates: [{ name: 'test', command: 'curl --fail localhost', ok: false, skipped: false, ms: 5, output: 'curl: not found' }] } as ReturnType<SetupRun>;
const PASSES = { code: 0, output: '', gates: [{ name: 'test', command: 'curl --fail localhost', ok: true, skipped: false, ms: 5, output: '' }] } as ReturnType<SetupRun>;
/** The environment is right once the Dockerfile in the worktree installs curl. */
const needsCurl: SetupRun = (worktree) => (existsSync(join(worktree, '.animus/Dockerfile')) && readFileSync(join(worktree, '.animus/Dockerfile'), 'utf8').includes('curl') ? PASSES : NO_CURL);

/** A Helix home with a failed project cloned from a bare origin and the provision job its add check queued. */
function provisioning() {
  const home = mkdtempSync(join(tmpdir(), 'helix-provision-loop-'));
  const source = makeRepo();
  git(source, 'commit', '--allow-empty', '-qm', 'more');
  const bare = join(home, 'origin.git');
  git(home, 'clone', '-q', '--bare', source, bare);
  git(home, 'clone', '-q', bare, projectDir(home, 'app'));
  const store = openStore(join(home, 'helix.db'));
  store.putPerson('ana', { token_sha256: hashToken('ana-token') });
  const project = { name: 'app', url: bare, dir: projectDir(home, 'app'), state: 'failed' as const, added: new Date().toISOString(), added_by: 'ana' };
  store.putProject(project);
  const job = queueProvision({ store, home, project, why: 'its gates fail on main:\nFAIL test: curl --fail localhost' });
  const published: { branch: string; body: string }[] = [];
  const run = (steps: Step[], over: Partial<Parameters<typeof runProvision>[0]> = {}) => {
    const { agent, calls } = fakeAgent(steps);
    /** The image each session was given, in order. */
    const images: (string | undefined)[] = [];
    const result = runProvision({
      store, home, job, factory: loadFactory(), env: {}, session: (req, image) => { images.push(image); return agent(req); }, setup: needsCurl, say: () => {},
      publish: (p) => { published.push({ branch: p.branch, body: p.body }); return 'https://github.com/acme/app/pull/9'; }, ...over,
    });
    return { result, calls, images };
  };
  /** What the job's branch holds beyond the base: the files it changed. */
  const changedOnBranch = () => git(project.dir, 'diff', '--name-only', 'origin/main', `animus/provision-${job.id}`).split('\n').filter(Boolean);
  return { run, published, changedOnBranch, job, project, store, home };
}

const answer = (status: string, extra = {}) => ({ output: { status, summary: 'Installed curl.', ...extra } });

// Protects: an attempt is a session, then a build-and-check by Helix, and a pass ends in a pull request of the two files with the check's output. Fails when: the second session is not told how the first failed, the pull request holds more, or it has no check output.
test('a check that passes on the second attempt ends in a pull request of the Dockerfile and profile with the check output as proof', () => {
  const p = provisioning();
  const { result, calls } = p.run([
    (req) => { write(req.cwd, '.animus/Dockerfile', DOCKERFILE); return answer('changed'); },
    (req) => { write(req.cwd, '.animus/Dockerfile', `${DOCKERFILE}RUN apt-get install -y curl\n`); write(req.cwd, '.animus/animus.yaml', 'commands:\n  test: curl --fail localhost\nsetup: "true"\n'); return answer('changed'); },
  ]);
  assert.deepEqual([result.outcome, result.pr], ['pr', 'https://github.com/acme/app/pull/9']);
  assert.equal(calls.length, 2);
  assert.match(calls[1]!.prompt, /curl: not found/, 'the second session is given how the first attempt failed');
  assert.match(calls[1]!.prompt, /ARG ANIMUS_JOB/, 'and what it changed');
  assert.deepEqual(p.changedOnBranch(), ['.animus/Dockerfile', '.animus/animus.yaml']);
  assert.deepEqual(p.published.map((x) => x.branch), [`animus/provision-${p.job.id}`]);
  assert.match(p.published[0]!.body, /ok {3}test: curl --fail localhost/);
});

// Protects: only the two environment files may change. Fails when: a change to the project's code is kept, or such an attempt passes a check it only passed by editing the code.
test('an attempt that changes another file has its changes thrown away and counts as failed, and five attempts end the job failed with what each did', () => {
  const p = provisioning();
  const meddles: Step = (req) => { write(req.cwd, 'src/app.txt', 'edited\n'); write(req.cwd, '.animus/Dockerfile', `${DOCKERFILE}RUN apt-get install -y curl\n`); return answer('changed'); };
  const { result, calls } = p.run([meddles, meddles, meddles, meddles, meddles]);
  assert.equal(result.outcome, 'failed');
  assert.equal(calls.length, 5);
  assert.match(result.reason!, /after 5 attempts/);
  assert.match(result.reason!, /attempt 3 changed \.animus\/Dockerfile, src\/app\.txt \(discarded: src\/app\.txt\)/);
  assert.deepEqual(p.changedOnBranch(), [], 'nothing of a discarded attempt is kept, its Dockerfile too');
  assert.deepEqual(p.published, []);
});

// Protects: the job stops at two hours. Fails when: attempts go on past the limit.
test('two hours end the job failed, with how each attempt\'s check failed', () => {
  const p = provisioning();
  let clock = 0;
  const hour: Step = (req) => { clock += 60 * 60 * 1000; write(req.cwd, '.animus/Dockerfile', `${DOCKERFILE}# try ${clock}\n`); return answer('changed'); };
  const { result, calls } = p.run([hour, hour, hour], { now: () => clock });
  assert.equal(calls.length, 2);
  assert.equal(result.outcome, 'failed');
  assert.match(result.reason!, /the time it may take/);
  assert.match(result.reason!, /attempt 2 changed \.animus\/Dockerfile; its gates fail on animus\/provision-\d+/);
  assert.match(result.reason!, /curl: not found/);
});

// Protects: "not an environment problem" ends the job at once with the reason. Fails when: another attempt is made, or the reason is lost.
test('an agent that says it is not an environment problem ends the job failed with its reason and uses no further attempt', () => {
  const p = provisioning();
  const { result, calls } = p.run([
    (req) => { write(req.cwd, 'src/app.txt', 'ignored\n'); return answer('not-environment', { reason: 'the test fails on its own: it asserts 2 + 2 is 5' }); },
  ]);
  assert.equal(result.outcome, 'failed');
  assert.equal(calls.length, 1);
  assert.match(result.reason!, /not an environment problem: the test fails on its own: it asserts 2 \+ 2 is 5/);
  assert.deepEqual(p.changedOnBranch(), []);
  assert.deepEqual(p.published, []);
});

// Protects: Helix starts a queued provision job for a project that is still failed, through its own launch, and records the pull request. Fails when: the queue leaves the job unstarted because the project is not ready, or runs it as `animus run`.
test('Helix starts a provision job on a failed project with the provision launch and records its pull request', async (t) => {
  const p = provisioning();
  const result = JSON.stringify({ outcome: 'pr', pr: 'https://github.com/acme/app/pull/9', cost_usd: 0 });
  const supervisor = supervise({
    store: p.store, config: { host: '127.0.0.1', port: 0, slots: 1 }, home: p.home,
    launch: () => ({ command: process.execPath, args: ['-e', 'process.exit(3)'] }),
    provision: () => ({ command: process.execPath, args: ['-e', 'console.log(process.argv[1])', result] }),
  });
  t.after(() => { supervisor.stop(); p.store.close(); });
  supervisor.wake();
  let ended = p.store.get(p.job.id);
  for (let i = 0; i < 500 && ended?.state !== 'ended'; i++) {
    await new Promise((r) => { setTimeout(r, 20); });
    ended = p.store.get(p.job.id);
  }
  assert.deepEqual([ended?.state, ended?.outcome, ended?.pr], ['ended', 'pr', 'https://github.com/acme/app/pull/9']);
});

// Protects: a secret a gate prints never leaves the loop. Fails when: the failed check's output reaches the next session's prompt or the job's reason unmasked, as the add check's reason never does.
test('a secret value in a failed gate\'s output is masked in the next prompt and in the job\'s reason', () => {
  const p = provisioning();
  const secret = 'npm_secret_value_123';
  setSecret({ store: p.store, home: p.home, config: {} }, 'ana', 'app', { name: 'NPM_TOKEN', value: secret });
  const leaks: SetupRun = () => ({ code: 0, output: '', gates: [{ name: 'test', command: 'npm test', ok: false, skipped: false, ms: 5, output: `401 for ${secret}` }] }) as ReturnType<SetupRun>;
  const tries = (n: number): Step => (req) => { write(req.cwd, '.animus/animus.yaml', `commands:\n  test: npm test\nsecrets: [NPM_TOKEN]\n# try ${n}\n`); return answer('changed'); };
  const { result, calls } = p.run([tries(1), tries(2)], { setup: leaks, maxAttempts: 2 });
  assert.equal(result.outcome, 'failed');
  assert.match(calls[1]!.prompt, /401 for \*\*\*/);
  assert.match(result.reason!, /401 for \*\*\*/);
  assert.ok(!calls[1]!.prompt.includes(secret) && !result.reason!.includes(secret));
});

// Protects: each attempt is followed by a build of the image from the job's branch. Fails when: the Dockerfile is read from the base branch, a failed build is not an attempt that fails with its output given to the next session, or a session does not run in the image the last attempt built.
test('each attempt builds the image from the branch: a failed build fails the attempt, and the next session runs in the image last built', () => {
  const p = provisioning();
  const built: string[] = [];
  const image = (dockerfile: string | undefined) => {
    if (dockerfile === undefined) return 'animus-job:test';
    if (!dockerfile.includes('curl')) throw new ImageFailed('the project image did not build from .animus/Dockerfile:\nE: unable to locate package curl');
    built.push(dockerfile);
    return 'animus-project:curl';
  };
  const setupImages: (string | undefined)[] = [];
  // Passes once the image has curl and the profile says it is ready.
  const setup: SetupRun = (worktree, _clone, _env, using) => {
    setupImages.push(using);
    return existsSync(join(worktree, '.animus/animus.yaml')) && readFileSync(join(worktree, '.animus/animus.yaml'), 'utf8').includes('ready') ? PASSES : NO_CURL;
  };
  const { result, calls, images } = p.run([
    (req) => { write(req.cwd, '.animus/Dockerfile', DOCKERFILE); return answer('changed'); },
    (req) => { write(req.cwd, '.animus/Dockerfile', `${DOCKERFILE}RUN apt-get install -y curl\n`); return answer('changed'); },
    (req) => { write(req.cwd, '.animus/animus.yaml', 'commands:\n  test: curl --fail localhost\n# ready\n'); return answer('changed'); },
  ], { image, setup });
  assert.equal(result.outcome, 'pr');
  assert.equal(built.length, 2, 'the Dockerfile of the branch was built after attempts 2 and 3');
  assert.match(calls[1]!.prompt, /unable to locate package curl/, 'the second session is given the build\'s output');
  assert.deepEqual(images, ['animus-job:test', undefined, 'animus-project:curl']);
  assert.deepEqual(setupImages, ['animus-project:curl', 'animus-project:curl']);
});
