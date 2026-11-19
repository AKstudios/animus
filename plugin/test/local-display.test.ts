import assert from 'node:assert/strict';
import { spawn, spawnSync } from 'node:child_process';
import { appendFileSync, mkdirSync, mkdtempSync, rmSync } from 'node:fs';
import http from 'node:http';
import type { AddressInfo } from 'node:net';
import { hostname, tmpdir } from 'node:os';
import { join } from 'node:path';
import { setTimeout as sleep } from 'node:timers/promises';
import { test } from 'node:test';
import { jobView } from '../display/job-view.ts';
import { jobListView } from '../display/job-list.ts';
import { jobNotice, peopleNotice, personNotice, route } from '../display/pages.ts';
import type { Display, DisplayJob, JobListPage, JobPage } from '../display/shape.ts';
import { view } from '../display/view.ts';
import { listenLocal, localJobs, localServer } from '../src/local-display.ts';
import { outcomesFile } from '../src/outcomes.ts';
import { appendRun, jobDir, loadProgress, saveProgress, saveState, writeJson, type JobState, type Run } from '../src/log.ts';
import { runJob } from '../src/pipeline.ts';
import { git } from '../src/proc.ts';
import { clean, cli, deps, done, fakeAgent, fakeOpener, makeRepo, write, writeSpec, type Step } from './helpers.ts';

const SMALL = 'size: small\ndifficulty: routine\ntype: feature';

// Protects: `animus run` records its process. Fails when progress.json carries no pid or host.
test('a running job records its pid and host in progress.json', async () => {
  const repo = makeRepo();
  const say: Step = (req) => {
    write(req.cwd, 'src/feature.txt', 'done\n');
    git(req.cwd, ['add', '-A']);
    git(req.cwd, ['commit', '-qm', 'say done']);
    return done();
  };
  const run = await runJob({ repo, specFile: writeSpec(SMALL) }, deps(fakeAgent([say, () => clean()]).agent));
  assert.deepEqual([loadProgress(run.job)!.pid, loadProgress(run.job)!.host], [process.pid, hostname()]);
});

/** A pid that belonged to a process that has exited. */
const deadPid = () => Number(spawnSync(process.execPath, ['-p', 'process.pid'], { encoding: 'utf8' }).stdout);

function seed(job: string, over: { pid?: number; host?: string; outcome?: JobState['outcome'] } = {}): void {
  write(jobDir(job), 'spec.md', `---\n${SMALL}\n---\n# Title of ${job}\n`);
  saveState({ job, repo: '/work/shop', spec: join(jobDir(job), 'spec.md'), workspace: {} as JobState['workspace'], plan: {} as JobState['plan'], ...(over.outcome ? { outcome: over.outcome } : {}) });
  saveProgress(job, 'implement', 'implementer');
  const p = loadProgress(job)!;
  writeJson(join(jobDir(job), 'progress.json'), { ...p, pid: over.pid ?? process.pid, host: over.host ?? hostname() });
}

// Protects: a job is running only on this host with a live process. Fails when a dead or foreign pid, or an outcome, still reads as running.
for (const [name, over, state, resume] of [
  ['alive-here', {}, 'running', undefined],
  ['dead-process', { pid: deadPid() }, 'stopped', 'animus resume dead-process'],
  ['other-host', { host: 'elsewhere.example' }, 'stopped', 'animus resume other-host'],
  ['has-outcome', { pid: deadPid(), outcome: 'failed' as const }, 'ended', undefined],
] as const) {
  test(`a local job with ${name} shows as ${state}`, () => {
    seed(name, over);
    const job = localJobs().find((j) => j.id === name)!;
    assert.equal(job.state, state);
    assert.equal(job.resume, resume);
    assert.equal(job.repo, 'shop');
    assert.equal(job.title, `Title of ${name}`);
  });
}

