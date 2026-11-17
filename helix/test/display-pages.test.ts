import assert from 'node:assert/strict';
import { mkdtempSync, readFileSync } from 'node:fs';
import type { AddressInfo } from 'node:net';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { test } from 'node:test';
import { jobNotice, readToken, route, takeToken, forgetToken, keepToken } from '../../plugin/display/pages.ts';
import type { Display, DisplayJob } from '../../plugin/display/shape.ts';
import { view } from '../../plugin/display/view.ts';
import { hashToken, type Config } from '../src/config.ts';
import { serve } from '../src/server.ts';
import { openStore } from '../src/store.ts';
import { supervise } from '../src/supervisor.ts';

const DISPLAY = join(import.meta.dirname, '..', '..', 'plugin', 'display');
/** What a browser sends when it opens an address. */
const BROWSER = { accept: 'text/html,application/xhtml+xml,application/xml;q=0.9,*/*;q=0.8' };

/** A Helix on a free port with two people and one job that ended, asked by ana. */
async function helix() {
  const home = mkdtempSync(join(tmpdir(), 'helix-'));
  const config: Config = { host: '127.0.0.1', port: 0, slots: 1 };
  const store = openStore(join(home, 'helix.db'));
  store.putPerson('ana', { token_sha256: hashToken('ana-token') });
  store.putPerson('ben', { token_sha256: hashToken('ben-token') });
  const job = store.add({ state: 'ended', person: 'ana', repo: 'app', spec: join(home, 'spec.md'), title: 'Export to PDF', draft: false, submitted: '2026-11-17T10:00:00Z', outcome: 'pr', pr: 'https://github.com/o/app/pull/4', pid: 4242 });
  const supervisor = supervise({ store, config, home });
  const server = serve({ config, store, supervisor, home });
  await new Promise<void>((r) => { server.listen(0, '127.0.0.1', r); });
  const url = `http://127.0.0.1:${(server.address() as AddressInfo).port}`;
  const get = (path: string, headers: Record<string, string> = {}) => fetch(new URL(path, url), { headers });
  return { job, get, stop: () => { supervisor.stop(); server.close(); store.close(); } };
}

/** Storage as a browser keeps it, or one that refuses every read and write (a locked-down browser). */
function storage(refuses = false) {
  const kept = new Map<string, string>();
  const no = () => { throw new Error('storage is off'); };
  return () => refuses ? no() : { getItem: (k: string) => kept.get(k) ?? null, setItem: (k: string, v: string) => { kept.set(k, v); }, removeItem: (k: string) => { kept.delete(k); } };
}

// Protects: shareable addresses. Fails when: a job or people address opened cold is a 401 or 404 instead of the page.
test('a job page and the people pages load the display, also when the address is opened cold', async () => {
  const h = await helix();
  const page = readFileSync(join(DISPLAY, 'index.html'), 'utf8');
  for (const path of [`/jobs/${h.job.id}`, '/jobs/999', '/people', '/people/ana']) {
    const res = await h.get(path, BROWSER);
    assert.deepEqual([res.status, res.headers.get('content-type'), await res.text()], [200, 'text/html; charset=utf-8', page], path);
  }
  // The job's path is also the API's: a client that does not ask for a page still needs a token.
  assert.equal((await h.get(`/jobs/${h.job.id}`)).status, 401);
  h.stop();
});

// Protects: the script draws the page the path names. Fails when: a path is read as the wrong page.
test('the display draws the page its address names', () => {
  assert.deepEqual(
    ['/', '/jobs/12', '/people', '/people/ana%20lee', '/jobs/x', '/elsewhere'].map(route),
    [{ page: 'overview' }, { page: 'job', id: 12 }, { page: 'people' }, { page: 'people', name: 'ana lee' }, { page: 'overview' }, { page: 'overview' }],
  );
});

