import assert from 'node:assert/strict';
import { existsSync, mkdirSync, mkdtempSync, rmSync, writeFileSync } from 'node:fs';
import type { AddressInfo } from 'node:net';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { test } from 'node:test';
import { saveProgress } from '../../plugin/src/log.ts';
import * as client from '../../plugin/src/remote.ts';
import { write } from '../../plugin/test/helpers.ts';
import { hashToken, type Config } from '../src/config.ts';
import type { Display } from '../src/display.ts';
import { serve } from '../src/server.ts';
import { openStore } from '../src/store.ts';
import { supervise, type Launch } from '../src/supervisor.ts';

const SPEC = (title: string) => `---\nsize: small\n---\n# ${title}\n\n## Acceptance criteria\n\n1. It works.\n`;

// Stands in for `animus run`: says its job id, then ends as the spec's title
// tells it to. "hold" waits for a file; "ask" asks until it is given an answer.
const FAKE = `
const fs = require('node:fs');
const [title, answer, release] = process.argv.slice(1);
console.error('job fake-' + title.replace(/ /g, '-') + ': ' + title);
const end = (r) => { console.log(JSON.stringify({ ...r, reason: 'user=' + process.env.ANIMUS_USER + ' secret=' + (process.env.SECRET || '') + ' answer=' + answer })); };
if (title.startsWith('ask') && !answer) end({ outcome: 'needs-input', question: 'which one?' });
else if (title.startsWith('hold')) { const t = setInterval(() => { if (fs.existsSync(release)) { clearInterval(t); end({ outcome: 'pr', pr: 'https://example.test/pr/' + title }); } }, 20); }
else end({ outcome: 'pr', pr: 'https://example.test/pr/' + title });
`;

async function until<T>(read: () => Promise<T> | T, ok: (v: T) => boolean): Promise<T> {
  for (let i = 0; i < 500; i++) {
    const v = await read();
    if (ok(v)) return v;
    await new Promise((r) => { setTimeout(r, 20); });
  }
  throw new Error('timed out waiting');
}

/** A Helix on a free port with one slot, two people and one repository. */
async function helix(home = mkdtempSync(join(tmpdir(), 'helix-'))) {
  const repo = join(home, 'repo');
  mkdirSync(repo, { recursive: true });
  const secrets = join(home, 'ana.env');
  writeFileSync(secrets, 'SECRET=anas\n');
  const config: Config = { host: '127.0.0.1', port: 0, slots: 1, repos: { app: repo }, people: { ana: { token_sha256: hashToken('ana-token'), env_file: secrets }, ben: { token_sha256: hashToken('ben-token') } } };
  const release = join(home, 'release');
  const launch: Launch = (job) => ({ command: process.execPath, args: ['-e', FAKE, job.title, job.answer ?? '', release] });
  const store = openStore(join(home, 'helix.db'));
  const supervisor = supervise({ store, config, home, launch });
  const server = serve({ config, store, supervisor });
  await new Promise<void>((r) => { server.listen(0, '127.0.0.1', r); });
  process.env.HELIX_URL = `http://127.0.0.1:${(server.address() as AddressInfo).port}`;
  const as = (who: 'ana' | 'ben' | 'nobody') => { process.env.HELIX_TOKEN = `${who}-token`; };
  as('ana');
  const stop = () => { supervisor.stop(); server.close(); store.close(); };
  const ended = (id: number) => until(() => client.job(String(id)), (j) => j.state === 'ended');
  return { home, release, as, stop, ended, submit: (title: string) => client.submit({ repo: 'app', spec: SPEC(title), name: 'spec.md' }) };
}

test('submitted jobs run one per slot, in order, each as its submitter with only that person\'s credentials', async () => {
  const h = await helix();
  const first = await h.submit('hold one');
  h.as('ben');
  const second = await h.submit('two');
  await until(() => client.job(String(first.id)), (j) => j.state === 'running' && j.animus_job === 'fake-hold-one');
  assert.equal((await client.job(String(second.id))).state, 'queued');

  writeFileSync(h.release, '');
  const a = await h.ended(first.id);
  const b = await h.ended(second.id);
  assert.deepEqual([a.outcome, a.pr, a.reason], ['pr', 'https://example.test/pr/hold one', 'user=ana secret=anas answer=']);
  assert.deepEqual([b.outcome, b.person, b.reason], ['pr', 'ben', 'user=ben secret= answer=']);
  assert.match(a.log!, /job fake-hold-one: hold one/);
  assert.deepEqual((await client.jobs()).jobs.map((j) => j.id), [first.id, second.id]);
  h.stop();
});

test('a request with no valid token, an unknown repository, or a spec that does not parse is refused', async () => {
  const h = await helix();
  h.as('nobody');
  await assert.rejects(h.submit('x'), /a valid token is needed/);
  h.as('ana');
  await assert.rejects(client.submit({ repo: 'other', spec: SPEC('x'), name: 'spec.md' }), /no repository named other; it has app/);
  await assert.rejects(client.submit({ repo: 'app', spec: '# No criteria\n', name: 'spec.md' }), /Acceptance criteria/);
  h.stop();
});

