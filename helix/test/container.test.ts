import assert from 'node:assert/strict';
import { execFileSync } from 'node:child_process';
import { existsSync, mkdtempSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { test } from 'node:test';
import { saveProgress } from '../../plugin/src/log.ts';
import { containerLaunch, dockerArgs, originOf, personDirs } from '../src/container.ts';
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

test('a job\'s container gets its person\'s folders at the same paths, Animus read-only, credentials by name only, limits, and no socket or port', () => {
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
  const supervisor = supervise({ store, config: { host: '', port: 0, slots: 1, repos: {}, people: {} }, home, animusHomeOf: (p) => personDirs(home, p).animus });
  assert.equal(supervisor.progress(job({ animus_job: 'app-1' }))?.stage, 'gates');
  assert.equal(supervisor.progress(job({ animus_job: 'app-1', person: 'ben' })), undefined);
  supervisor.stop();
  store.close();
});