// Protects: a local job names its person, never by address. Fails when: the run log's email address is shown.
test('an ended local job shows its run log row, with no way to resume', () => {
  saveState({ job: 'logged', repo: '/work/shop', spec: '', workspace: {} as JobState['workspace'], plan: {} as JobState['plan'], outcome: 'pr' });
  appendRun({ job: 'logged', repo: '/work/shop', submitter: 'me@example.com', title: 'Logged', started: '2026-01-01T00:00:00.000Z', ended: '2026-01-01T00:05:00.000Z', outcome: 'pr', pr: 'https://example.test/pr/9', cost_usd: 1.5 } as Run);
  const job = localJobs().find((j) => j.id === 'logged')!;
  assert.deepEqual([job.state, job.outcome, job.pr, job.title, job.person, job.resume], ['ended', 'pr', 'https://example.test/pr/9', 'Logged', 'me', undefined]);
});

// Protects: a person is shown by name. Fails when the address, or the git name the run recorded, is not what shows.
test('a local job shows its person by the recorded git name, else the part of the address before the @', () => {
  for (const [job, extra] of [['named', { submitter_name: 'Ana Lima' }], ['unnamed', {}]] as const) {
    saveState({ job, repo: '/work/shop', spec: '', workspace: {} as JobState['workspace'], plan: {} as JobState['plan'], outcome: 'pr' });
    appendRun({ job, repo: '/work/shop', submitter: 'ana@example.com', title: job, started: '2026-01-01T00:00:00.000Z', ended: '2026-01-01T00:05:00.000Z', outcome: 'pr', cost_usd: 1, ...extra } as Run);
  }
  const person = (id: string) => localJobs().find((j) => j.id === id)!.person;
  assert.deepEqual([person('named'), person('unnamed')], ['Ana Lima', 'ana']);
});

// Protects: a running job's page names its person and its start. Fails when person is empty or started is missing while cost stays unknown.
test('a running local job has a person and a start, and no cost', () => {
  seed('running-now');
  const job = localJobs().find((j) => j.id === 'running-now')!;
  assert.equal(job.state, 'running');
  assert.notEqual(job.person, '');
  assert.ok(!job.person.includes('@'));
  assert.ok(Date.now() - Date.parse(job.started!) < 60_000);
  assert.equal(job.cost_usd, undefined);
});

// Protects: `animus resume` is offered only for a job with state.json. Fails when a run that stopped before saveState (progress.json only) gets a resume command or an empty project name.
test('a local job with progress but no state shows as stopped during setup, with no resume and a named project', () => {
  saveProgress('setup-only', 'setup', 'script');
  writeJson(join(jobDir('setup-only'), 'progress.json'), { ...loadProgress('setup-only')!, pid: deadPid() });
  const job = localJobs().find((j) => j.id === 'setup-only')!;
  assert.deepEqual([job.state, job.resume, job.repo], ['stopped', undefined, 'unknown project']);
  assert.match(job.reason!, /during setup/);
});

// ---- the local display's server and page

/** The local display on a free port, over the jobs seeded so far. */
async function served() {
  const server = localServer();
  const port = await listenLocal(server, 0);
  const get = (path: string, headers: Record<string, string> = {}) => fetch(`http://127.0.0.1:${port}${path}`, { headers });
  return { port, server, get, stop: () => server.close() };
}

// Protects: `animus ui` lists this machine's jobs in Helix's shape, by project. Fails when: a job is missing, the project list is wrong, or the answer claims to be Helix's.
test('the local display answers /display with every job, newest first, and a project for each repo', async () => {
  seed('older-job');
  saveState({ job: 'newer-job', repo: '/work/blog', spec: '', workspace: {} as JobState['workspace'], plan: {} as JobState['plan'], outcome: 'pr' });
  appendRun({ job: 'newer-job', repo: '/work/blog', submitter: 'me@example.com', title: 'Newer', started: '2099-01-01T00:00:00.000Z', ended: '2099-01-01T00:05:00.000Z', outcome: 'pr', cost_usd: 1 } as Run);
  const s = await served();
  const d = (await (await s.get('/display')).json()) as Display;
  s.stop();
  assert.equal(d.local, true);
  assert.deepEqual(d.jobs.slice(0, 2).map((j) => j.id), ['newer-job', 'older-job']);
  assert.ok(d.repos.some((r) => r.name === 'blog') && d.repos.some((r) => r.name === 'shop'));
});

