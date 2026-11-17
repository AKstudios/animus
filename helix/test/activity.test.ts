import assert from 'node:assert/strict';
import { execFileSync } from 'node:child_process';
import { mkdirSync, mkdtempSync } from 'node:fs';
import type { AddressInfo } from 'node:net';
import { tmpdir } from 'node:os';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { test } from 'node:test';
import * as client from '../../plugin/src/remote.ts';
import { hashToken, saveConfig, type Config } from '../src/config.ts';
import { invite, type Verify } from '../src/join.ts';
import { serve } from '../src/server.ts';
import { openStore, type Activity } from '../src/store.ts';
import { supervise, type Launch } from '../src/supervisor.ts';

const SPEC = (title: string) => `---\nsize: small\n---\n# ${title}\n\n## Acceptance criteria\n\n1. It works.\n`;

// "ask" asks until it is given an answer; "hold" never ends; "late" never ends and names its Animus job only after 400 ms.
const FAKE = `
const [title, answer] = process.argv.slice(1);
const says = () => console.error('job fake-' + title + ': ' + title);
// Like animus winding down on SIGTERM: what it had to say still comes out before it exits.
if (title.startsWith('late')) { setTimeout(says, 400); process.on('SIGTERM', () => { setTimeout(() => process.exit(0), 600); }); } else says();
if (title.startsWith('ask') && !answer) console.log(JSON.stringify({ outcome: 'needs-input', question: 'which?' }));
else if (title.startsWith('ask')) console.log(JSON.stringify({ outcome: 'needs-input', question: 'again?' }));
else setInterval(() => {}, 1000);
`;

async function until<T>(read: () => T, ok: (v: T) => boolean): Promise<T> {
  for (let i = 0; i < 500; i++) {
    const v = read();
    if (ok(v)) return v;
    await new Promise((r) => { setTimeout(r, 20); });
  }
  throw new Error('timed out waiting');
}

/** A Helix with ana, whose token the test uses; checking a project is left to the test. */
async function helix() {
  const home = mkdtempSync(join(tmpdir(), 'helix-activity-'));
  process.env.HELIX_HOME = home;
  process.env.ANIMUS_HOME = join(home, 'client');
  const repo = join(home, 'repo');
  mkdirSync(repo);
  const config: Config = { host: '127.0.0.1', port: 0, slots: 2 };
  saveConfig(config);
  const launch: Launch = (job) => ({ command: process.execPath, args: ['-e', FAKE, job.title, job.answer ?? ''] });
  const store = openStore(join(home, 'helix.db'));
  store.putPerson('ana', { token_sha256: hashToken('ana-token') });
  store.putProject({ name: 'app', url: 'https://github.com/o/app.git', dir: repo, state: 'ready', added: '' });
  const supervisor = supervise({ store, config, home, launch });
  const verify: Verify = async () => ({ findings: [], login: 'cleo-gh' });
  const server = serve({ config, store, supervisor, home, verify, startCheck: () => {} });
  await new Promise<void>((r) => { server.listen(0, '127.0.0.1', r); });
  process.env.HELIX_URL = `http://127.0.0.1:${(server.address() as AddressInfo).port}`;
  process.env.HELIX_TOKEN = 'ana-token';
  const stop = () => { supervisor.stop(); server.close(); store.close(); };
  // What the log says, as (who, kind, detail), oldest first.
  const log = (who?: string) => store.activity(who).reverse().map((a: Activity) => [a.who, a.kind, a.detail]);
  return { home, store, stop, log };
}

