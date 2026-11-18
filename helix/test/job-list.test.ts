import assert from 'node:assert/strict';
import { mkdtempSync, writeFileSync } from 'node:fs';
import type { AddressInfo } from 'node:net';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { test } from 'node:test';
import { filterOf, jobListView, queryOf } from '../../plugin/display/job-list.ts';
import { route } from '../../plugin/display/pages.ts';
import type { JobListPage } from '../../plugin/display/shape.ts';
import { hashToken, type Config } from '../src/config.ts';
import type { GithubPr } from '../src/open-prs.ts';
import { serve } from '../src/server.ts';
import { openStore } from '../src/store.ts';
import { supervise } from '../src/supervisor.ts';

const pull = (n: number) => `https://github.com/o/app/pull/${n}`;
const gh = (n: number, over: Partial<GithubPr> = {}): GithubPr => ({ html_url: pull(n), number: n, title: `PR ${n}`, created_at: '2026-11-17T10:00:00Z', ...over });

/**
 * A Helix with ana (who has a GitHub token) and ben, projects app and site, and the jobs: 33 for ana in
 * app that ended with failed (ids 1-33, one minute apart), then PR jobs 4x (open), 5x (merged), 6x (closed
 * unmerged) and 7x (GitHub silent), a job waiting for an answer, a running one and a queued one.
 */
async function helix() {
  const home = mkdtempSync(join(tmpdir(), 'job-list-'));
  const config: Config = { host: '127.0.0.1', port: 0, slots: 0 };
  const store = openStore(join(home, 'helix.db'));
  writeFileSync(join(home, 'ana.env'), 'GH_TOKEN=ana-gh\n');
  store.putPerson('ana', { token_sha256: hashToken('ana-token'), env_file: join(home, 'ana.env') });
  store.putPerson('ben', { token_sha256: hashToken('ben-token') });
  store.putProject({ name: 'app', url: 'https://github.com/o/app.git', dir: home, state: 'ready', added: '' });
  let minute = 0;
  const add = (over: Record<string, unknown>) => store.add({ state: 'ended', person: 'ana', repo: 'app', spec: '', draft: false, title: 'A job', submitted: `2026-11-17T10:${String(minute++).padStart(2, '0')}:00Z`, ...over } as Parameters<typeof store.add>[0]);
  for (let i = 1; i <= 33; i++) add({ outcome: 'failed', title: `Failed ${i}` });
  for (const n of [41, 51, 61, 71]) add({ outcome: 'pr', pr: pull(n), title: `PR job ${n}`, cost_usd: 1.5 });
  add({ outcome: 'needs-input', title: 'Asks', person: 'ben', repo: 'site' });
  add({ state: 'running', title: 'Runs', person: 'ben', repo: 'site' });
  add({ state: 'queued', title: 'Waits' });
  const supervisor = supervise({ store, config, home });
  const server = serve({ config, store, supervisor, home, listPrs: async () => [gh(41)], listClosedPrs: async () => [gh(51, { merged_at: '2026-11-17T11:00:00Z' }), gh(61, { closed_at: '2026-11-17T11:00:00Z' })] });
  await new Promise<void>((r) => { server.listen(0, '127.0.0.1', r); });
  const base = `http://127.0.0.1:${(server.address() as AddressInfo).port}`;
  const get = (path: string, token?: string) => fetch(new URL(path, base), token ? { headers: { authorization: `Bearer ${token}` } } : {});
  const list = async (query = ''): Promise<JobListPage> => (await get(`/job-list${query}`, 'ben-token')).json() as Promise<JobListPage>;
  return { get, list, stop: () => { supervisor.stop(); server.close(); store.close(); } };
}

// Protects: criterion 3. Fails when: the list is not newest first, is longer than 30, SHOW MORE (before) skips or repeats a job, or a tag is wrong.
test('/job-list gives the 30 newest jobs, older ones after `before`, each tagged as GitHub said', async () => {
  const h = await helix();
  const first = await h.list();
  const rest = await h.list(`?before=${encodeURIComponent(first.jobs.at(-1)!.submitted)}`);
  h.stop();
  assert.equal(first.jobs.length, 30);
  assert.deepEqual([first.jobs[0]!.title, first.jobs[1]!.title], ['Waits', 'Runs']);
  assert.equal(first.more, true);
  assert.deepEqual([rest.jobs.length, rest.more, rest.jobs[0]!.title, rest.jobs.at(-1)!.title], [10, false, 'Failed 10', 'Failed 1']);
  const tags = Object.fromEntries(jobListView(first, false).rows.map((r) => [r.title, r.tag]));
  assert.deepEqual([tags['Waits'], tags['Runs'], tags['Asks'], tags['PR job 71'], tags['PR job 61'], tags['PR job 51'], tags['PR job 41'], tags['Failed 33']],
    ['QUEUED', 'QUEUED', 'NEEDS INPUT', 'PR #71', 'CLOSED #61', 'MERGED #51', 'OPEN PR #41', 'FAILED']);
  const row = jobListView(first, false).rows.find((r) => r.title === 'PR job 51')!;
  assert.deepEqual([row.page, row.repo, row.person, row.meta, row.personPage], [`/jobs/${row.id}`, 'app', 'ana', '$1.50', '/people/ana']);
});

// Protects: criterion 4. Fails when: a filter keeps a job of another result, project or person, or a result Helix does not know is accepted.
test('/job-list filters by result, project and person', async () => {
  const h = await helix();
  const titles = async (q: string) => (await h.list(q)).jobs.map((j) => j.title);
  const got = {
    merged: await titles('?result=merged'), open: await titles('?result=open'), asks: await titles('?result=needs%20input'),
    failed: (await h.list('?result=failed')).jobs.length, site: await titles('?project=site'), ben: await titles('?person=ben'),
    both: await titles('?person=ana&project=site'), bad: (await h.get('/job-list?result=bogus', 'ben-token')).status,
  };
  h.stop();
  assert.deepEqual([got.merged, got.open, got.asks], [['PR job 51'], ['PR job 41'], ['Asks']]);
  assert.deepEqual([got.failed, got.site, got.ben, got.both, got.bad], [30, ['Runs', 'Asks'], ['Runs', 'Asks'], [], 400]);
});

// Protects: criterion 3, a person's token only. Fails when: the list is given without a token or with one Helix does not know.
test('/job-list answers only to a person\'s token', async () => {
  const h = await helix();
  const statuses = await Promise.all([h.get('/job-list'), h.get('/job-list', 'nope'), h.get('/job-list', 'ana-token')].map(async (r) => (await r).status));
  h.stop();
  assert.deepEqual(statuses, [401, 401, 200]);
});

// Protects: criterion 4, filters in the address. Fails when: an address does not give back the filter it was made from, or /jobs is not the Jobs page.
test('filters round-trip through the address, and /jobs is the Jobs page', () => {
  const f = { result: 'merged', project: 'my app', person: 'ana' } as const;
  assert.deepEqual(filterOf(queryOf(f)), f);
  assert.deepEqual([queryOf(filterOf('')), filterOf('?result=bogus').result], ['', 'all']);
  assert.deepEqual([route('/jobs').page, route('/jobs/7').page], ['jobs', 'job']);
});