// Protects: each local job has its page, read without a token. Fails when: the page needs sign-in, drops the checks, or serves a job that is not there.
test('a local job page answers with no token, with its checks, spec and run; unknown and odd ids are 404', async () => {
  seed('with-gates');
  write(jobDir('with-gates'), 'gates/run-1.txt', 'ok   test: npm test (2s)\nFAIL lint: npm run lint (1s)\n\n=== test: npm test\nfine\n=== lint: npm run lint\nbad style\n');
  const s = await served();
  const page = (await (await s.get('/jobs/with-gates/page-data')).json()) as JobPage;
  const statuses = await Promise.all(['/jobs/nope/page-data', '/jobs/..%2Fescape/page-data'].map(async (p) => (await s.get(p)).status));
  s.stop();
  assert.equal(page.job.id, 'with-gates');
  assert.match(page.spec ?? '', /Title of with-gates/);
  assert.deepEqual(page.checks?.map((c) => [c.name, c.status, c.output]), [['test', 'ok', 'fine'], ['lint', 'fail', 'bad style\n']]);
  assert.deepEqual(statuses, [404, 404]);
});

// Protects: the page is served for a job's address and for people addresses, so a browser never lands on raw JSON. Fails when: /people answers an error, or a job's address does not give the page to a browser.
test('the local display serves the page for a job and for people addresses, and their data', async () => {
  seed('some-job');
  const s = await served();
  const browser = { accept: 'text/html' };
  const [job, people, person, data, script] = await Promise.all([s.get('/jobs/some-job', browser), s.get('/people', browser), s.get('/people/ana', browser), s.get('/people/page-data'), s.get('/ui/app.ts')]);
  s.stop();
  assert.equal(job.status, 200);
  assert.match(await job.text(), /<div id="helix"/);
  assert.deepEqual([people.status, person.status, data.status], [200, 200, 200]);
  assert.match(await people.text(), /<div id="helix"/);
  assert.match(script.headers.get('content-type') ?? '', /javascript/);
});

// Protects: what the local display says where it lacks something. Fails when: the header still links to people, a job's PR has no number or link, the people pages or the log do not say where the rest is.
test('the local display names a job by its PR, links it, has people pages, and says where the log is not', () => {
  const d: Display = {
    name: 'laptop', at: '2026-11-17T12:00:00Z', slots: 0, stages: ['setup'], local: true, repos: [{ name: 'shop' }],
    jobs: [
      { id: 'a-1', person: '', repo: 'shop', title: 'a', submitted: '2026-11-17T10:00:00Z', state: 'ended', outcome: 'draft-pr', pr: 'https://github.com/o/shop/pull/8' },
      { id: 'a-2', person: '', repo: 'shop', title: 'b', submitted: '2026-11-17T09:00:00Z', state: 'ended', outcome: 'pr' },
    ],
    prs: [{ job: 'a-1', repo: 'shop', person: '', number: 8, title: 'a', url: 'https://github.com/o/shop/pull/8', draft: true, created: '2026-11-17T10:00:00Z' }],
  };
  const v = view(d, null, Date.parse(d.at));
  assert.deepEqual([v.prs.map((p) => [p.tag, p.href]), v.finished.map((j) => [j.tag, j.href])], [[['Draft #8', 'https://github.com/o/shop/pull/8']], [['PR', undefined]]]);
  assert.equal(v.people, true);
  assert.equal(peopleNotice(false, undefined, true), undefined);
  assert.equal(personNotice('ana', false, undefined, true), undefined);
  assert.match(personNotice('ana', false, 404, true) ?? '', /No job on this machine names ana/);
  const page = jobView({ at: d.at, stages: d.stages, job: d.jobs[0]!, log: '' }, 0, true);
  assert.match(page.noLog, /went to the terminal it ran in/);
});