test('submitting, answering (each time), cancelling and project add and remove are each kept as activity, with who and when', async (t) => {
  const h = await helix();
  t.after(h.stop);
  const before = Date.now();

  const asking = await client.submit({ repo: 'app', spec: SPEC('ask'), name: 'spec.md' });
  await until(() => h.store.get(asking.id)!, (j) => j.outcome === 'needs-input');
  await client.answer(String(asking.id), 'the second');
  await until(() => h.store.get(asking.id)!, (j) => j.question === 'again?');
  await client.answer(String(asking.id), 'the third');
  const held = await client.submit({ repo: 'app', spec: SPEC('hold'), name: 'spec.md' });
  await client.cancel(String(held.id));
  await client.addProject({ name: 'site', url: 'https://github.com/o/site.git' });
  h.store.putProject({ ...h.store.project('site')!, state: 'ready' });
  await client.removeProject('site');

  assert.deepEqual(h.log('ana'), [
    ['ana', 'submitted', { job: asking.id, repo: 'app' }],
    ['ana', 'answered', { job: asking.id, answer: 'the second' }],
    ['ana', 'answered', { job: asking.id, answer: 'the third' }],
    ['ana', 'submitted', { job: held.id, repo: 'app' }],
    ['ana', 'cancelled', { job: held.id }],
    ['ana', 'project-added', { project: 'site' }],
    ['ana', 'project-removed', { project: 'site' }],
  ]);
  const at = Date.parse(h.store.activity('ana')[0]!.at);
  assert.ok(at >= before && at <= Date.now());
});

test('an answer or cancel that is refused leaves no activity', async (t) => {
  const h = await helix();
  t.after(h.stop);
  const held = await client.submit({ repo: 'app', spec: SPEC('hold'), name: 'spec.md' });
  await assert.rejects(client.answer(String(held.id), 'x'), /not waiting for an answer/);
  await client.cancel(String(held.id));
  await assert.rejects(client.cancel(String(held.id)), /already/);

  assert.deepEqual(h.log().map(([, kind]) => kind), ['submitted', 'cancelled']);
});

test('a job cancelled before it named its Animus job stays cancelled', async (t) => {
  const h = await helix();
  t.after(h.stop);
  const late = await client.submit({ repo: 'app', spec: SPEC('late'), name: 'spec.md' });
  await until(() => h.store.get(late.id)?.state, (s) => s === 'running');
  // Long enough for its process to be up, short of the 400 ms before it names its Animus job.
  await new Promise((r) => { setTimeout(r, 200); });
  await client.cancel(String(late.id));
  await new Promise((r) => { setTimeout(r, 800); });

  assert.equal(h.store.get(late.id)?.state, 'cancelled');
  await assert.rejects(client.cancel(String(late.id)), /already been cancelled/);
});

test('joining keeps the day they joined and an activity; leaving keeps both activities and the jobs', async (t) => {
  const h = await helix();
  t.after(h.stop);
  const before = Date.now();
  const { code } = invite(h.store, 'cleo');
  const joined = await client.join(process.env.HELIX_URL!, code, { claude_token: 'sk-ant-oat01-cleo', github_token: 'github_pat_cleo' });

  const day = Date.parse(h.store.person('cleo')!.joined!);
  assert.ok(day >= before && day <= Date.now());
  assert.equal(h.store.person('ana')!.joined, undefined, 'someone who joined before it was kept stays blank');

  process.env.HELIX_TOKEN = joined.token;
  const job = await client.submit({ repo: 'app', spec: SPEC('hold'), name: 'spec.md' });
  await client.leave();

  assert.equal(h.store.person('cleo'), undefined);
  assert.deepEqual(h.log('cleo').map(([, kind]) => kind), ['joined', 'submitted', 'left']);
  assert.equal(h.store.get(job.id)!.person, 'cleo');
});

test('helix remove-person and helix remove-repo keep an activity too', async (t) => {
  const h = await helix();
  t.after(h.stop);
  const cli = join(dirname(fileURLToPath(import.meta.url)), '..', 'src', 'cli.ts');
  const run = (...args: string[]) => execFileSync(process.execPath, ['--disable-warning=ExperimentalWarning', cli, ...args], { env: { ...process.env, HELIX_HOME: h.home }, encoding: 'utf8' });
  run('remove-repo', 'app');
  run('remove-person', 'ana');

  assert.deepEqual(h.log(), [['machine', 'project-removed', { project: 'app' }], ['ana', 'left', undefined]]);
});
