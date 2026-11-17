import assert from 'node:assert/strict';
import { spawnSync } from 'node:child_process';
import { hostname } from 'node:os';
import { join } from 'node:path';
import { test } from 'node:test';
import { localJobs } from '../src/local-display.ts';
import { appendRun, jobDir, loadProgress, saveProgress, saveState, writeJson, type JobState, type Run } from '../src/log.ts';
import { runJob } from '../src/pipeline.ts';
import { git } from '../src/proc.ts';
import { clean, deps, done, fakeAgent, makeRepo, write, writeSpec, type Step } from './helpers.ts';

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