// Protects: one bad request does not end the display. Fails when: an unreadable run log ends the server, or answers with anything but a 500 and a one-line reason.
test('an error in one request is a 500 with a one-line reason, and the display keeps serving', async () => {
  const home = process.env.ANIMUS_HOME!;
  const own = mkdtempSync(join(tmpdir(), 'animus-500-'));
  process.env.ANIMUS_HOME = own;
  mkdirSync(join(own, 'runs.jsonl'));
  const s = await served();
  const bad = await s.get('/display');
  const { error } = (await bad.json()) as { error: string };
  rmSync(join(own, 'runs.jsonl'), { recursive: true });
  const after = await s.get('/display');
  s.stop();
  process.env.ANIMUS_HOME = home;
  assert.equal(bad.status, 500);
  assert.ok(error && !error.includes('\n'));
  assert.equal(after.status, 200);
});

// Protects: criterion 6. Fails when: a run-log line with no repo, or not JSON, breaks the display or shows on it.
test('run-log lines with no repo or that do not parse are left out of the display', async () => {
  const file = join(process.env.ANIMUS_HOME!, 'runs.jsonl');
  mkdirSync(process.env.ANIMUS_HOME!, { recursive: true });
  appendFileSync(file, `${JSON.stringify({ job: 'leaked', started: '2026-01-01T00:00:00.000Z', ended: '2026-01-01T00:05:00.000Z', outcome: 'pr' })}\n{not json\n`);
  saveState({ job: 'fine', repo: '/work/shop', spec: '', workspace: {} as JobState['workspace'], plan: {} as JobState['plan'], outcome: 'pr' });
  appendRun({ job: 'fine', repo: '/work/shop', submitter: 'me@example.com', title: 'Fine', started: '2026-01-01T00:00:00.000Z', ended: '2026-01-01T00:05:00.000Z', outcome: 'pr', cost_usd: 1 } as Run);
  const s = await served();
  const res = await s.get('/display');
  s.stop();
  assert.equal(res.status, 200);
  const ids = ((await res.json()) as Display).jobs.map((j) => j.id);
  assert.ok(ids.includes('fine') && !ids.includes('leaked'));
});

// Protects: only loopback names are answered. Fails when: a page on another site, resolving its own name to 127.0.0.1, can read the jobs.
test('the local display refuses a request for any other host name', async () => {
  const s = await served();
  const res = await new Promise<number | undefined>((resolve) => {
    http.get({ host: '127.0.0.1', port: s.port, path: '/display', headers: { host: 'evil.example' } }, (r) => { r.resume(); resolve(r.statusCode); });
  });
  s.stop();
  assert.equal(res, 403);
});

// Protects: the port is 7420 or the next free one. Fails when: a taken port stops the display, or it listens beyond loopback.
test('the local display takes the next free port, on 127.0.0.1', async () => {
  const taken = http.createServer();
  const first = await listenLocal(taken, 0);
  const next = localServer();
  const port = await listenLocal(next, first);
  const address = next.address() as AddressInfo;
  next.close(); taken.close();
  assert.ok(port > first);
  assert.equal(address.address, '127.0.0.1');
});

// Protects: the page's reading of the display for the local source. Fails when: a job shows twice or in the wrong section, a stopped job does not say how to carry on, or a string id has no page.
test('the overview lists local jobs in the sections Helix has, a stopped one with its resume command, and string ids route to their page', () => {
  const at = (id: string, repo: string, state: DisplayJob['state'], submitted: string, over: Partial<DisplayJob> = {}): DisplayJob => ({ id, person: '', repo, title: id, submitted, state, ...over });
  const d: Display = {
    name: 'laptop', at: '2026-11-17T12:00:00Z', slots: 0, stages: ['setup'], local: true,
    repos: [{ name: 'shop' }, { name: 'blog' }],
    jobs: [at('c-2', 'blog', 'ended', '2026-11-17T11:00:00Z', { outcome: 'pr' }), at('a-9', 'shop', 'stopped', '2026-11-17T10:00:00Z', { resume: 'animus resume a-9' }), at('b-1', 'shop', 'ended', '2026-11-16T10:00:00Z', { outcome: 'failed' })],
  };
  const v = view(d, null, Date.parse(d.at));
  assert.deepEqual(v.finished.map((j) => j.id), ['c-2', 'a-9', 'b-1']);
  assert.deepEqual(v.finished[1], { id: 'a-9', page: '/jobs/a-9', tag: 'Stopped', tone: 'fail', title: 'a-9', repo: 'shop', person: '', meta: '', reason: 'It stopped before it ended. To carry on: animus resume a-9' });
  assert.deepEqual(route('/jobs/a-9'), { page: 'job', id: 'a-9' });
  assert.deepEqual(route('/jobs/12'), { page: 'job', id: 12 });
  assert.equal(jobNotice('a-9', false, undefined, true), undefined);
});

