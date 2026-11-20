import assert from 'node:assert/strict';
import { test } from 'node:test';
import type { Run } from '../src/log.ts';
import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { describeNumbers, numbers, outcomesFile, refreshOutcomes, type Outcomes } from '../src/outcomes.ts';
import { runJob } from '../src/pipeline.ts';
import type { PrFacts } from '../src/pr.ts';
import type { CloseIssues } from '../src/issues.ts';
import { git, tryGit } from '../src/proc.ts';
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

test('a pull request records the lines a person added and removed after the job', async () => {
  const { repo, run, facts, commit, read } = await mergedJob();
  commit('src/feature.txt', 'one\ndone\nthree\nfour\nfive\n');
  commit('src/other.txt', 'x\n');
  const late = [run.started, new Date(Date.parse(run.ended) + 60_000).toISOString()];
  const o = read({ ...facts, commits: late, head: git(repo, ['rev-parse', 'HEAD']) });
  assert.deepEqual(o.human_lines, { added: 3, removed: 0 });
  assert.deepEqual(read({ ...facts, commits: [run.started] }).human_lines, { added: 0, removed: 0 });
});

test('a head that is only on the remote is fetched before the lines are counted, and an unreadable head leaves them absent', async () => {
  const { repo, run, facts, read } = await mergedJob();
  // A person's push lives on GitHub: a bare remote holds the commit, the clone does not.
  const person = mkdtempSync(join(tmpdir(), 'animus-person-'));
  git(repo, ['clone', '-q', repo, person]);
  write(person, 'src/feature.txt', 'one\ndone\nthree\nfour\n');
  git(person, ['commit', '-qam', 'a person adds a line']);
  const head = git(person, ['rev-parse', 'HEAD']);
  git(repo, ['remote', 'add', 'origin', person]);
  assert.equal(tryGit(repo, ['cat-file', '-e', head]), undefined);
  const late = [run.started, new Date(Date.parse(run.ended) + 60_000).toISOString()];
  assert.deepEqual(read({ ...facts, commits: late, head }).human_lines, { added: 1, removed: 0 });
  rmSync(outcomesFile());
  assert.equal(read({ ...facts, commits: late, head: 'f'.repeat(40) }).human_lines, undefined);
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

// Protects: criterion 5. Fails when: a pull request closed unmerged leaves its should-fix issues open, or a merged one closes them.
test('a pull request recorded as closed unmerged closes the should-fix issues its description lists; a merged one leaves them', async () => {
  const body = '## Needs you\n\n- Should fix: #7 A problem\n- Should fix: #8 Another problem\n\n## Acceptance criteria\n';
  const merged = await mergedJob();
  const closed = await mergedJob();
  const asked: [string, number[]][] = [];
  const close: CloseIssues = ({ pr, numbers }) => { asked.push([pr, [...numbers]]); };
  const shut: PrFacts = { state: 'CLOSED', createdAt: closed.facts.createdAt, closedAt: closed.facts.mergedAt!, baseRefName: 'main', commits: [], body };
  refreshOutcomes((pr) => (pr === merged.url ? { ...merged.facts, body } : pr === closed.url ? shut : undefined), Date.now(), close);
  assert.deepEqual(asked, [[closed.url, [7, 8]]]);
});

test('the five numbers are counted per job and split by task class', () => {
  const run = (job: string, type: string, over: Partial<Run> = {}) => ({ job, type, cost_usd: 1, ms: { total: 60_000 }, gates: [{ attempt: 1, ok: true }], ...over }) as Run;
  const outcome = (pr: string, over: Partial<Outcomes[string]>) => ({ [pr]: { pr, job: '', state: 'MERGED', opened: '', human_commits: 0, human_lines: { added: 0, removed: 0 }, reverted: false, reworked: false, checked: '', ...over } }) as Outcomes;
  const rows = numbers([
    run('a', 'feature', { pr: 'a' }),                                    // merged, untouched
    run('b', 'feature', { gates: [{ attempt: 1, ok: false }] as Run['gates'], outcome: 'needs-input' }),
    run('b', 'feature', { pr: 'b' }),                                    // resumed, merged with a human commit, reworked
    run('c', 'feature', { pr: 'c' }),                                    // closed unmerged
    run('d', 'feature'),                                                 // a dry run: no pull request
    run('e', 'ui', { pr: 'e' }),                                         // still open
  ], { ...outcome('a', {}), ...outcome('b', { human_commits: 2, reworked: true }), ...outcome('c', { state: 'CLOSED' }) });

  const [feature, ui, all] = rows;
  assert.deepEqual(feature, { type: 'feature', jobs: 4, prs: 3, open: 0, merged: 2, closed: 1, untouched: 1, gated: 4, first_time: 3, cost_usd: 5, ms: 300_000, watched: 2, reverted_or_reworked: 1, causes: {} });
  assert.deepEqual([ui!.jobs, ui!.prs, ui!.open, ui!.merged], [1, 1, 1, 0]);
  assert.deepEqual([all!.type, all!.jobs, all!.merged, all!.cost_usd], ['all', 5, 2, 6]);
});

// Protects: criterion 3's per-class counts. Fails when: outcomes drops causes, counts a resumed job's earlier stop, or mixes classes.
test('runs that did not deliver are counted per task class by the cause the job last stopped for', () => {
  const run = (job: string, type: string, over: Partial<Run> = {}) => ({ job, type, cost_usd: 0, ms: { total: 0 }, gates: [], ...over }) as Run;
  const [feature, ui, all] = numbers([
    run('a', 'feature', { cause: 'gates' }),
    run('b', 'feature', { cause: 'needs-input' }),
    run('b', 'feature', { pr: 'b' }),             // resumed and delivered: no cause now
    run('c', 'feature', { cause: 'gates' }),
    run('d', 'ui', { cause: 'review' }),
  ], {});
  assert.deepEqual(feature!.causes, { gates: 2 });
  assert.deepEqual(ui!.causes, { review: 1 });
  assert.deepEqual(all!.causes, { gates: 2, review: 1 });
  assert.match(describeNumbers([feature!]), /gates 2/);
});