test('a job is cancelled only by its submitter: a running one is ended and the next one starts', async () => {
  const h = await helix();
  const running = await h.submit('hold running');
  const queued = await h.submit('hold queued');
  const next = await h.submit('next');
  await until(() => client.job(String(running.id)), (j) => j.state === 'running');
  h.as('ben');
  await assert.rejects(client.cancel(String(running.id)), /is ana's/);
  h.as('ana');
  await client.cancel(String(queued.id));
  await client.cancel(String(running.id));
  assert.equal((await h.ended(next.id)).outcome, 'pr');
  assert.deepEqual([(await client.job(String(running.id))).state, (await client.job(String(queued.id))).state], ['cancelled', 'cancelled']);
  await assert.rejects(client.cancel(String(next.id)), /already ended/);
  h.stop();
});

test('a job that asks a question waits for its answer, then resumes with it', async () => {
  const h = await helix();
  const j = await h.submit('ask me');
  const asked = await h.ended(j.id);
  assert.deepEqual([asked.outcome, asked.question], ['needs-input', 'which one?']);
  await client.answer(String(j.id), 'the second');
  const done = await until(() => client.job(String(j.id)), (x) => x.outcome === 'pr');
  assert.match(done.reason!, /answer=the second/);
  assert.equal(done.question, undefined);
  await assert.rejects(client.answer(String(j.id), 'again'), /not waiting for an answer/);
  h.stop();
});

test('the display\'s page and scripts need no token, what it shows does, and no path climbs out of its folder', async () => {
  const h = await helix();
  const get = (path: string, token?: string) => fetch(new URL(path, process.env.HELIX_URL), token ? { headers: { authorization: `Bearer ${token}` } } : {});

  const page = await get('/');
  assert.deepEqual([page.status, page.headers.get('content-type')], [200, 'text/html; charset=utf-8']);
  assert.match(await page.text(), /<script type="module" src="\/ui\/app\.ts">/);
  // A script is sent as JavaScript: its types are gone.
  const script = await get('/ui/view.ts');
  const text = await script.text();
  assert.deepEqual([script.status, script.headers.get('content-type')], [200, 'text/javascript; charset=utf-8']);
  assert.ok(text.includes('export function view(') && !text.includes('import type') && !text.includes(': Display'));
  assert.equal((await get('/ui/fonts/titillium-web-400.woff2')).headers.get('content-type'), 'font/woff2');
  for (const path of ['/ui/../src/server.ts', '/ui/%2e%2e/src/server.ts', '/ui/fonts/../../src/server.ts', '/ui/nothing.css', '/ui/fonts/OFL-TitilliumWeb.txt']) {
    assert.equal((await get(path)).status, 401, path);
  }
  assert.equal((await get('/display')).status, 401);
  assert.equal((await get('/display', 'wrong')).status, 401);
  h.stop();
});

test('the display is told every job, where a running one is, and why a queued one is back in the queue', async () => {
  const h = await helix();
  write(h.home, 'repo/.animus/animus.yaml', 'base: develop\ncommands:\n  test: npm test\n  typecheck: npm run typecheck\n');
  const read = async () => (await (await fetch(new URL('/display', process.env.HELIX_URL), { headers: { authorization: 'Bearer ben-token' } })).json()) as Display;

  const running = await h.submit('hold the slot');
  const asks = await h.submit('ask later');
  const first = await until(read, (d) => Boolean(d.jobs[0]?.animus_job));
  assert.deepEqual([first.slots, first.stages.length, first.repos], [1, 6, [{ name: 'app', base: 'develop', gates: ['test', 'typecheck'] }]]);
  assert.ok(first.name && Math.abs(Date.parse(first.at) - Date.now()) < 5000);
  // The last line the job said; nothing yet about its stage. And nothing that is only Helix's business.
  assert.deepEqual([first.jobs[0]!.state, first.jobs[0]!.now, first.jobs[0]!.progress], ['running', 'job fake-hold-the-slot: hold the slot', undefined]);
  assert.deepEqual(Object.keys(first.jobs[0]!).filter((k) => ['spec', 'pid', 'answer', 'draft'].includes(k)), []);

  // The job says where it is, as `animus run` does while it works.
  saveProgress('fake-hold-the-slot', 'review', 'reviewer · deep tier');
  const at = (await read()).jobs[0]!.progress!;
  assert.deepEqual([at.stage, at.who], ['review', 'reviewer · deep tier']);

  writeFileSync(h.release, '');
  await h.ended(running.id);
  await h.ended(asks.id);
  // The slot is taken again, so the answered job waits its turn and says why it is back.
  rmSync(h.release);
  await h.submit('hold again');
  await client.answer(String(asks.id), 'the second');
  const back = (await read()).jobs.find((j) => j.id === asks.id)!;
  assert.deepEqual([back.state, back.resumed, Boolean(back.queued)], ['queued', 'answer', true]);
  writeFileSync(h.release, '');
  await until(() => client.job(String(asks.id)), (j) => j.outcome === 'pr');
  h.stop();
});

test('a job that was running when Helix died is queued again and runs when Helix is back', async () => {
  const h = await helix();
  const j = await h.submit('hold over a restart');
  await until(() => client.job(String(j.id)), (x) => x.state === 'running' && Boolean(x.animus_job));
  h.stop();
  // As a crash leaves it: the table still says running, and no supervisor holds the process.
  const store = openStore(join(h.home, 'helix.db'));
  store.save({ ...store.get(j.id)!, state: 'running' });
  store.close();

  const again = await helix(h.home);
  assert.ok(!existsSync(again.release));
  writeFileSync(again.release, '');
  const done = await again.ended(j.id);
  assert.deepEqual([done.outcome, done.animus_job], ['pr', 'fake-hold-over-a-restart']);
  again.stop();
});