// Protects: `animus ui` end to end. Fails when: it prints no address, opens none, serves nothing there, or does not stop on Ctrl-C.
test('animus ui opens the display on 127.0.0.1 and stops on Ctrl-C', async () => {
  const opener = fakeOpener();
  const home = mkdtempSync(join(tmpdir(), 'animus-home-'));
  const child = spawn(process.execPath, ['--disable-warning=ExperimentalWarning', cli, 'ui'], { env: { ...process.env, ANIMUS_HOME: home, PATH: opener.path } });
  let err = '';
  child.stderr.on('data', (c: Buffer) => { err += c.toString(); });
  const exited = new Promise<number | null>((r) => child.on('exit', r));
  let url: string | undefined;
  for (let i = 0; i < 100 && !url; i++) { url = /http:\/\/127\.0\.0\.1:\d+/.exec(err)?.[0]; if (!url) await sleep(100); }
  assert.ok(url, err);
  const d = (await (await fetch(`${url}/display`)).json()) as Display;
  child.kill('SIGINT');
  assert.deepEqual([d.local, await opener.opened(), await exited], [true, url, 0]);
});

// Protects: criterion 5. Fails when: the local Jobs page lists a job another machine ran, ignores outcomes.json for merged and closed, or filters by person.
test('the local /job-list tags merged and closed PRs from outcomes.json and filters by result and project, with no person filter', async () => {
  for (const [job, repo, n] of [['pr-merged', 'shop', 1], ['pr-closed', 'shop', 2], ['pr-unknown', 'wiki', 3]] as const) {
    saveState({ job, repo: `/work/${repo}`, spec: '', workspace: {} as JobState['workspace'], plan: {} as JobState['plan'], outcome: 'pr' });
    appendRun({ job, repo: `/work/${repo}`, submitter: 'me@example.com', title: job, started: `2026-01-01T00:0${n}:00.000Z`, ended: `2026-01-01T00:0${n}:30.000Z`, outcome: 'pr', pr: `https://github.com/o/shop/pull/${n}`, cost_usd: 1 } as Run);
  }
  writeJson(outcomesFile(), {
    'https://github.com/o/shop/pull/1': { pr: 'https://github.com/o/shop/pull/1', job: 'pr-merged', state: 'MERGED' },
    'https://github.com/o/shop/pull/2': { pr: 'https://github.com/o/shop/pull/2', job: 'pr-closed', state: 'CLOSED' },
  });
  const s = await served();
  const list = async (q: string) => (await (await s.get(`/job-list${q}`)).json()) as JobListPage;
  const all = await list('');
  const merged = await list('?result=merged');
  const wiki = await list('?project=wiki&person=somebody');
  const bad = (await s.get('/job-list?result=bogus')).status;
  const shown = (await (await s.get('/display')).json()) as Display;
  s.stop();
  // The overview reads the same outcomes: its rows say merged and closed too.
  const o = view(shown, null, Date.now());
  const overview = Object.fromEntries([...o.finished, ...o.prs].map((r) => [r.title, [r.tag, 'tone' in r ? r.tone : 'open']]));
  assert.deepEqual([overview['pr-merged'], overview['pr-closed'], overview['pr-unknown']], [['Merged #1', 'merged'], ['Closed #2', 'mute'], ['Open #3', 'open']]);
  assert.deepEqual(o.prs.map((p) => p.title).filter((t) => t.startsWith('pr-')), ['pr-unknown']);
  const tags = Object.fromEntries(jobListView(all, true).rows.map((r) => [r.title, r.tag]));
  assert.deepEqual([tags['pr-merged'], tags['pr-closed'], tags['pr-unknown']], ['Merged #1', 'Closed #2', 'PR #3']);
  assert.deepEqual([merged.jobs.map((j) => j.id), wiki.jobs.map((j) => j.id), bad], [['pr-merged'], ['pr-unknown'], 400]);
  assert.equal(jobListView(all, true).rows.every((r) => !r.person || r.personPage === `/people/${encodeURIComponent(r.person)}`), true);
  // Totals cover the whole filter, not the page: the project filter changes them.
  assert.deepEqual([all.totals.merged, wiki.totals.jobs, wiki.totals.merged], [1, 1, 0]);
});

