import assert from 'node:assert/strict';
import { mkdirSync, mkdtempSync, writeFileSync } from 'node:fs';
import type { AddressInfo } from 'node:net';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { test } from 'node:test';
import { insightsView, scopeOf } from '../../plugin/display/insights-view.ts';
import { route } from '../../plugin/display/pages.ts';
import type { InsightsLesson, InsightsOutcome, InsightsPage, InsightsRun } from '../../plugin/display/shape.ts';
import { listenLocal, localServer } from '../../plugin/src/local-display.ts';
import { hashToken, type Config } from '../src/config.ts';
import { serve } from '../src/server.ts';
import { openStore } from '../src/store.ts';
import { supervise } from '../src/supervisor.ts';

const NOW = Date.parse('2026-11-18T12:00:00Z');
const DAY = 86_400_000;
const at = (daysAgo: number) => new Date(NOW - daysAgo * DAY).toISOString();
const pr = (n: number) => `https://github.com/o/app/pull/${n}`;

/** A delivered job's run line: PR n, ended `days` ago, cost 2, 10 minutes, a gate run that passed. */
const run = (job: string, days: number, over: Partial<InsightsRun> = {}): InsightsRun => ({
  job, repo: '/work/app', size: 'medium', difficulty: 'routine', type: 'feature', ended: at(days), outcome: 'pr', cost_usd: 2, ms: 600_000, pr: pr(Number(job.slice(1))),
  fix_rounds: 0, gates: [{ ok: true, flaky: [] }], agents: [], review: null, ...over,
});
const merged = (human_commits = 0, over: Partial<InsightsOutcome> = {}): InsightsOutcome => ({ state: 'MERGED', human_commits, ...over });
const page = (runs: InsightsRun[], outcomes: Record<string, InsightsOutcome>, lessons: InsightsLesson[] = [], scope = 'factory'): InsightsPage =>
  ({ at: new Date(NOW).toISOString(), scope, projects: ['app', 'site'], runs, outcomes, lessons });

// Protects: criterion 1. Fails when: a share is worked out over the wrong jobs (delivered, merged, gated), a flaky check counts as failed, a change leaves the window or points/dollars, or a tone is the wrong way round.
test('the five numbers are for the last 30 days, each with its change from the 30 before', () => {
  const v = insightsView(page(
    [
      // Last 30 days: j1 merged untouched, first time; j2 merged after a person's commit, fixed once; j3 merged then reverted, with a flaky check; j4 closed unmerged.
      run('j1', 2), run('j2', 5, { fix_rounds: 1, gates: [{ ok: false, flaky: [] }, { ok: true, flaky: [] }] }),
      run('j3', 9, { cost_usd: 5, gates: [{ ok: true, flaky: ['test'] }] }), run('j4', 12),
      // The 30 before: one merged untouched at $4, one closed.
      run('j5', 40, { cost_usd: 4, ms: 1_200_000 }), run('j6', 45),
    ],
    { [pr(1)]: merged(), [pr(2)]: merged(1), [pr(3)]: merged(0, { reverted: true }), [pr(4)]: { state: 'CLOSED', human_commits: 0 }, [pr(5)]: merged(), [pr(6)]: { state: 'CLOSED', human_commits: 0 } },
  ));
  const t = Object.fromEntries(v.tiles.map((x) => [x.label, [x.value, x.note, x.change?.text, x.change?.tone]]));
  assert.deepEqual(t, {
    'Merge rate': ['75%', '3 of 4', '+25 pts', 'good'],
    'Merged untouched': ['67%', 'no commit after the job', '−33 pts', 'bad'],
    'Gates pass first time': ['75%', '1 flaky check', '−25 pts', 'bad'],
    'Cost per merged PR': ['$3.67', 'median 10m', '−$2.33', 'good'],
    'Reverted or reworked': ['33%', '1 of 3 · 30-day watch', '+33 pts', 'bad'],
  });
});

// Protects: criterion 1. Fails when: a change is shown against an empty earlier window, or a job older than 30 days is counted in the numbers.
test('shows no change when the 30 days before had no jobs, and leaves out jobs older than 30 days', () => {
  const v = insightsView(page([run('j1', 3)], { [pr(1)]: merged() }));
  assert.deepEqual(v.tiles.map((x) => x.change), [undefined, undefined, undefined, undefined, undefined]);
  assert.equal(v.tiles[0]!.note, '1 of 1');
  assert.equal(insightsView(page([run('j1', 40)], { [pr(1)]: merged() })).none, true);
});

