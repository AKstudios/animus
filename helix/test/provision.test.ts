import assert from 'node:assert/strict';
import { execFileSync } from 'node:child_process';
import { mkdtempSync, readFileSync, writeFileSync } from 'node:fs';
import type { AddressInfo } from 'node:net';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { test } from 'node:test';
import { parseSpec } from '../../plugin/src/spec.ts';
import * as client from '../../plugin/src/remote.ts';
import { makeRepo, write } from '../../plugin/test/helpers.ts';
import { hashToken, type Config } from '../src/config.ts';
import { checkProject, projectDir, type SetupRun } from '../src/projects.ts';
import { ImageFailed } from '../src/project-image.ts';
import { serve } from '../src/server.ts';
import { openStore } from '../src/store.ts';
import { pauseFile, supervise } from '../src/supervisor.ts';

const git = (cwd: string, ...args: string[]) => execFileSync('git', args, { cwd, encoding: 'utf8' }).trim();
const PROFILE = 'commands:\n  test: "true"\nsetup: "true"\n';

/** A Helix home with ana (whose GitHub token is in her env file) and a project of hers to check, cloned from a bare repository. */
function toCheck(profile = PROFILE) {
  const home = mkdtempSync(join(tmpdir(), 'helix-provision-'));
  const source = makeRepo();
  write(source, '.animus/animus.yaml', profile);
  git(source, 'add', '-A');
  git(source, 'commit', '-qm', 'profile');
  const bare = join(home, 'origin.git');
  git(home, 'clone', '-q', '--bare', source, bare);
  writeFileSync(join(home, 'ana.env'), 'GH_TOKEN=github_pat_ana\n');
  const store = openStore(join(home, 'helix.db'));
  store.putPerson('ana', { token_sha256: hashToken('ana-token'), env_file: join(home, 'ana.env') });
  store.putPerson('ben', { token_sha256: hashToken('ben-token') });
  const add = (url = bare) => store.putProject({ name: 'app', url, dir: projectDir(home, 'app'), state: 'checking', added: new Date().toISOString(), added_by: 'ana' });
  add();
  const said: string[] = [];
  const check = (over: { setup?: SetupRun; image?: () => string; runner?: Parameters<typeof checkProject>[0]['runner'] } = {}) =>
    checkProject({ store, home, name: 'app', say: (l) => said.push(l), setup: over.setup ?? (() => ({ code: 0, output: '', gates: [] })), ...(over.image ? { image: over.image } : {}), ...(over.runner ? { runner: over.runner } : {}) });
  return { home, store, said, check, add, bare };
}

const provisions = (store: ReturnType<typeof openStore>) => store.list().filter((j) => j.provision);
const gateFailed = { code: 0, output: '', gates: [{ name: 'test', command: 'npm test', ok: false, output: 'curl: not found' }] } as unknown as ReturnType<SetupRun>;

// Protects: a failure a Dockerfile or profile can fix gets a provision job for the adder, named in the add's output. Fails when: one of the three kinds queues none, queues it for someone else, or the output does not name it.
test('an add check that fails in the image build, setup or a gate queues a provision job for the adder and names it', () => {
  const kinds: [string, Parameters<ReturnType<typeof toCheck>['check']>[0], RegExp][] = [
    ['image', { image: () => { throw new ImageFailed('the project image did not build from .animus/Dockerfile:\nE: unable to locate package curl'); } }, /unable to locate package curl/],
    ['setup', { setup: () => ({ code: 1, output: 'npm: command not found' }) }, /npm: command not found/],
    ['gate', { setup: () => gateFailed }, /curl: not found/],
  ];
  for (const [kind, over, why] of kinds) {
    const c = toCheck();
    assert.equal(c.check(over), false, kind);
    const [job] = provisions(c.store);
    assert.ok(job, `${kind} queues a provision job`);
    assert.deepEqual([job.state, job.person, job.repo, provisions(c.store).length], ['queued', 'ana', 'app', 1], kind);
    assert.match(readFileSync(job.spec, 'utf8'), why, `${kind}: the spec holds the check's output`);
    assert.equal(parseSpec(readFileSync(job.spec, 'utf8'), 'provision.md').title, "Fix app's environment so its add check passes");
    assert.ok(c.said.includes(`queued provision job ${job.id} for ana to fix its environment`), c.said.join('\n'));
    assert.equal(c.store.project('app')!.state, 'failed');
    c.store.close();
  }
});

