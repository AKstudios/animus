import assert from 'node:assert/strict';
import { mkdirSync, mkdtempSync, readFileSync, rmSync } from 'node:fs';
import type { AddressInfo } from 'node:net';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { test } from 'node:test';
import { jobNotice, originOf, route } from '../../plugin/display/pages.ts';
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
  return { job, home, get, stop: () => { supervisor.stop(); server.close(); store.close(); } };
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
    [{ page: 'overview' }, { page: 'job', id: 12 }, { page: 'people' }, { page: 'people', name: 'ana lee' }, { page: 'job', id: 'x' }, { page: 'overview' }],
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
  assert.deepEqual([...v.live, ...v.needs, ...v.line, ...v.finished].map((j) => [j.id, j.page]), [
    [1, '/jobs/1'], [3, '/jobs/3'], [2, '/jobs/2'], [5, '/jobs/5'], [4, '/jobs/4'],
  ]);
});

// Protects: what a job page says when it cannot show the job. Fails when: a job Helix does not have is not named, or a page with its job says anything, or a sign-in is asked for.
test('a job page says only when Helix has no such job, and never asks for a sign-in', () => {
  assert.equal(jobNotice(7, 404), 'Helix has no job #7.');
  assert.equal(jobNotice(7, 200), undefined);
  assert.equal(jobNotice(7, 401), undefined);
  assert.equal(jobNotice(7), undefined);
  assert.equal(jobNotice('a-9', 404, true), 'This machine has no job a-9.');
});

// Protects: one bad request does not stop Helix's display. Fails when: an unreadable run log gives anything but a 500 with a one-line reason, or the next request is not served.
test('an error while answering one request is a 500 with a one-line reason, and Helix keeps serving', async () => {
  const h = await helix();
  const prev = process.env.ANIMUS_HOME;
  process.env.ANIMUS_HOME = join(h.home, 'own');
  mkdirSync(join(h.home, 'own', 'runs.jsonl'), { recursive: true });
  const bad = await h.get('/insights-data', { authorization: 'Bearer ana-token' });
  const { error } = (await bad.json()) as { error: string };
  rmSync(join(h.home, 'own', 'runs.jsonl'), { recursive: true });
  const after = await h.get('/version');
  process.env.ANIMUS_HOME = prev;
  h.stop();
  assert.equal(bad.status, 500);
  assert.ok(error && !error.includes('\n'));
  assert.equal(after.status, 200);
});

// Protects: a job page's data is the display's, and Helix's own business stays out of it. Fails when: it is refused without a token or a client version, or carries the spec's path or the pid.
test('Helix answers a job page\'s data to anyone, without a client version, and keeps its own business out', async () => {
  const h = await helix();
  const data = `/jobs/${h.job.id}/page-data`;
  const res = await h.get(data);
  assert.equal(res.status, 200);
  const { job } = (await res.json()) as { job: Record<string, unknown> };
  assert.deepEqual([job.id, job.title, job.person, job.outcome, job.pr], [h.job.id, 'Export to PDF', 'ana', 'pr', 'https://github.com/o/app/pull/4']);
  // Only Helix's business, as on the overview.
  assert.deepEqual([job.spec, job.pid], [undefined, undefined]);
  assert.equal((await h.get('/jobs/999/page-data')).status, 404);
  h.stop();
});

// Protects: criterion 5, the back link. Fails when: a page opened from elsewhere, from itself or from nowhere gets a back link, or one from a Helix page is named or addressed wrong.
test('the back link names the Helix page the viewer came from, with its filters, and nothing else', () => {
  const o = 'https://h.test';
  const from = (ref: string, here = '/jobs/7') => originOf(ref, o, here);
  assert.deepEqual(from(`${o}/jobs?result=merged#x`), { name: 'Jobs', href: '/jobs?result=merged#x', page: 'jobs' });
  assert.deepEqual([from(`${o}/`)?.name, from(`${o}/insights`)?.name, from(`${o}/people`)?.name, from(`${o}/people/ana`)?.name, from(`${o}/jobs/9`)?.name], ['Overview', 'Insights', 'People', 'ana', 'Job #9']);
  assert.deepEqual([from(''), from('not a url'), from('https://other.test/jobs'), from(`${o}/jobs/7`)], [undefined, undefined, undefined, undefined]);
});

// Protects: criterion 1, every page's h1 has its row to itself. Fails when: the overview's facts or Insights' scope switcher goes back inside the heading's row.
test('the overview facts and the Insights scope switcher sit below the heading row', () => {
  const app = readFileSync(join(DISPLAY, 'app.ts'), 'utf8');
  assert.match(app, /<\/div>\n  <\/div>\n  \$\{v\.sel \? `<div class="facts"/);
  assert.match(app, /const top = `\$\{head\}\$\{scopes\}`;/);
  for (const row of app.match(/<div class="scope">.*?<\/h1>/gs) ?? []) assert.doesNotMatch(row, /facts|segmented/);
});