// Protects: criterion 1. Fails when: the scope switch does not name the factory and each project, or marks the wrong one.
test('the scope switch lists the factory and each project, with the address\'s scope on', () => {
  const v = insightsView(page([], {}, [], 'site'));
  assert.deepEqual(v.scopes, [
    { name: 'factory', href: '/insights?scope=factory', on: false }, { name: 'app', href: '/insights?scope=app', on: false }, { name: 'site', href: '/insights?scope=site', on: true },
  ]);
  assert.deepEqual([scopeOf('?scope=site'), scopeOf(''), route('/insights')], ['site', 'factory', { page: 'insights' }]);
});

// Protects: criterion 2. Fails when: a class row, a cause bar, an agent share or the review-finding share is wrong, or a dry run is counted as not delivering.
test('the tables: task classes, one bar per non-delivery cause, agents with the share of findings acted on', () => {
  const agents = (e1: number) => [
    { role: 'implementer', tier: 'sonnet', cost_usd: 3, calls: 1200, errors: e1 }, { role: 'reviewer', tier: 'opus', cost_usd: 1, calls: 100, errors: 0 },
  ];
  const v = insightsView(page(
    [
      run('j1', 2, { agents: agents(60), review: { findings: 4, acted_on: 3 } }), run('j2', 3, { size: 'small', difficulty: 'trivial', type: 'fix', cost_usd: 1 }),
      run('j3', 4, { outcome: 'failed', cause: 'gates', pr: undefined, gates: [{ ok: false, flaky: [] }], fix_rounds: 2 }),
      run('j4', 5, { outcome: 'needs-input', cause: 'needs-input', pr: undefined }), run('j5', 6, { outcome: 'dry-run', pr: undefined }),
    ],
    { [pr(1)]: merged(), [pr(2)]: { state: 'OPEN', human_commits: 0 } },
  ));
  assert.deepEqual(v.classes, [
    { name: 'medium · routine · feature', jobs: '4', merged: '100%', firstPass: '75%', perMerged: '$8.00' },
    { name: 'small · trivial · fix', jobs: '1', merged: '0%', firstPass: '100%', perMerged: '—' },
  ]);
  assert.deepEqual(v.causes, [{ label: 'Asked a question', count: 1, pct: 50, tone: 'ask' }, { label: 'Gates still failing', count: 1, pct: 50, tone: 'fail' }]);
  assert.equal(v.causeCount, '2 jobs');
  assert.deepEqual(v.agents, [{ role: 'implementer', tier: 'sonnet', cost: '75%', calls: '1,200', failed: '5%' }, { role: 'reviewer', tier: 'opus', cost: '25%', calls: '100', failed: '0%' }]);
  assert.equal(v.findings, '75% · 3 of 4');
});

// Protects: criterion 2. Fails when: flaky checks are not counted per check and project, or their last time is not the newest.
test('flaky checks say how often and when last', () => {
  const flaky = (name: string) => [{ ok: true, flaky: [name] }];
  const v = insightsView(page([run('j1', 1, { gates: flaky('test') }), run('j2', 6, { gates: flaky('test') }), run('j3', 3, { gates: flaky('lint') })], {}));
  assert.deepEqual(v.flaky, [{ name: 'test', times: '2 times', where: 'app · last 1d ago' }, { name: 'lint', times: '1 time', where: 'app · last 3d ago' }]);
});

// Protects: criterion 3. Fails when: a proposed lesson lacks its scope, jobs or accept command, or a kept lesson shows without its uses and days left, or an expired one shows.
test('proposed lessons give the command to accept them, kept ones their uses and days left', () => {
  const lesson = (id: number, over: Partial<InsightsLesson>): InsightsLesson => ({ id, text: `Lesson ${id}`, scope: 'project', project: 'app', cites: ['j1', 'j2'], status: 'proposed', uses: 0, expires: at(-60), ...over });
  const v = insightsView(page([], {}, [
    lesson(1, {}), lesson(2, { status: 'kept', uses: 4, expires: at(-12) }), lesson(3, { status: 'kept', scope: 'factory', uses: 0, expires: at(-1), cites: [] }), lesson(4, { status: 'kept', expires: at(1) }),
  ]));
  assert.deepEqual(v.proposed, [{ id: 1, text: 'Lesson 1', scope: 'app', source: 'Seen in 2 jobs: j1, j2', command: 'animus lessons accept 1' }]);
  assert.deepEqual(v.kept, [
    { id: 2, text: 'Lesson 2', uses: 'Used 4×', used: true, where: 'app · expires in 12d' },
    { id: 3, text: 'Lesson 3', uses: 'Used 0×', used: false, where: 'factory · expires in 1d' },
  ]);
});