// Protects: a local fix names the job it continues. Fails when fix_of or that job's title is lost.
test('a local fix carries the id and title of the job it fixes', () => {
  const run = (job: string, over: Partial<Run>) => appendRun({ job, repo: '/work/shop', submitter: 'me@example.com', title: `Title ${job}`, started: '2026-01-01T00:00:00.000Z', ended: '2026-01-01T00:05:00.000Z', outcome: 'pr', pr: 'https://example.test/pr/9', cost_usd: 1, ...over } as Run);
  saveState({ job: 'opens-pr', repo: '/work/shop', spec: '', workspace: {} as JobState['workspace'], plan: {} as JobState['plan'], outcome: 'pr' });
  saveState({ job: 'fixes-pr', repo: '/work/shop', spec: '', workspace: {} as JobState['workspace'], plan: {} as JobState['plan'], outcome: 'pr' });
  run('opens-pr', {});
  run('fixes-pr', { fix_of: 'opens-pr' });
  const jobs = localJobs();
  const pick = (id: string) => { const j = jobs.find((x) => x.id === id)!; return [j.fix_of, j.fix_of_title]; };
  assert.deepEqual([pick('opens-pr'), pick('fixes-pr')], [[undefined, undefined], ['opens-pr', 'Title opens-pr']]);
});

// Protects: criteria 1, 2 and 9 on the local display. Fails when: the git name is not the person, tokens of a job's runs are not added, a person's page lacks their usage, or an unknown person is not a 404.
test('local people are named by git user name, with tokens and usage, and an unknown name has no page', async () => {
  const tok = (input: number) => ({ input, output: 1, cache_read: 2, cache_write: 3 });
  saveState({ job: 'named', repo: '/work/shop', spec: '', workspace: {} as JobState['workspace'], plan: {} as JobState['plan'], outcome: 'pr' });
  const base = { job: 'named', repo: '/work/shop', submitter: 'zed@example.com', submitter_name: 'Zed Quill', title: 'Named', outcome: 'pr', cost_usd: 1, agents: [] };
  appendRun({ ...base, started: '2026-01-01T00:00:00.000Z', ended: '2026-01-01T00:05:00.000Z', tokens: tok(10) } as unknown as Run);
  appendRun({ ...base, started: '2026-01-01T01:00:00.000Z', ended: '2026-01-01T01:05:00.000Z', tokens: tok(20) } as unknown as Run);
  const s = await served();
  const [people, person, nobody] = await Promise.all([s.get('/people/page-data'), s.get('/people/Zed%20Quill/page-data'), s.get('/people/nobody/page-data')]);
  s.stop();
  const job = localJobs().find((j) => j.id === 'named')!;
  assert.deepEqual([job.person, job.tokens, job.started], ['Zed Quill', 42, '2026-01-01T01:00:00.000Z']);
  assert.ok(((await people.json()) as { people: { name: string }[] }).people.some((p) => p.name === 'Zed Quill'));
  assert.deepEqual([person.status, ((await person.json()) as { usage: { runs: number } }).usage.runs, nobody.status], [200, 2, 404]);
});
