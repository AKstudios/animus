import assert from 'node:assert/strict';
import { mkdtempSync } from 'node:fs';
import type { AddressInfo } from 'node:net';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { test } from 'node:test';
import { jobView } from '../../plugin/display/job-view.ts';
import { peopleNotice, personNotice, personPage } from '../../plugin/display/pages.ts';
import { keepOlder, peopleView, personView } from '../../plugin/display/people-view.ts';
import type { Display, DisplayJob, JobPage, PeoplePage, PersonPage } from '../../plugin/display/shape.ts';
import { view } from '../../plugin/display/view.ts';
import { hashToken, type Config } from '../src/config.ts';
import { serve } from '../src/server.ts';
import { openStore } from '../src/store.ts';
import { supervise } from '../src/supervisor.ts';

const NOW = Date.parse('2026-11-17T12:00:00Z');

/** A Helix on a free port: ana (signed in with GitHub, joined on a day), ben (joined before the day was kept) and cy, who has done nothing. */
async function helix() {
  const home = mkdtempSync(join(tmpdir(), 'helix-'));
  const config: Config = { host: '127.0.0.1', port: 0, slots: 1 };
  const store = openStore(join(home, 'helix.db'));
  store.putPerson('ana', { token_sha256: hashToken('ana-token'), github: 'ana-gh', joined: '2026-11-10' });
  store.putPerson('ben', { token_sha256: hashToken('ben-token') });
  store.putPerson('cy', { token_sha256: hashToken('cy-token') });
  const base = { state: 'ended', repo: 'app', spec: join(home, 'spec.md'), draft: false, submitted: '2026-11-17T10:00:00Z' } as const;
  store.add({ ...base, person: 'ana', title: 'One', outcome: 'pr', pr: 'https://github.com/o/app/pull/4', cost_usd: 1.5 });
  store.add({ ...base, person: 'ana', title: 'Two', outcome: 'failed', cost_usd: 2 });
  store.add({ ...base, person: 'ben', title: 'Three', outcome: 'draft-pr', pr: 'https://github.com/o/app/pull/5' });
  store.record('ana', 'submitted', { job: 2, repo: 'app' });
  store.record('ben', 'cancelled', { job: 3 });
  const supervisor = supervise({ store, config, home });
  const server = serve({ config, store, supervisor, home });
  await new Promise<void>((r) => { server.listen(0, '127.0.0.1', r); });
  const url = `http://127.0.0.1:${(server.address() as AddressInfo).port}`;
  const get = (path: string, token?: string) => fetch(new URL(path, url), token ? { headers: { authorization: `Bearer ${token}` } } : {});
  return { get, store, stop: () => { supervisor.stop(); server.close(); store.close(); } };
}

// Protects: criterion 2, the people list. Fails when: a person is left off, a number is wrong, a person from before joined was kept shows a date, or Helix answers without a token.
test('/people lists each person with their GitHub login, joined, jobs, PRs, spent and last activity, to a valid token only', async () => {
  const h = await helix();
  const [none, wrong, ok] = await Promise.all([h.get('/people/page-data'), h.get('/people/page-data', 'not-a-token'), h.get('/people/page-data', 'cy-token')]);
  const v = peopleView((await ok.json()) as PeoplePage);
  h.stop();

  assert.deepEqual([none.status, wrong.status, ok.status], [401, 401, 200]);
  assert.deepEqual(v.rows.map((r) => [r.name, r.github, r.joined, r.jobs, r.prs, r.spent]), [
    ['ana', 'ana-gh', '2026-11-10', '2', '1', '$3.50'],
    ['ben', '', '', '1', '1', '$0.00'],
    ['cy', '', '', '0', '0', '$0.00'],
  ]);
  // Newest activity of each; none for someone who has done nothing. The time is when it was kept, so only its wording is checked.
  assert.deepEqual(v.rows.map((r) => r.last.replace(/^\d{4}-\d\d-\d\d \d\d:\d\d UTC/, 'T')), ['T · submitted a job', 'T · cancelled a job', '']);
});

