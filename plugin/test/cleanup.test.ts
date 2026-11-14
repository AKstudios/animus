import assert from 'node:assert/strict';
import { existsSync, mkdtempSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { test } from 'node:test';
import { cleanup, KEEP_DAYS } from '../src/cleanup.ts';
import { jobDir } from '../src/log.ts';
import { runJob } from '../src/pipeline.ts';
import type { PrState } from '../src/pr.ts';
import { git, tryGit, AnimusError } from '../src/proc.ts';
import { clean, deps, done, fakeAgent, makeRepo, write, writeSpec } from './helpers.ts';

const LATER = Date.now() + (KEEP_DAYS + 1) * 24 * 60 * 60 * 1000;

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

const only = (job: string, state: PrState | undefined, over: { days?: number; dryRun?: boolean; now?: number; named?: boolean } = {}) => {
  const { named, ...opts } = over;
  // Other tests' jobs share the home: every job but this one has an open pull request, or none.
  const results = cleanup({ ...opts, ...(named ? { jobs: [job] } : {}) }, (url) => (url.endsWith('/pr/1') ? state : 'OPEN'));
  return results.find((r) => r.job === job)!;
};

test('a job whose pull request merged or closed loses its branches here and on origin and its worktree; its folder goes once it is old', async () => {
  for (const state of ['MERGED', 'CLOSED'] as const) {
    const { job, left } = await finishedJob({ keep: true });
    assert.deepEqual(left(), { local: [`animus/${job}`], remote: [`animus/${job}`, `animus-evidence/${job}`], worktree: true, folder: true });

    const first = only(job, state);
    assert.deepEqual(left(), { local: [], remote: [], worktree: false, folder: true });
    assert.equal(first.removed.length, 4);
    assert.match(first.kept!, /its folder stays until 14 day/);

    assert.deepEqual(only(job, state, { now: LATER }).removed, [`folder ${jobDir(job)}`]);
    assert.equal(left().folder, false);
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

test('a job that never had a pull request is kept while it is recent, and goes whole once it is old or named', async () => {
  for (const how of [{ now: LATER }, { named: true }]) {
    const { job, left } = await finishedJob({ dryRun: true });
    assert.match(only(job, undefined).kept!, /no pull request/);
    assert.deepEqual([left().local.length, left().folder], [1, true]);

    only(job, undefined, how);
    assert.deepEqual(left(), { local: [], remote: [], worktree: false, folder: false });
  }
});

test('--dry-run says what would go and removes nothing; an unknown job is an error', async () => {
  const { job, left } = await finishedJob();
  const before = left();
  const result = only(job, 'MERGED', { dryRun: true, named: true });
  assert.deepEqual(result.removed, [`origin/animus/${job}`, `origin/animus-evidence/${job}`, `branch animus/${job}`, `folder ${jobDir(job)}`]);
  assert.deepEqual(left(), before);
  assert.throws(() => cleanup({ jobs: ['no-such-job'] }, () => 'MERGED'), AnimusError);
});
