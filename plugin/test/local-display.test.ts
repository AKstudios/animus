import assert from 'node:assert/strict';
import { spawn, spawnSync } from 'node:child_process';
import { mkdtempSync } from 'node:fs';
import http from 'node:http';
import type { AddressInfo } from 'node:net';
import { hostname, tmpdir } from 'node:os';
import { join } from 'node:path';
import { setTimeout as sleep } from 'node:timers/promises';
import { test } from 'node:test';
import { jobNotice, route } from '../display/pages.ts';
import type { Display, DisplayJob, JobPage } from '../display/shape.ts';
import { view } from '../display/view.ts';
import { listenLocal, localJobs, localServer } from '../src/local-display.ts';
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

test('an ended local job shows its run log row, with no way to resume', () => {
  saveState({ job: 'logged', repo: '/work/shop', spec: '', workspace: {} as JobState['workspace'], plan: {} as JobState['plan'], outcome: 'pr' });
  appendRun({ job: 'logged', repo: '/work/shop', submitter: 'me@example.com', title: 'Logged', started: '2026-01-01T00:00:00.000Z', ended: '2026-01-01T00:05:00.000Z', outcome: 'pr', pr: 'https://example.test/pr/9', cost_usd: 1.5 } as Run);
  const job = localJobs().find((j) => j.id === 'logged')!;
  assert.deepEqual([job.state, job.outcome, job.pr, job.title, job.person, job.resume], ['ended', 'pr', 'https://example.test/pr/9', 'Logged', 'me@example.com', undefined]);
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
  assert.deepEqual(page.checks?.map((c) => [c.name, c.status, c.output]), [['test', 'ok', undefined], ['lint', 'fail', 'bad style\n']]);
  assert.deepEqual(statuses, [404, 404]);
});

// Protects: the page is served for a job's address and not for people pages. Fails when: /people answers, or a job's address does not give the page to a browser.
test('the local display serves the page for a job and has no people pages', async () => {
  seed('some-job');
  const s = await served();
  const browser = { accept: 'text/html' };
  const [job, people, script] = await Promise.all([s.get('/jobs/some-job', browser), s.get('/people', browser), s.get('/ui/app.ts')]);
  s.stop();
  assert.equal(job.status, 200);
  assert.match(await job.text(), /<div id="helix"/);
  assert.equal(people.status, 404);
  assert.match(script.headers.get('content-type') ?? '', /javascript/);
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

// Protects: the page's reading of the display for the local source. Fails when: jobs are not grouped by project newest first, a stopped job does not say how to carry on, or a string id has no page.
test('the overview lists local jobs by project, a stopped one with its resume command, and string ids route to their page', () => {
  const at = (id: string, repo: string, state: DisplayJob['state'], submitted: string, over: Partial<DisplayJob> = {}): DisplayJob => ({ id, person: '', repo, title: id, submitted, state, ...over });
  const d: Display = {
    name: 'laptop', at: '2026-11-17T12:00:00Z', slots: 0, stages: ['setup'], local: true,
    repos: [{ name: 'shop' }, { name: 'blog' }],
    jobs: [at('c-2', 'blog', 'ended', '2026-11-17T11:00:00Z', { outcome: 'pr' }), at('a-9', 'shop', 'stopped', '2026-11-17T10:00:00Z', { resume: 'animus resume a-9' }), at('b-1', 'shop', 'ended', '2026-11-16T10:00:00Z', { outcome: 'failed' })],
  };
  const v = view(d, null, Date.parse(d.at));
  assert.deepEqual(v.byProject.map((g) => [g.project, g.jobs.map((j) => j.id)]), [['blog', ['c-2']], ['shop', ['a-9', 'b-1']]]);
  assert.deepEqual(v.byProject[1]!.jobs[0], { id: 'a-9', page: '/jobs/a-9', tag: 'STOPPED', tone: 'fail', title: 'a-9', meta: 'shop', reason: 'It stopped before it ended. To carry on: animus resume a-9' });
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