// Protects: every job on the overview is a way into its page. Fails when: a section's jobs are drawn without their link.
test('every job on the overview links to its job page', () => {
  const now = Date.parse('2026-11-17T12:00:00Z');
  const job = (id: number, over: Partial<DisplayJob>): DisplayJob => ({ id, state: 'queued', person: 'ana', repo: 'app', title: `Job ${id}`, submitted: '2026-11-17T11:00:00Z', ...over });
  const d: Display = { name: 'office', at: new Date(now).toISOString(), slots: 1, stages: ['setup'], repos: [{ name: 'app' }], jobs: [
    job(1, { state: 'running', started: '2026-11-17T11:30:00Z' }),
    job(2, {}),
    job(3, { state: 'ended', outcome: 'needs-input', question: 'Which?' }),
    job(4, { state: 'ended', outcome: 'pr', pr: 'https://github.com/o/app/pull/9' }),
    job(5, { state: 'cancelled' }),
  ] };
  const v = view(d, null, now);
  assert.deepEqual([...v.live, ...v.waiting, ...v.recent].map((j) => [j.id, j.page]), [
    [1, '/jobs/1'], [3, '/jobs/3'], [2, '/jobs/2'], [5, '/jobs/5'], [4, '/jobs/4'],
  ]);
});

// Protects: signing in from a link. Fails when: the token is left in the address bar, or not kept.
test('a token in the address is kept by the browser and taken out of the address; signing out forgets it', () => {
  const store = storage();
  assert.equal(takeToken('#app', store), false);
  assert.equal(readToken(store), null);
  assert.equal(takeToken('#token=abc%2B1', store), true);
  assert.equal(readToken(store), 'abc+1');
  forgetToken(store);
  assert.equal(readToken(store), null);
  assert.equal(keepToken(store, ' pasted '), true);
  assert.equal(readToken(store), 'pasted');
});

// Protects: a browser that refuses storage still shows the display. Fails when: a storage error escapes and the page never draws.
test('a browser that refuses storage is signed out, and the token still leaves the address', () => {
  const store = storage(true);
  assert.equal(takeToken('#token=abc', store), true);
  assert.equal(readToken(store), null);
  assert.equal(keepToken(store, 'abc'), false);
  assert.doesNotThrow(() => { forgetToken(store); });
});

// Protects: what a job page says when it cannot show the job. Fails when: a signed-out or refused person is not told to sign in.
test('a job page without a token, or with one Helix refused, says to sign in', () => {
  assert.deepEqual(jobNotice(7, false), { signIn: true, text: 'Sign in to see job #7. Paste your Helix token: animus join kept it in ~/.animus/helix.json.' });
  assert.deepEqual(jobNotice(7, false, 401), { signIn: true, text: 'Helix did not take that token, so this browser forgot it. Sign in again to see job #7.' });
  assert.deepEqual(jobNotice(7, true, 404), { signIn: false, text: 'Helix has no job #7.' });
  assert.equal(jobNotice(7, true, 200), undefined);
});

// Protects: a job's details stay with the people on the Helix. Fails when: the job page's data answers without a valid token.
test('Helix answers a job page\'s data only to a valid token, from any person, and without a client version', async () => {
  const h = await helix();
  const data = `/jobs/${h.job.id}/page-data`;
  assert.equal((await h.get(data)).status, 401);
  assert.equal((await h.get(data, { authorization: 'Bearer not-a-token' })).status, 401);
  const res = await h.get(data, { authorization: 'Bearer ben-token' });
  assert.equal(res.status, 200);
  const { job } = (await res.json()) as { job: Record<string, unknown> };
  assert.deepEqual([job.id, job.title, job.person, job.outcome, job.pr], [h.job.id, 'Export to PDF', 'ana', 'pr', 'https://github.com/o/app/pull/4']);
  // Only Helix's business, as on the overview.
  assert.deepEqual([job.spec, job.pid], [undefined, undefined]);
  assert.equal((await h.get('/jobs/999/page-data', { authorization: 'Bearer ben-token' })).status, 404);
  h.stop();
});
