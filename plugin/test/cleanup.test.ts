import assert from 'node:assert/strict';
import { existsSync, mkdirSync, mkdtempSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { test } from 'node:test';
import { claudeProjectDirs } from '../src/agent.ts';
import { cleanup, KEEP_DAYS, type PrEnd } from '../src/cleanup.ts';
import { fixTarget } from '../src/fix.ts';
import { jobDir, loadState } from '../src/log.ts';
import { runJob } from '../src/pipeline.ts';
import type { PrState } from '../src/pr.ts';
import { git, tryGit, AnimusError } from '../src/proc.ts';
import { clean, deps, done, fakeAgent, makeRepo, write, writeSpec } from './helpers.ts';

const DAY = 24 * 60 * 60 * 1000;
const LATER = Date.now() + (KEEP_DAYS + 1) * DAY;

/** A project with an origin, and one finished job on it whose branches are pushed as a real job's are. */
async function finishedJob(opts: { dryRun?: boolean; keep?: boolean } = {}) {
  const repo = makeRepo();
  const origin = join(mkdtempSync(join(tmpdir(), 'animus-origin-')), 'origin.git');
  git(repo, ['init', '-q', '--bare', origin]);
  git(repo, ['remote', 'add', 'origin', origin]);
  git(repo, ['push', '-q', 'origin', 'main']);
  const { agent, calls } = fakeAgent([(req) => { write(req.cwd, 'src/feature.txt', 'done\n'); return done(); }, () => clean()]);
  const run = await runJob({ repo, specFile: writeSpec('size: small\ndifficulty: routine\ntype: feature'), ...opts }, deps(agent));
  const branches = [`animus/${run.job}`, `animus-evidence/${run.job}`];
  if (!opts.dryRun) git(repo, ['push', '-q', 'origin', branches[0]!, `${branches[0]}:refs/heads/${branches[1]}`]);
  const left = () => ({
    local: branches.filter((b) => tryGit(repo, ['rev-parse', '--verify', '--quiet', `refs/heads/${b}`])),
    remote: branches.filter((b) => git(repo, ['ls-remote', '--heads', 'origin', b])),
    worktree: existsSync(calls[0]!.cwd),
    folder: existsSync(jobDir(run.job)),
  });
  return { job: run.job, left };
}

const only = (job: string, state: PrState | undefined, over: { days?: number; dryRun?: boolean; now?: number; named?: boolean; ended?: string } = {}) => {
  const { named, ended, ...opts } = over;
  // Other tests' jobs share the home: every job but this one has an open pull request, or none.
  const lookup: PrEnd = (url) => (url.endsWith('/pr/1') ? (state ? { state, ...(ended ? { ended } : {}) } : undefined) : { state: 'OPEN' });
  const results = cleanup({ ...opts, ...(named ? { jobs: [job] } : {}) }, lookup);
  return results.find((r) => r.job === job)!;
};

test('a job whose pull request merged or closed loses its worktree at once and its branches once the pull request ended long enough ago; its folder stays', async () => {
  for (const state of ['MERGED', 'CLOSED'] as const) {
    const { job, left } = await finishedJob({ keep: true });
    assert.deepEqual(left(), { local: [`animus/${job}`], remote: [`animus/${job}`, `animus-evidence/${job}`], worktree: true, folder: true });

    const first = only(job, state, { ended: new Date().toISOString() });
    assert.deepEqual(left(), { local: [`animus/${job}`], remote: [`animus/${job}`, `animus-evidence/${job}`], worktree: false, folder: true });
    assert.equal(first.removed.length, 1);
    assert.match(first.kept!, new RegExp(`branches stay until ${KEEP_DAYS} day`));

    // Long after the job last ran, a pull request that ended lately still keeps them.
    assert.deepEqual(only(job, state, { now: LATER, ended: new Date(LATER - DAY).toISOString() }).removed, []);
    const later = only(job, state, { now: LATER, ended: new Date().toISOString() });
    assert.deepEqual(later.removed, [`origin/animus/${job}`, `origin/animus-evidence/${job}`, `branch animus/${job}`]);
    assert.equal(later.kept, undefined);
    assert.deepEqual(left(), { local: [], remote: [], worktree: false, folder: true });
  }
});

test('a job with an open pull request, or one whose state cannot be read, is left alone even when named and old', async () => {
  for (const state of ['OPEN', undefined] as const) {
    const { job, left } = await finishedJob();
    const before = left();
    const result = only(job, state, { named: true, now: LATER });
    assert.deepEqual(result.removed, []);
    assert.match(result.kept!, state ? /is open/ : /could not be read/);
    assert.deepEqual(left(), before);
  }
});

test('a job that never had a pull request keeps everything while it is recent; once old its branches go and its folder stays, and named it goes whole', async () => {
  const { job, left } = await finishedJob({ dryRun: true });
  assert.match(only(job, undefined).kept!, /no pull request/);
  assert.deepEqual([left().local.length, left().folder], [1, true]);

  only(job, undefined, { now: LATER });
  assert.deepEqual(left(), { local: [], remote: [], worktree: false, folder: true });

  only(job, undefined, { named: true });
  assert.equal(left().folder, false);
});

test('--dry-run says what would go and removes nothing; an unknown job is an error', async () => {
  const { job, left } = await finishedJob();
  const before = left();
  const result = only(job, 'MERGED', { dryRun: true, named: true });
  assert.deepEqual(result.removed, [`origin/animus/${job}`, `origin/animus-evidence/${job}`, `branch animus/${job}`, `folder ${jobDir(job)}`]);
  assert.deepEqual(left(), before);
  assert.throws(() => cleanup({ jobs: ['no-such-job'] }, () => ({ state: 'MERGED' })), AnimusError);
});

test('the transcripts Claude Code kept of a job\'s sessions are never removed: they are part of its record', async () => {
  const { job } = await finishedJob({ keep: true });
  const [transcripts] = claudeProjectDirs(loadState(job)!.workspace.worktree);
  mkdirSync(transcripts!, { recursive: true });
  writeFileSync(join(transcripts!, 'session-1.jsonl'), '{}\n');
  only(job, 'MERGED', { now: LATER });
  only(job, 'MERGED', { named: true });
  assert.equal(existsSync(transcripts!), true);
});

test('a job waiting for an answer is kept however old, until it is named', async () => {
  const repo = makeRepo();
  const { agent } = fakeAgent([() => ({ output: { status: 'needs-input', summary: '', question: 'Done, or finished?' } })]);
  const run = await runJob({ repo, specFile: writeSpec('size: small\ndifficulty: routine\ntype: feature') }, deps(agent));
  assert.equal(run.outcome, 'needs-input');

  const kept = only(run.job, undefined, { now: LATER });
  assert.deepEqual(kept.removed, []);
  assert.match(kept.kept!, /waiting for an answer/);
  assert.equal(existsSync(jobDir(run.job)), true);

  only(run.job, undefined, { named: true });
  assert.equal(existsSync(jobDir(run.job)), false);
});

// Protects: criterion 7. Fails when: cleanup removes the worktree and branch a fix still waits on because the pull request it updates has since merged, or the fix's own job is treated as having no pull request.
test('a worktree and branch stay while a fix of their pull request waits for an answer, even after the pull request merged', async () => {
  const repo = makeRepo();
  const { agent } = fakeAgent([(req) => { write(req.cwd, 'src/feature.txt', 'done\n'); git(req.cwd, ['add', '-A']); git(req.cwd, ['commit', '-qm', 'say done']); return done(); }, () => clean()]);
  const first = await runJob({ repo, specFile: writeSpec('size: small\ndifficulty: routine\ntype: feature'), keep: true }, deps(agent));
  const { run, state } = fixTarget(repo, '1', () => 'OPEN');
  const asking = fakeAgent([() => ({ output: { status: 'needs-input', summary: '', question: 'Which one?' } })]);
  const fix = await runJob({ repo, fix: { of: run.job, from: state!, ask: 'Say it twice', pr: run.pr! } }, deps(asking.agent));
  assert.equal(fix.outcome, 'needs-input');

  const kept = only(first.job, 'MERGED', { now: LATER, ended: new Date(LATER - 40 * DAY).toISOString() });
  assert.deepEqual(kept.removed, []);
  assert.match(kept.kept!, new RegExp(`fix ${fix.job} is waiting for an answer`));
  assert.equal(tryGit(repo, ['rev-parse', '--verify', '--quiet', `refs/heads/animus/${first.job}`]) !== undefined, true);
  assert.equal(existsSync(loadState(fix.job)!.workspace.worktree), true);

  // Once the fix is gone the pull request's end counts for the job again.
  only(fix.job, 'MERGED', { named: true });
  assert.equal(only(first.job, 'MERGED', { now: LATER, ended: new Date(LATER - 40 * DAY).toISOString() }).kept, undefined);
  assert.equal(tryGit(repo, ['rev-parse', '--verify', '--quiet', `refs/heads/animus/${first.job}`]), undefined);
});

// Protects: criterion 7. Fails when: a fix that failed, whose run holds no pull request, is taken for a job with none and takes the open pull request's branch with it.
test('a failed fix counts as its pull request\'s: its branch stays while the pull request is open', async () => {
  const repo = makeRepo();
  const { agent } = fakeAgent([(req) => { write(req.cwd, 'src/feature.txt', 'done\n'); git(req.cwd, ['add', '-A']); git(req.cwd, ['commit', '-qm', 'say done']); return done(); }, () => clean()]);
  const first = await runJob({ repo, specFile: writeSpec('size: small\ndifficulty: routine\ntype: feature'), keep: true }, deps(agent));
  const { run, state } = fixTarget(repo, '1', () => 'OPEN');
  const fix = await runJob({ repo, fix: { of: run.job, from: state!, ask: 'Say it twice', pr: run.pr! } }, deps(fakeAgent([() => done()]).agent));
  assert.equal(fix.outcome, 'failed');

  const kept = only(fix.job, 'OPEN', { now: LATER });
  assert.deepEqual(kept.removed, []);
  assert.match(kept.kept!, /is open/);
  assert.equal(tryGit(repo, ['rev-parse', '--verify', '--quiet', `refs/heads/animus/${first.job}`]) !== undefined, true);
});