const job = (id: number, over: Partial<DisplayJob>): DisplayJob => ({ id, state: 'queued', person: 'ana lee', repo: 'app', title: `Job ${id}`, submitted: '2026-11-17T11:00:00Z', ...over });

// Protects: criterion 4, the overview. Fails when: a person named on a running, waiting or ended job has no link to their page, or a name with a space is not encoded.
test('every person named on the overview links to their person page', () => {
  const d: Display = { name: 'office', at: new Date(NOW).toISOString(), slots: 1, stages: ['setup'], repos: [{ name: 'app' }], jobs: [
    job(1, { state: 'running', started: '2026-11-17T11:30:00Z' }),
    job(2, { person: 'ben' }),
    job(3, { state: 'ended', outcome: 'needs-input', question: 'Which?', person: 'cy' }),
    job(4, { state: 'ended', outcome: 'failed', person: 'dee' }),
  ], prs: [{ job: 5, repo: 'app', person: 'eve', number: 9, title: 'x', url: 'https://github.com/o/app/pull/9', draft: false, created: '2026-11-17T11:00:00Z' }] };
  const v = view(d, null, NOW);
  assert.deepEqual([...v.live, ...v.waiting, ...v.recent, ...v.prs].map((j) => [j.person, j.personPage]), [
    ['ana lee', '/people/ana%20lee'], ['cy', '/people/cy'], ['ben', '/people/ben'], ['dee', '/people/dee'], ['eve', '/people/eve'],
  ]);
  assert.equal(personPage('ana lee'), '/people/ana%20lee');
});

// Protects: criterion 4, a job page. Fails when: the person fact is plain text.
test('a job page\'s person fact links to their person page', () => {
  const page: JobPage = { at: new Date(NOW).toISOString(), stages: [], log: '', job: job(9, {}) };
  const person = jobView(page, NOW).facts.find((f) => f.k === 'person');
  assert.deepEqual(person, { k: 'person', v: 'ana lee', page: '/people/ana%20lee' });
});

// Protects: criterion 4, the people list names each person. Fails when: a row does not link to its page.
test('each row of the people list links to that person\'s page', () => {
  const v = peopleView({ at: '', people: [{ name: 'ana lee', jobs: 0, prs: 0, spent: 0 }] });
  assert.equal(v.rows[0]!.page, '/people/ana%20lee');
});

// Protects: the people list is for signed-in people. Fails when: a signed-out or refused person is not told to sign in.
test('the people list without a token, or with one Helix refused, says to sign in', () => {
  assert.match(peopleNotice(false)!, /^Sign in to see who is on this Helix/);
  assert.match(peopleNotice(false, 401)!, /^Helix did not take that token/);
  assert.equal(peopleNotice(true), undefined);
});

// Protects: criterion 3. Fails when: numbers, jobs newest first with their job page links (also one from before activity was kept, job 1 has none), or activity newest first are wrong, or a token is not needed.
test('a person\'s page shows their numbers, their jobs newest first linking to their job pages, and their activity newest first', async () => {
  const h = await helix();
  h.store.record('ana', 'answered', { job: 1, answer: 'Use the second one' });
  const [none, ok] = await Promise.all([h.get('/people/ana/page-data'), h.get('/people/ana/page-data', 'ben-token')]);
  const v = personView((await ok.json()) as PersonPage);
  h.stop();

  assert.deepEqual([none.status, ok.status], [401, 200]);
  assert.deepEqual(v.facts, [
    { k: 'github', v: 'ana-gh' }, { k: 'joined', v: '2026-11-10' }, { k: 'jobs', v: '2' }, { k: 'PRs opened', v: '1' }, { k: 'spent', v: '$3.50' },
    { k: 'last activity', v: v.facts.at(-1)!.v },
  ]);
  assert.match(v.facts.at(-1)!.v, / · answered a job$/);
  assert.equal(v.left, undefined);
  assert.deepEqual(v.jobs.map((j) => [j.id, j.title, j.page, j.tag]), [[2, 'Two', '/jobs/2', 'failed'], [1, 'One', '/jobs/1', 'pull request']]);
  assert.deepEqual(v.activity.map((a) => [a.text, a.page, a.note]), [['answered a job #1', '/jobs/1', 'Use the second one'], ['submitted a job #2 for app', '/jobs/2', undefined]]);
});