// Protects: only what the environment can fix is provisioned. Fails when: a failed clone, a push refused, a missing or invalid profile, or a missing secret starts a job nobody can make pass.
test('a failed clone, a token that may not push, a missing or invalid profile, or a missing secret starts no provision job', () => {
  const cases: [string, (c: ReturnType<typeof toCheck>) => boolean][] = [
    ['clone', (c) => { c.add(join(c.home, 'nothing.git')); return c.check(); }],
    ['push', (c) => c.check({ runner: (_cmd, args) => (args[0] === 'push' ? { code: 1, stdout: '', stderr: 'denied' } : { code: 0, stdout: `${c.bare}\n`, stderr: '' }) })],
    ['no profile', (c) => { c.add(c.bare); const empty = makeRepo(); git(empty, 'rm', '-q', '.animus/animus.yaml'); git(empty, 'commit', '-qm', 'none'); git(c.home, 'clone', '-q', '--bare', empty, join(c.home, 'empty.git')); c.add(join(c.home, 'empty.git')); return c.check(); }],
    ['invalid profile', (c) => { const bad = makeRepo(); write(bad, '.animus/animus.yaml', 'commands: [not, a, mapping]\n'); git(bad, 'add', '-A'); git(bad, 'commit', '-qm', 'bad'); git(c.home, 'clone', '-q', '--bare', bad, join(c.home, 'bad.git')); c.add(join(c.home, 'bad.git')); return c.check(); }],
    ['secret', (c) => c.check()],
  ];
  for (const [kind, run] of cases) {
    const c = toCheck(kind === 'secret' ? `${PROFILE}secrets: [NPM_TOKEN]\n` : PROFILE);
    assert.equal(run(c), false, `${kind}: ${c.said.join('\n')}`);
    assert.equal(c.store.project('app')!.state, 'failed', kind);
    assert.deepEqual(provisions(c.store), [], kind);
    c.store.close();
  }
});

// Protects: at most one provision job or open provision pull request per project. Fails when: adding again queues a second job, or the add's output does not name what exists.
test('adding a project again while a provision job is queued or running, or its pull request is open, runs only the check and names it', () => {
  const c = toCheck();
  c.check({ setup: () => gateFailed });
  const [first] = provisions(c.store);
  const again = (state: 'queued' | 'running' | 'ended', extra = {}) => {
    c.store.save({ ...first!, state, ...extra });
    c.add();
    c.said.length = 0;
    assert.equal(c.check({ setup: () => gateFailed }), false);
    assert.equal(provisions(c.store).length, 1, `${state}: no second job`);
    assert.equal(c.store.project('app')!.state, 'failed', `${state}: the check still ran and settled the project`);
    return c.said.join('\n');
  };
  assert.match(again('queued'), new RegExp(`provision job ${first!.id} is queued: no second one is queued`));
  assert.match(again('running'), new RegExp(`provision job ${first!.id} is running: no second one`));
  assert.match(again('ended', { outcome: 'pr', pr: 'https://github.com/acme/app/pull/3' }), new RegExp(`provision job ${first!.id} has an open pull request, https://github.com/acme/app/pull/3: no second one`));

  // One that ended without a pull request is over: the next failed add may queue another.
  c.store.save({ ...first!, state: 'ended', outcome: 'failed', reason: 'gave up' });
  c.add();
  c.check({ setup: () => gateFailed });
  assert.equal(provisions(c.store).length, 2);
  c.store.close();
});

test('animus project list and the project\'s view name the provision job', async (t) => {
  const c = toCheck();
  c.check({ setup: () => gateFailed });
  const [job] = provisions(c.store);
  const config: Config = { host: '127.0.0.1', port: 0, slots: 1 };
  // Paused, so the queue leaves the job as queued: running it is the provision loop's.
  writeFileSync(pauseFile(c.home), '');
  const supervisor = supervise({ store: c.store, config, home: c.home, launch: () => ({ command: process.execPath, args: ['-e', ''] }) });
  const server = serve({ config, store: c.store, supervisor, home: c.home, startCheck: () => {} });
  await new Promise<void>((r) => { server.listen(0, '127.0.0.1', r); });
  t.after(() => { supervisor.stop(); server.close(); c.store.close(); });
  process.env.HELIX_URL = `http://127.0.0.1:${(server.address() as AddressInfo).port}`;
  process.env.HELIX_TOKEN = 'ana-token';

  const { projects } = await client.projects();
  assert.deepEqual(projects[0]!.provision, { job: job!.id, state: 'queued' });
  assert.match(client.describeProjects(projects), new RegExp(`^app +failed .* added by ana +provision job ${job!.id} is queued: its gates fail`));
  assert.deepEqual((await client.project('app')).provision, { job: job!.id, state: 'queued' });
});