/** A Helix with ana and ben, each with a home of run logs and outcomes of their own, and Helix's own home with a lessons file. */
async function helix() {
  const home = mkdtempSync(join(tmpdir(), 'insights-'));
  const homes: Record<string, string> = { ana: join(home, 'ana-home'), ben: join(home, 'ben-home') };
  const own = join(home, 'own-home');
  for (const dir of [...Object.values(homes), own]) mkdirSync(dir, { recursive: true });
  const line = (job: string, repo: string, ended: string) => JSON.stringify({ ...run(job, 0), repo, ended, gates: [{ attempt: 1, ok: true, ms: 1, checks: [] }] });
  writeFileSync(join(homes.ana!, 'runs.jsonl'), [line('j1', '/work/app', at(2)), line('j2', '/work/app', at(80))].join('\n') + '\n');
  writeFileSync(join(homes.ben!, 'runs.jsonl'), line('j3', '/work/site', at(4)) + '\n');
  writeFileSync(join(homes.ana!, 'outcomes.json'), JSON.stringify({ [pr(1)]: { pr: pr(1), job: 'j1', state: 'MERGED', opened: at(2), human_commits: 0, checked: at(1) } }));
  writeFileSync(join(own, 'lessons.json'), JSON.stringify({ next: 3, lessons: [
    { id: 1, text: 'For app', scope: 'project', project: 'app', agent: 'implementer', cites: ['j1'], status: 'proposed', created: at(1), uses: 0 },
    { id: 2, text: 'For site', scope: 'project', project: 'site', agent: 'implementer', cites: ['j3'], status: 'proposed', created: at(1), uses: 0 },
  ] }));
  process.env.ANIMUS_HOME = own;
  const config: Config = { host: '127.0.0.1', port: 0, slots: 0 };
  const store = openStore(join(home, 'helix.db'));
  store.putPerson('ana', { token_sha256: hashToken('ana-token') });
  store.putPerson('ben', { token_sha256: hashToken('ben-token') });
  const supervisor = supervise({ store, config, home, animusHomeOf: (p) => homes[p]! });
  const server = serve({ config, store, supervisor, home });
  await new Promise<void>((r) => { server.listen(0, '127.0.0.1', r); });
  const base = `http://127.0.0.1:${(server.address() as AddressInfo).port}`;
  const get = (path: string, token?: string) => fetch(new URL(path, base), token ? { headers: { authorization: `Bearer ${token}` } } : {});
  return { get, stop: () => { supervisor.stop(); server.close(); store.close(); } };
}

// Protects: criteria 1 and 3. Fails when: /insights-data answers without a person's token, leaves out a person's runs, keeps runs older than 60 days, or lets one project's scope show another's runs or lessons.
test('/insights-data needs a token and gives every person\'s runs of the last 60 days, for the factory or one project', async () => {
  const h = await helix();
  const anon = await h.get('/insights-data');
  const factory = await (await h.get('/insights-data', 'ben-token')).json() as InsightsPage;
  const site = await (await h.get('/insights-data?scope=site', 'ben-token')).json() as InsightsPage;
  h.stop();
  assert.equal(anon.status, 401);
  assert.deepEqual([factory.scope, factory.projects, factory.runs.map((r) => r.job).sort(), Object.keys(factory.outcomes)], ['factory', ['app', 'site'], ['j1', 'j3'], [pr(1)]]);
  assert.deepEqual([site.scope, site.projects, site.runs.map((r) => r.job), site.lessons.map((l) => l.text)], ['site', ['app', 'site'], ['j3'], ['For site']]);
});

// Protects: criterion 1 on the local display. Fails when: /insights-data is not served without a token, or /insights does not serve the page.
test('the local display serves /insights-data from this machine\'s runs, with no sign-in, and the page at /insights', async () => {
  const dir = mkdtempSync(join(tmpdir(), 'insights-local-'));
  writeFileSync(join(dir, 'runs.jsonl'), JSON.stringify({ ...run('j1', 1), gates: [{ attempt: 1, ok: true, ms: 1, checks: [] }] }) + '\n');
  process.env.ANIMUS_HOME = dir;
  const server = localServer();
  const port = await listenLocal(server, 0);
  const data = await (await fetch(`http://127.0.0.1:${port}/insights-data`)).json() as InsightsPage;
  const html = await fetch(`http://127.0.0.1:${port}/insights`, { headers: { accept: 'text/html' } });
  server.close();
  assert.deepEqual([data.scope, data.runs.map((r) => r.job), html.status], ['factory', ['j1'], 200]);
});
