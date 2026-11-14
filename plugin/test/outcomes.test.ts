import assert from 'node:assert/strict';
import { test } from 'node:test';
import type { Run } from '../src/log.ts';
import { numbers, refreshOutcomes, type Outcomes } from '../src/outcomes.ts';
import { runJob } from '../src/pipeline.ts';
import type { PrFacts } from '../src/pr.ts';
import { git } from '../src/proc.ts';
import { clean, deps, done, fakeAgent, makeRepo, write, writeSpec } from './helpers.ts';

const DAY = 24 * 60 * 60 * 1000;
let prs = 0;

/** A job whose pull request was merged into main with a merge commit. */
async function mergedJob() {
  const repo = makeRepo();
  const url = `https://example.test/pr/${++prs}`;
  const { agent } = fakeAgent([(req) => { write(req.cwd, 'src/feature.txt', 'one\ndone\nthree\n'); return done(); }, () => clean()]);
  const run = await runJob({ repo, specFile: writeSpec('size: small\ndifficulty: routine\ntype: feature') }, deps(agent, { publish: () => url }));
  git(repo, ['merge', '-q', '--no-ff', '-m', 'Merge the job', run.branch]);
  const mergedAt = new Date().toISOString();
  const facts: PrFacts = { state: 'MERGED', createdAt: new Date(Date.parse(mergedAt) - 90_000).toISOString(), mergedAt, mergeCommit: git(repo, ['rev-parse', 'HEAD']), baseRefName: 'main', commits: [run.started] };
  const commit = (file: string, text: string, daysLater = 1) => {
    write(repo, file, text);
    process.env.GIT_COMMITTER_DATE = new Date(Date.parse(mergedAt) + daysLater * DAY).toISOString();
    try { git(repo, ['add', '-A']); git(repo, ['commit', '-qm', `change ${file}`]); } finally { delete process.env.GIT_COMMITTER_DATE; }
  };
  const read = (f: PrFacts = facts, now?: number) => refreshOutcomes((pr) => (pr === url ? f : undefined), now)[url]!;
  return { repo, run, url, facts, commit, read };
}

test('a merged pull request records its time to merge and the commits a person added after the job', async () => {
  const { run, facts, read } = await mergedJob();
  const o = read({ ...facts, commits: [run.started, new Date(Date.parse(run.ended) + 60_000).toISOString()] });
  assert.deepEqual([o.state, o.job, o.ms_to_merge, o.human_commits, o.reverted, o.reworked], ['MERGED', run.job, 90_000, 1, false, false]);
  assert.equal(read().human_commits, 0);
});

test('a later change to the lines a pull request added is rework; a change elsewhere, or after 30 days, is not', async () => {
  const elsewhere = await mergedJob();
  elsewhere.commit('src/app.txt', 'app, changed\n');
  elsewhere.commit('src/feature.txt', 'one\ndone\nthree\nfour\n');
  assert.equal(elsewhere.read().reworked, false);

  const late = await mergedJob();
  late.commit('src/feature.txt', 'one\nundone\nthree\n', 31);
  assert.equal(late.read().reworked, false);

  const soon = await mergedJob();
  soon.commit('src/feature.txt', 'one\nundone\nthree\n');
  assert.deepEqual([soon.read().reworked, soon.read().reverted], [true, false]);
});

test('a revert of the merge within 30 days is found', async () => {
  const { repo, read } = await mergedJob();
  git(repo, ['revert', '--no-edit', '-m', '1', 'HEAD']);
  assert.equal(read().reverted, true);
});

test('a closed pull request is settled and not asked about again; an open or newly merged one is', async () => {
  const { url, facts, read } = await mergedJob();
  assert.equal(read({ ...facts, state: 'OPEN' }).state, 'OPEN');
  assert.equal(read().state, 'MERGED');
  assert.equal(read({ state: 'CLOSED', createdAt: facts.createdAt, closedAt: facts.mergedAt!, baseRefName: 'main', commits: [] }).state, 'CLOSED');
  let asked = 0;
  refreshOutcomes((pr) => { if (pr === url) asked += 1; return undefined; });
  assert.equal(asked, 0);
});

test('the five numbers are counted per job and split by task class', () => {
  const run = (job: string, type: string, over: Partial<Run> = {}) => ({ job, type, cost_usd: 1, ms: { total: 60_000 }, gates: [{ attempt: 1, ok: true }], ...over }) as Run;
  const outcome = (pr: string, over: Partial<Outcomes[string]>) => ({ [pr]: { pr, job: '', state: 'MERGED', opened: '', human_commits: 0, reverted: false, reworked: false, checked: '', ...over } }) as Outcomes;
  const rows = numbers([
    run('a', 'feature', { pr: 'a' }),                                    // merged, untouched
    run('b', 'feature', { gates: [{ attempt: 1, ok: false }] as Run['gates'], outcome: 'needs-input' }),
    run('b', 'feature', { pr: 'b' }),                                    // resumed, merged with a human commit, reworked
    run('c', 'feature', { pr: 'c' }),                                    // closed unmerged
    run('d', 'feature'),                                                 // a dry run: no pull request
    run('e', 'ui', { pr: 'e' }),                                         // still open
  ], { ...outcome('a', {}), ...outcome('b', { human_commits: 2, reworked: true }), ...outcome('c', { state: 'CLOSED' }) });

  const [feature, ui, all] = rows;
  assert.deepEqual(feature, { type: 'feature', jobs: 4, prs: 3, open: 0, merged: 2, closed: 1, untouched: 1, gated: 4, first_time: 3, cost_usd: 5, ms: 300_000, watched: 2, reverted_or_reworked: 1 });
  assert.deepEqual([ui!.jobs, ui!.prs, ui!.open, ui!.merged], [1, 1, 1, 0]);
  assert.deepEqual([all!.type, all!.jobs, all!.merged, all!.cost_usd], ['all', 5, 2, 6]);
});