// Protects: criterion 3, thirty at a time. Fails when: more than thirty jobs come at once, the next thirty repeat or skip one, or the page does not say whether older ones remain.
test('a person\'s jobs come thirty at a time, newest first, each batch starting where the last stopped', async () => {
  const h = await helix();
  for (let i = 0; i < 32; i++) h.store.add({ state: 'ended', repo: 'app', spec: 'x', draft: false, submitted: '2026-11-17T10:00:00Z', person: 'cy', title: `Cy ${i}` });
  const first = (await (await h.get('/people/cy/page-data', 'cy-token')).json()) as PersonPage;
  const second = (await (await h.get('/people/cy/page-data?before=' + first.jobList.at(-1)!.id, 'cy-token')).json()) as PersonPage;
  h.stop();

  assert.deepEqual([first.jobList.length, first.jobList[0]!.title, first.more], [30, 'Cy 31', true]);
  assert.deepEqual([second.jobList.map((j) => j.title), second.more], [['Cy 1', 'Cy 0'], false]);
  assert.equal(personView(first, { jobs: second.jobList, more: second.more }).jobs.length, 32);
});

// Protects: SHOW MORE survives a refresh. Fails when: a job submitted after SHOW MORE pushes the 30th job out of the newest thirty and out of the page.
test('a refresh after SHOW MORE, with a new job, still lists every job once', async () => {
  const h = await helix();
  for (let i = 0; i < 31; i++) h.store.add({ state: 'ended', repo: 'app', spec: 'x', draft: false, submitted: '2026-11-17T10:00:00Z', person: 'cy', title: `Cy ${i}` });
  const read = async (q = '') => (await (await h.get(`/people/cy/page-data${q}`, 'cy-token')).json()) as PersonPage;
  const first = await read();
  const second = await read(`?before=${first.jobList.at(-1)!.id}`);
  h.store.add({ state: 'ended', repo: 'app', spec: 'x', draft: false, submitted: '2026-11-17T10:00:00Z', person: 'cy', title: 'Cy 31' });
  const next = await read();
  h.stop();

  const older = keepOlder(first, second.jobList, next);
  const titles = personView(next, { jobs: older, more: second.more }).jobs.map((j) => j.title);
  assert.deepEqual([titles.length, titles[0], titles.at(-1), new Set(titles).size], [32, 'Cy 31', 'Cy 0', 32]);
});

// Protects: a person who left keeps their page. Fails when: it is a 404, the jobs and activity are dropped, or it does not say they left.
test('a person who left still has a page that says when they left; a name Helix never heard of has none', async () => {
  const h = await helix();
  h.store.record('ana', 'left');
  h.store.dropPerson('ana');
  const res = await h.get('/people/ana/page-data', 'ben-token');
  const v = personView((await res.json()) as PersonPage);
  const [ghost, odd] = await Promise.all([h.get('/people/nobody/page-data', 'ben-token'), h.get('/people/%E0%A4%A/page-data', 'ben-token')]);
  h.stop();

  assert.match(v.left!, /^ana left Helix on \d{4}-\d\d-\d\d\.$/);
  assert.deepEqual(v.jobs.map((j) => j.id), [2, 1]);
  assert.equal(v.activity[0]!.text, 'left');
  assert.deepEqual([ghost.status, odd.status], [404, 404]);
});

// Protects: the person page says why it shows nothing. Fails when: a signed-out or refused person, or an unknown name, gets no explanation.
test('a person\'s page without a token says to sign in, and for a name Helix does not know says so', () => {
  assert.match(personNotice('ana', false)!, /^Sign in to see ana/);
  assert.match(personNotice('ana', false, 401)!, /^Helix did not take that token/);
  assert.equal(personNotice('ana', true, 404), 'Helix has never heard of ana.');
  assert.equal(personNotice('ana', true, 200), undefined);
});
