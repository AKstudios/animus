import assert from 'node:assert/strict';
import { execFileSync } from 'node:child_process';
import { existsSync, mkdirSync, mkdtempSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { test } from 'node:test';
import { addProposals, lessonsFile, readLessons } from '../../plugin/src/lessons.ts';
import { saveProgress } from '../../plugin/src/log.ts';
import { containerLaunch, dockerArgs, draftLaunch, originOf, personDirs } from '../src/container.ts';
import { openStore } from '../src/store.ts';
import { cancelJobsOf, supervise } from '../src/supervisor.ts';
import type { HelixJob } from '../src/store.ts';

function repoWithOrigin(url: string): string {
  const dir = mkdtempSync(join(tmpdir(), 'helix-mirror-'));
  execFileSync('git', ['init', '-q', dir]);
  execFileSync('git', ['remote', 'add', 'origin', url], { cwd: dir });
  return dir;
}

const job = (over: Partial<HelixJob> = {}): HelixJob => ({ id: 7, state: 'queued', person: 'ana', repo: 'app', spec: '/h/jobs/7/spec.md', title: 't', draft: false, submitted: '', ...over });

test('a job\'s container gets its person\'s folders at the same paths, Animus read-only, credentials by name only, limits, and no socket or port', () => inHelixHome(() => {
  const home = mkdtempSync(join(tmpdir(), 'helix-'));
  const launch = containerLaunch({ home, animusRoot: '/srv/animus', image: 'animus-job:0.3.0', limits: { memory: '4g', cpus: 3 }, uid: 1001, gid: 1001 });
  const mirror = repoWithOrigin('https://github.com/o/app.git');
  const started = launch(job(), mirror, { GH_TOKEN: 'ghp_secret', CLAUDE_CODE_OAUTH_TOKEN: 'sk-secret', ANIMUS_USER: 'ana' });
  const ana = personDirs(home, 'ana');
  const args = started.args.join(' ');

  assert.equal(started.command, 'docker');
  assert.deepEqual(started.env, { ANIMUS_HOME: ana.animus, CLAUDE_CONFIG_DIR: ana.claude });
  assert.ok(!args.includes('secret'), 'no credential value on the command line');
  for (const name of ['GH_TOKEN', 'CLAUDE_CODE_OAUTH_TOKEN', 'ANIMUS_USER', 'ANIMUS_HOME', 'CLAUDE_CONFIG_DIR']) assert.ok(args.includes(`-e ${name}`), name);
  assert.ok(args.includes(`-v ${ana.root}:${ana.root} `));
  assert.ok(args.includes('-v /srv/animus:/srv/animus:ro'));
  assert.ok(args.includes('-v /h/jobs/7:/h/jobs/7:ro'));
  assert.ok(args.includes('--memory 4g --cpus 3') && args.includes('--user 1001:1001') && args.includes('--cap-drop ALL') && args.includes('--name helix-job-7'));
  assert.ok(!args.includes('docker.sock') && !/ -p | --publish/.test(args) && !args.includes(home.concat('/people/ben')));
  // The person's own clone, made from GitHub with their token on their first job, then animus on it.
  const tail = started.args.slice(started.args.indexOf('animus-job:0.3.0') + 1);
  assert.deepEqual(tail.slice(4, 6), [join(ana.repos, 'app'), 'https://github.com/o/app.git']);
  assert.deepEqual(tail.slice(-4), ['run', '/h/jobs/7/spec.md', '--repo', join(ana.repos, 'app')]);
  assert.ok(existsSync(ana.claude) && existsSync(ana.animus));

  const resumed = launch(job({ animus_job: 'app-1', answer: 'yes' }), mirror, {});
  assert.deepEqual(resumed.args.slice(-4), ['resume', 'app-1', '--answer', 'yes']);
}));

// Protects: a token renewed during a contained job reaching it. Fails when: the person's live token folder is not mounted, is writable, or is the file itself (a rename that replaces it would not show through), or a job without one gets a mount anyway.
test('a job signed in with the GitHub App gets its person\'s live token folder read-only, and no other job does', () => {
  const home = mkdtempSync(join(tmpdir(), 'helix-'));
  const launch = containerLaunch({ home, animusRoot: '/srv/animus', image: 'animus-job:0.4.3', limits: {}, uid: 1001, gid: 1001 });
  const mirror = repoWithOrigin('https://github.com/o/app.git');

  const signedIn = launch(job(), mirror, { ANIMUS_GH_TOKEN_FILE: '/h/tokens/ana/gh-token' }).args.join(' ');
  const pasted = launch(job(), mirror, { GH_TOKEN: 'ghp_x' }).args.join(' ');

  assert.ok(signedIn.includes('-v /h/tokens/ana:/h/tokens/ana:ro'), signedIn);
  assert.ok(signedIn.includes('-e ANIMUS_GH_TOKEN_FILE'));
  assert.ok(!pasted.includes('/tokens/'));
});

// Protects: criterion 2's "no GitHub token" in the draft's container. Fails when: a GitHub token, its folder or any other of the person's variables reaches a draft container, the mirror is writable, or the session is not animus draft on a clone at the base commit.
test('a draft\'s container gets Claude\'s sign-in and the draft folder, the mirror read-only, and no GitHub token', () => {
  const home = mkdtempSync(join(tmpdir(), 'helix-'));
  const ana = personDirs(home, 'ana');
  const folder = join(ana.animus, 'drafts', 'd1');
  const env = { CLAUDE_CODE_OAUTH_TOKEN: 'sk-secret', ANIMUS_GH_TOKEN_FILE: '/h/tokens/ana/gh-token', GH_TOKEN: 'ghp_secret', GITHUB_TOKEN: 'ghp_secret', GIT_CONFIG_COUNT: '2', ANIMUS_USER: 'ana' };

  const started = draftLaunch({ home, animusRoot: '/srv/animus', image: 'animus-job:0.5.0', limits: {}, uid: 1001, gid: 1001 })({ id: 'd1', person: 'ana', folder, mirror: '/h/repos/app', base: 'abc123' }, env);
  const args = started.args.join(' ');

  assert.equal(started.command, 'docker');
  assert.deepEqual(started.env, { CLAUDE_CONFIG_DIR: ana.claude });
  assert.ok(!args.includes('secret'), 'no credential value on the command line');
  for (const name of ['CLAUDE_CODE_OAUTH_TOKEN', 'CLAUDE_CONFIG_DIR', 'ANIMUS_USER']) assert.ok(args.includes(`-e ${name}`), name);
  for (const name of ['ANIMUS_GH_TOKEN_FILE', 'GH_TOKEN', 'GITHUB_TOKEN', 'GIT_CONFIG_COUNT']) assert.ok(!args.includes(`-e ${name}`), name);
  assert.ok(!args.includes('/tokens/') && !args.includes(`-v ${ana.root}:`), args);
  for (const mount of ['/srv/animus:/srv/animus:ro', '/h/repos/app:/h/repos/app:ro', `${ana.claude}:${ana.claude} `, `${folder}:${folder} `]) assert.ok(args.includes(`-v ${mount}`), mount);
  assert.ok(args.includes('--name helix-draft-d1'));
  const tail = started.args.slice(started.args.indexOf('animus-job:0.5.0') + 1);
  assert.deepEqual(tail.slice(4, 7), ['/h/repos/app', '/tmp/app', 'abc123']);
  assert.deepEqual(tail.slice(-4), ['draft', folder, '--repo', '/tmp/app']);
});

test('a clone made with a person\'s token needs an https origin', () => {
  assert.throws(() => originOf(repoWithOrigin('git@github.com:o/app.git')), /needs an https address/);
  assert.equal(dockerArgs({ job: { id: 1 }, image: 'i', limits: {}, uid: 1, gid: 1, animusRoot: '/a', person: personDirs('/h', 'p'), specDir: '/s', envNames: [], command: ['x'] }).includes('6g'), true);
});

test('cancelling a person\'s jobs ends their containers, and a contained job\'s progress is read from its person\'s Animus home', () => {
  const home = mkdtempSync(join(tmpdir(), 'helix-'));
  const store = openStore(join(home, 'helix.db'));
  const queued = store.add({ state: 'queued', person: 'ana', repo: 'app', spec: '', title: 't', draft: false, submitted: '' });
  const reaped: number[] = [];
  cancelJobsOf(store, 'ana', (id) => reaped.push(id));
  assert.deepEqual(reaped, [queued.id]);

  const ana = personDirs(home, 'ana').animus;
  const before = process.env.ANIMUS_HOME;
  process.env.ANIMUS_HOME = ana;
  saveProgress('app-1', 'gates', 'implementer');
  if (before === undefined) delete process.env.ANIMUS_HOME; else process.env.ANIMUS_HOME = before;
  writeFileSync(join(home, 'paused'), '');
  const supervisor = supervise({ store, config: { host: '', port: 0, slots: 1 }, home, animusHomeOf: (p) => personDirs(home, p).animus });
  assert.equal(supervisor.progress(job({ animus_job: 'app-1' }))?.stage, 'gates');
  assert.equal(supervisor.progress(job({ animus_job: 'app-1', person: 'ben' })), undefined);
  supervisor.stop();
  store.close();
});

const lesson = { text: 'Close the servers your tests start.', scope: 'project' as const, project: 'app', agent: 'implementer' as const, cites: ['a', 'b'] };

/** Runs `fn` with Helix's own Animus home set to a new folder. */
async function inHelixHome(fn: (animusHome: string) => unknown): Promise<void> {
  const before = process.env.ANIMUS_HOME;
  process.env.ANIMUS_HOME = mkdtempSync(join(tmpdir(), 'helix-animus-'));
  try { await fn(process.env.ANIMUS_HOME); } finally { if (before === undefined) delete process.env.ANIMUS_HOME; else process.env.ANIMUS_HOME = before; }
}

// Protects: criterion 3 on a Helix with containers. Fails when: a container job is not given Helix's lessons.json read-only, or is pointed at a file that is not there (Docker would make a folder of it).
test('a job\'s container gets Helix\'s lessons.json read-only, once there is one', () => inHelixHome(() => {
  const home = mkdtempSync(join(tmpdir(), 'helix-'));
  const launch = containerLaunch({ home, animusRoot: '/srv/animus', image: 'animus-job:0.3.0', limits: {}, uid: 1001, gid: 1001 });
  const mirror = repoWithOrigin('https://github.com/o/app.git');

  const without = launch(job(), mirror, {});
  addProposals([lesson], Date.now());
  const withLessons = launch(job(), mirror, {});

  assert.ok(!without.args.join(' ').includes('lessons.json') && !('ANIMUS_LESSONS_FILE' in (without.env ?? {})));
  assert.equal(withLessons.env?.ANIMUS_LESSONS_FILE, lessonsFile());
  assert.ok(withLessons.args.join(' ').includes(`-v ${lessonsFile()}:${lessonsFile()}:ro`));
  assert.ok(withLessons.args.join(' ').includes('-e ANIMUS_LESSONS_FILE'));
}));

// Protects: criterion 3's use count on a Helix with containers. Fails when: a container job's lessons are never counted (it cannot write the read-only file), or a job that wrote no run line counts an earlier run's.
test('Helix counts a use for each lesson on the run line a contained job wrote in its person\'s home', async () => inHelixHome(async () => {
  const home = mkdtempSync(join(tmpdir(), 'helix-'));
  const ana = personDirs(home, 'ana').animus;
  mkdirSync(ana, { recursive: true });
  const [first] = addProposals([lesson, { ...lesson, text: 'Name the check.' }], Date.now());
  const writes = (lessons: number[]) => `require('fs').appendFileSync(${JSON.stringify(join(ana, 'runs.jsonl'))}, JSON.stringify({ job: 'app-1', repo: '/work/app', ended: new Date().toISOString(), lessons: ${JSON.stringify(lessons)} }) + '\\n');`;
  let script = writes([first!.id]);
  const store = openStore(join(home, 'helix.db'));
  store.putPerson('ana', { token_sha256: 'x' });
  mkdirSync(join(home, 'repo'));
  store.putProject({ name: 'app', url: 'https://github.com/o/app.git', dir: join(home, 'repo'), state: 'ready', added: '' });
  const supervisor = supervise({ store, config: { host: '', port: 0, slots: 1 }, home, animusHomeOf: (p) => personDirs(home, p).animus, launch: () => ({ command: process.execPath, args: ['-e', `console.error('job app-1: x'); ${script} console.log('{"outcome":"pr"}')`] }) });
  const ended = async (id: number) => { for (let i = 0; i < 500 && store.get(id)!.state !== 'ended'; i++) await new Promise((r) => { setTimeout(r, 20); }); };

  const one = store.add({ state: 'queued', person: 'ana', repo: 'app', spec: '', title: 't', draft: false, submitted: '' });
  supervisor.wake();
  await ended(one.id);
  assert.deepEqual(readLessons().map((l) => l.uses), [1, 0]);

  // The next run writes no line: the earlier one is not counted again.
  script = '';
  const two = store.add({ state: 'queued', person: 'ana', repo: 'app', spec: '', title: 't', draft: false, submitted: '' });
  supervisor.wake();
  await ended(two.id);
  assert.deepEqual(readLessons().map((l) => l.uses), [1, 0]);

  // A job may write anything to its person's home: a run line that is not a run, or a broken lessons file, must not stop Helix.
  script = `require('fs').appendFileSync(${JSON.stringify(join(ana, 'runs.jsonl'))}, 'null\\n');`;
  const three = store.add({ state: 'queued', person: 'ana', repo: 'app', spec: '', title: 't', draft: false, submitted: '' });
  supervisor.wake();
  await ended(three.id);
  script = writes([first!.id]);
  writeFileSync(lessonsFile(), '{ not json');
  const four = store.add({ state: 'queued', person: 'ana', repo: 'app', spec: '', title: 't', draft: false, submitted: '' });
  supervisor.wake();
  await ended(four.id);
  script = '';
  const five = store.add({ state: 'queued', person: 'ana', repo: 'app', spec: '', title: 't', draft: false, submitted: '' });
  supervisor.wake();
  await ended(five.id);
  assert.equal(store.get(five.id)!.state, 'ended');
  supervisor.stop();
  store.close();
}));
