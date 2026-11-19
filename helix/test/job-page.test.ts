import assert from 'node:assert/strict';
import { mkdirSync, mkdtempSync, symlinkSync, utimesSync, writeFileSync } from 'node:fs';
import type { AddressInfo } from 'node:net';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { test } from 'node:test';
import { atEnd, jobView } from '../../plugin/display/job-view.ts';
import type { DisplayJob, JobPage } from '../../plugin/display/shape.ts';
import { gateReport, type CheckResult } from '../../plugin/src/gates.ts';
import type { JobState, Run } from '../../plugin/src/log.ts';
import type { Review } from '../../plugin/src/review.ts';
import { hashToken, type Config } from '../src/config.ts';
import { serve } from '../src/server.ts';
import { openStore, type HelixJob } from '../src/store.ts';
import { supervise } from '../src/supervisor.ts';

const NOW = Date.parse('2026-11-17T12:00:00Z');
const STAGES = ['setup', 'plan', 'implement', 'gates', 'review', 'evidence', 'pr'];

/** A Helix on a free port whose jobs keep their Animus folders in their own Animus home, as with containers. */
async function helix() {
  const home = mkdtempSync(join(tmpdir(), 'helix-'));
  const animus = mkdtempSync(join(tmpdir(), 'animus-'));
  const config: Config = { host: '127.0.0.1', port: 0, slots: 1 };
  const store = openStore(join(home, 'helix.db'));
  store.putPerson('ana', { token_sha256: hashToken('ana-token') });
  store.putPerson('ben', { token_sha256: hashToken('ben-token') });
  const supervisor = supervise({ store, config, home, animusHomeOf: () => animus });
  const server = serve({ config, store, supervisor, home });
  await new Promise<void>((r) => { server.listen(0, '127.0.0.1', r); });
  const url = `http://127.0.0.1:${(server.address() as AddressInfo).port}`;
  /** A job in the table, with its spec as submitted and the output Helix kept of its run. */
  const add = (job: Omit<HelixJob, 'id' | 'spec'>, spec: string, log: string) => {
    const added = store.add({ ...job, spec: '' });
    added.spec = join(home, 'jobs', String(added.id), 'spec.md');
    mkdirSync(join(home, 'jobs', String(added.id)), { recursive: true });
    writeFileSync(added.spec, spec);
    writeFileSync(join(home, 'jobs', String(added.id), 'log.txt'), log);
    store.save(added);
    return added;
  };
  const page = async (id: number) => {
    const res = await fetch(new URL(`/jobs/${id}/page-data`, url), { headers: { authorization: 'Bearer ben-token' } });
    assert.equal(res.status, 200);
    return (await res.json()) as JobPage;
  };
  return { animus, url, add, page, stop: () => { supervisor.stop(); server.close(); store.close(); } };
}

/** Gives a file the nth minute after the job started as when it was written. */
const touch = (file: string, minute: number) => { const t = new Date(Date.parse('2026-11-17T10:05:00Z') + minute * 60_000); utimesSync(file, t, t); };

const check = (name: string, command: string, over: Partial<CheckResult>): CheckResult => ({ name, command, ok: true, skipped: false, ms: 1200, output: '', ...over });

/** The Animus folder of a job that was cut in two, asked twice, ran its gates twice and was reviewed twice, as the pipeline leaves it. */
function animusFolder(animus: string, job: string): void {
  const dir = join(animus, 'jobs', job);
  mkdirSync(join(dir, 'gates'), { recursive: true });
  const state: Partial<JobState> = {
    job, repo: 'app', spec: join(dir, 'spec.md'),
    slicing: { brief: '', slices: [
      { title: 'Export a page', delivers: 'One page exports to PDF.', criteria: [1], after: [] },
      { title: 'Export a book', delivers: 'A whole book exports.', criteria: [2], after: [1] },
    ] },
    sliced_by: 'planner', slices_done: ['Pages export.'],
    answers: [{ question: 'A4 or Letter?', answer: 'A4.' }, { question: 'Keep the cover?', answer: 'Yes, as page one.' }],
    outcome: 'failed',
  };
  writeFileSync(join(dir, 'state.json'), JSON.stringify(state));
  // The older run is written last: a resumed job counts its gate runs from 1 again, so the newest file is the latest run.
  writeFileSync(join(dir, 'gates', 'run-1.txt'), gateReport([
    check('typecheck', 'npm run typecheck', {}),
    check('test', 'npm test (all)', { ok: false, ms: 4100, output: 'not ok 3 - exports the cover\n\n  expected 1 page, got 0' }),
    check('lint', 'npm run lint', { skipped: true, ms: 0, output: 'no change under src/' }),
    check('acceptance-1', 'node --test test/pdf.test.ts', { ok: false, ms: 900, output: 'not ok 1 - a book exports' }),
  ]));
  writeFileSync(join(dir, 'gates', 'run-2.txt'), gateReport([check('test', 'npm test (all)', { ok: false, output: 'an older run' })]));
  touch(join(dir, 'gates', 'run-1.txt'), 2);
  touch(join(dir, 'gates', 'run-2.txt'), 1);
  const review = (summary: string, findings: Review['findings']): Review => ({ status: 'reviewed', summary, criteria: [], findings });
  writeFileSync(join(dir, 'review-1.json'), JSON.stringify(review('Close; the cover is lost.', [
    { severity: 'blocker', file: 'src/pdf.ts', line: 40, problem: 'The cover page is dropped.', fix: 'Keep page one.' },
    { severity: 'note', problem: 'The test names could say more.' },
  ])));
  writeFileSync(join(dir, 'review-2.json'), JSON.stringify(review('The cover is kept now.', [])));
  touch(join(dir, 'review-1.json'), 3);
  touch(join(dir, 'review-2.json'), 4);
  const ms = (over: Partial<Run['ms']>): Run['ms'] => ({ queue: 0, setup: 0, plan: 0, implement: 0, gates: 0, review: 0, evidence: 0, pr: 0, total: 0, ...over });
  writeFileSync(join(animus, 'runs.jsonl'), [
    { job, ms: ms({ setup: 4_000, plan: 50_000, implement: 600_000 }) },
    { job: 'someone-else', ms: ms({ setup: 99_000_000 }) },
    { job, ms: ms({ setup: 2_000, implement: 720_000, gates: 95_000, review: 130_000, pr: 9_000 }) },
  ].map((r) => JSON.stringify(r)).join('\n'));
}

// Protects: criterion 4, what a job page shows. Fails when: any part of the job's folder or row is left off its page, or a failed check's output is lost.
test('a job page shows the job\'s facts, spec, stages and slices, checks with a failed one\'s output, findings, questions and answers, and its whole log once it ended', async () => {
  const h = await helix();
  const lines = Array.from({ length: 300 }, (_, i) => `line ${i + 1}`).join('\n');
  const job = h.add({
    state: 'ended', person: 'ana', repo: 'app', title: 'Export to PDF', draft: false, animus_job: 'app-7',
    submitted: '2026-11-17T10:00:00Z', started: '2026-11-17T10:05:00Z', ended: '2026-11-17T10:40:30Z',
    outcome: 'draft-pr', pr: 'https://github.com/o/app/pull/4', cost_usd: 3.4, reason: 'the gates still fail',
  }, '# Export to PDF\n\nAs submitted.\n', `${lines}\n`);
  animusFolder(h.animus, 'app-7');

  const v = jobView(await h.page(job.id), NOW);
  h.stop();

  assert.deepEqual([v.id, v.title], [job.id, 'Export to PDF']);
  assert.deepEqual(v.facts, [
    { k: 'project', v: 'app' }, { k: 'person', v: 'ana', page: '/people/ana' }, { k: 'state', v: 'ended' }, { k: 'outcome', v: 'draft pull request' },
    { k: 'PR', v: '#4', href: 'https://github.com/o/app/pull/4' }, { k: 'cost', v: '$3.40' },
    { k: 'submitted', v: '2026-11-17 10:00 UTC' }, { k: 'started', v: '2026-11-17 10:05 UTC' }, { k: 'ended', v: '2026-11-17 10:40 UTC' }, { k: 'took', v: '35m' },
  ]);
  assert.equal(v.reason, 'the gates still fail');
  assert.equal(v.spec, '# Export to PDF\n\nAs submitted.\n');
  // Both of the job's runs, added up.
  assert.deepEqual(v.stages, [
    { name: 'setup', took: '6s', on: false }, { name: 'plan', took: '50s', on: false }, { name: 'implement', took: '22m', on: false },
    { name: 'gates', took: '1m', on: false }, { name: 'review', took: '2m', on: false }, { name: 'evidence', took: '0s', on: false }, { name: 'pr', took: '9s', on: false },
  ]);
  assert.deepEqual(v.slices, [
    { title: 'Export a page', delivers: 'One page exports to PDF.', done: true },
    { title: 'Export a book', delivers: 'A whole book exports.', done: false },
  ]);
  assert.deepEqual(v.checks, [
    { name: 'typecheck', command: 'npm run typecheck', tag: '✓', tone: 'ink', detail: '1.2s' },
    { name: 'test', command: 'npm test (all)', tag: '✗', tone: 'fail', detail: '4.1s', output: 'not ok 3 - exports the cover\n\n  expected 1 page, got 0' },
    { name: 'lint', command: 'npm run lint', tag: 'skip', tone: 'mute', detail: 'no change under src/' },
    { name: 'acceptance-1', command: 'node --test test/pdf.test.ts', tag: '✗', tone: 'fail', detail: '0.9s', output: 'not ok 1 - a book exports' },
  ]);
  assert.deepEqual(v.reviews, [
    { title: 'Review 1', summary: 'Close; the cover is lost.', findings: [
      { tag: 'BLOCKER', tone: 'fail', where: 'src/pdf.ts:40', problem: 'The cover page is dropped.', fix: 'Keep page one.', fate: '' },
      { tag: 'NOTE', tone: 'mute', where: '', problem: 'The test names could say more.', fix: '', fate: '' },
    ] },
    { title: 'Review 2', summary: 'The cover is kept now.', findings: [] },
  ]);
  assert.deepEqual(v.questions, [
    { question: 'A4 or Letter?', answer: 'A4.', answered: true },
    { question: 'Keep the cover?', answer: 'Yes, as page one.', answered: true },
  ]);
  assert.deepEqual([v.log, v.follow], [lines, false]);
  // Two gate run files in the folder.
  assert.equal(v.numbers[2]!.k, 'fix rounds · 2 gate runs');
});

// Protects: a job that has not started, or whose folder is missing, still has a page. Fails when: a missing file makes Helix fail the request.
test('a queued job\'s page shows its spec and facts, and says it has no stages, checks or review yet', async () => {
  const h = await helix();
  const job = h.add({ state: 'queued', person: 'ana', repo: 'app', title: 'Later', draft: false, submitted: '2026-11-17T11:59:00Z' }, '# Later\n', '');
  const v = jobView(await h.page(job.id), NOW);
  h.stop();
  assert.deepEqual(v.facts, [{ k: 'project', v: 'app' }, { k: 'person', v: 'ana', page: '/people/ana' }, { k: 'state', v: 'queued' }, { k: 'submitted', v: '2026-11-17 11:59 UTC' }]);
  assert.equal(v.spec, '# Later\n');
  assert.deepEqual([v.stages.map((s) => s.took), v.slices, v.checks, v.reviews, v.questions, v.log, v.follow], [['', '', '', '', '', '', ''], [], [], [], [], '', true]);
});

const page = (job: Partial<DisplayJob>, over: Partial<JobPage> = {}): JobPage => ({
  at: new Date(NOW).toISOString(), stages: STAGES, log: '', ...over,
  job: { id: 9, state: 'running', person: 'ana', repo: 'app', title: 'Live', submitted: '2026-11-17T11:00:00Z', ...job },
});

// Protects: criterion 4, the outcome, four numbers and the time bar. Fails when: the tag, the merge time, a number or a stage's share is wrong.
test('a merged job page leads with its tag and line, four numbers and a bar of each stage\'s share of the time', () => {
  const p = page({ state: 'ended', outcome: 'pr', pr: 'https://github.com/o/app/pull/4', cost_usd: 3.4, started: '2026-11-17T10:05:00Z', ended: '2026-11-17T10:40:30Z' }, {
    ms: { setup: 0, plan: 120_000, implement: 360_000, gates: 0, review: 120_000 }, gate_runs: 3,
    reviews: [{ summary: 'ok', findings: [] }], slices: [{ title: 'a', delivers: '', done: true }, { title: 'b', delivers: '', done: false }],
  });
  const v = jobView(p, NOW, false, { job: 9, number: 4, merged: true, at: '2026-11-17T12:00:30Z' });
  assert.deepEqual([v.tag, v.line], [{ text: 'Merged #4', tone: 'merged' }, 'app · ana · started 2026-11-17 10:05 UTC · merged after 1h 20m']);
  assert.deepEqual(v.numbers, [{ k: 'time taken', v: '35m' }, { k: 'cost', v: '$3.40' }, { k: 'fix rounds · 3 gate runs', v: '–' }, { k: 'slices passed', v: '1 of 2' }]);
  assert.deepEqual(v.bar, [
    { name: 'plan', took: '2m', pct: 20, at: 0, label: 'plan', on: false },
    { name: 'implement', took: '6m', pct: 60, at: 20, label: 'implement · 2 slices', on: false },
    { name: 'review', took: '2m', pct: 20, at: 80, label: 'review', on: false },
  ]);
  assert.equal(jobView({ ...p, slices: undefined }, NOW).numbers[3]!.v, '1');
});

// Protects: criterion 4's side panels and chips. Fails when: the third number, the Agents shares, the after-the-job rows, the watch, the lessons, the flaky chip, a finding's fate or the tool calls are wrong.
test('a merged job page tells its fix rounds, agents, what happened after, the watch, lessons, flaky checks, finding fates and tool calls', () => {
  const p = page({ state: 'ended', outcome: 'pr', pr: 'https://github.com/o/app/pull/4', cost_usd: 4, started: '2026-11-17T10:05:00Z', ended: '2026-11-17T10:40:30Z' }, {
    gate_runs: 3, reviews: [{ summary: 'x', findings: [{ severity: 'blocker', file: 'a.ts', line: 1, problem: 'p', fix: 'f' }, { severity: 'note', problem: 'n', fix: '' }] }],
    run: {
      fix_rounds: 2, gates: [{ flaky: ['test'] }, { flaky: ['test'] }, { flaky: [] }],
      agents: [{ role: 'plan', tier: 'fast', cost_usd: 1, calls: 4, errors: 0 }, { role: 'implement', tier: 'strong', cost_usd: 3, calls: 20, errors: 2 }],
      findings: [{ round: 1, severity: 'blocker', fate: 'fixed' }, { round: 1, severity: 'note', fate: 'not-acted-on' }],
      tools: { calls: 24, errors: 2, text: 'implement  Bash ×12' },
    },
    after: { human_commits: 2, lines: { added: 10, removed: 1 }, reverted: false },
    lessons: [{ id: 7, text: 'Run lint first.', scope: 'project', project: 'app', cites: ['j'], status: 'proposed', uses: 0, expires: '' }, { id: 8, text: 'Keep slices small.', scope: 'factory', project: '', cites: ['j'], status: 'kept', uses: 3, expires: '' }],
  });
  const v = jobView(p, NOW, false, { job: 9, number: 4, merged: true, at: '2026-11-17T12:00:30Z' });
  assert.deepEqual(v.numbers[2], { k: 'fix rounds · 3 gate runs', v: '2' });
  assert.deepEqual(v.agents, [
    { name: 'implement · strong', cost: '$3.00', pct: 75, calls: '1 session · 20 tool calls · 2 errors' },
    { name: 'plan · fast', cost: '$1.00', pct: 25, calls: '1 session · 4 tool calls' },
  ]);
  assert.deepEqual(v.pr!.rows.slice(-2), [{ k: 'after the job', v: '2 commits · 10 lines' }, { k: '30-day watch', v: 'not reverted' }]);
  assert.deepEqual(v.taught, [{ text: 'Run lint first.', state: 'Proposed · animus lessons accept 7' }, { text: 'Keep slices small.', state: 'Kept · used 3×' }]);
  assert.deepEqual(v.flaky, ['test was flaky twice']);
  assert.deepEqual(v.reviews[0]!.findings.map((f) => f.fate), ['fixed in round 2', 'not acted on']);
  assert.deepEqual(v.tools, { summary: '24 · 2 errors', text: 'implement  Bash ×12' });
});

// Protects: criterion 5, criteria in the spec's words with their checks. Fails when: a criterion is matched to the wrong check, its command is lost, or a spec that cannot be read hides checks.
test('a job page lists each acceptance criterion with its check, the other checks as pills, and falls back to pills when the spec has no list', () => {
  const spec = '# T\n\n## Acceptance criteria\n\n1. First thing\n   wraps here.\n   $ node --test a.ts\n2. Second thing\n\n## Out of scope\n\n- nope\n';
  const checks = [
    { name: 'test', command: 'npm test', status: 'fail' as const, detail: '1s', output: 'boom' },
    { name: 'acceptance-2', command: 'node --test b.ts', status: 'fail' as const, detail: '1s', output: 'not ok' },
    { name: 'acceptance-1', command: 'node --test a.ts', status: 'ok' as const, detail: '1s' },
    { name: 'lint', command: 'npm run lint', status: 'skip' as const, detail: '' },
  ];
  const v = jobView(page({ state: 'ended' }, { spec, checks }), NOW);
  assert.deepEqual(v.criteria, [
    { text: 'First thing wraps here.', tag: '✓', tone: 'ink', command: 'node --test a.ts' },
    { text: 'Second thing', tag: '✗', tone: 'fail', command: 'node --test b.ts', output: 'not ok' },
  ]);
  assert.deepEqual(v.pills, [
    { name: 'test', command: 'npm test', tag: '✗', tone: 'fail', output: 'boom' },
    { name: 'lint', command: 'npm run lint', tag: 'skip', tone: 'mute' },
  ]);
  const bare = jobView(page({ state: 'ended' }, { spec: 'no list', checks }), NOW);
  assert.deepEqual([bare.criteria, bare.pills.length], [[], 4]);
});

// Protects: criterion 5, the trail, the Pull request and Labels panels and the headings' counts. Fails when: a panel shows the wrong state, branch or time, a label is missed, or a count is wrong.
test('a job page has a trail, a Pull request panel with its branch and times, the spec\'s labels and counts for its headings', () => {
  const spec = '---\nsize: medium\ndifficulty: hard\ntype: feature\n---\n# T\n';
  const p = page({ id: 9, animus_job: 'the-job-1a2b', state: 'ended', outcome: 'pr', pr: 'https://github.com/o/app/pull/4' }, {
    spec, pr_state: 'merged', pr_opened: '2026-11-17T10:41:00Z', pr_merged: '2026-11-17T12:00:00Z',
    checks: [{ name: 'test', command: 'npm test', status: 'ok', detail: '1s' }, { name: 'lint', command: 'npm run lint', status: 'fail', detail: '1s', output: 'x' }],
    reviews: [{ summary: 's', findings: [{ severity: 'blocker', problem: 'p' }, { severity: 'note', problem: 'q' }] }, { summary: 't', findings: [] }],
  });
  const v = jobView(p, NOW);
  assert.deepEqual(v.trail, { project: 'app', job: 'the-job-1a2b' });
  assert.deepEqual(v.pr, { number: '#4', href: 'https://github.com/o/app/pull/4', state: 'merged', tone: 'merged', rows: [
    { k: 'branch', v: 'animus/the-job-1a2b' }, { k: 'opened', v: '2026-11-17 10:41 UTC' }, { k: 'merged', v: '2026-11-17 12:00 UTC' },
  ] });
  assert.deepEqual(v.labels, [{ k: 'size', v: 'medium' }, { k: 'difficulty', v: 'hard' }, { k: 'type', v: 'feature' }]);
  assert.deepEqual(v.notes, { criteria: '0 of 0 proven', checks: '1 failed on the last run', review: '2 rounds · 2 findings' });
  assert.equal(jobView(page({}), NOW).pr, undefined);
  assert.deepEqual(jobView(page({}, { spec: '# T\n' }), NOW).labels, []);
});

// Protects: a running job's page follows it. Fails when: the stage it is on is not marked, or its log is not followed.
test('a running job\'s page marks the stage it is on, counts how long it has run, and follows its log', () => {
  const v = jobView(page({ started: '2026-11-17T11:47:30Z', progress: { stage: 'gates', who: 'gates · attempt 1', at: '2026-11-17T11:59:00Z' } }, { log: 'gates, run 1' }), NOW);
  assert.deepEqual(v.stages.filter((s) => s.on).map((s) => s.name), ['gates']);
  assert.deepEqual(v.facts.slice(-2), [{ k: 'started', v: '2026-11-17 11:47 UTC' }, { k: 'running for', v: '12:30' }]);
  assert.deepEqual([v.log, v.follow], ['gates, run 1', true]);
});

// Protects: the last question a job asked shows before its run has read the answer. Fails when: an open question is left off, or its answer is lost while the job waits in the queue.
test('a job\'s latest question shows as not answered while it waits, and with its answer once it is queued again', async () => {
  const h = await helix();
  const asked = (animusJob: string) => {
    mkdirSync(join(h.animus, 'jobs', animusJob), { recursive: true });
    writeFileSync(join(h.animus, 'jobs', animusJob, 'state.json'), JSON.stringify({ job: animusJob, answers: [{ question: 'A4?', answer: 'Yes.' }], outcome: 'needs-input', question: 'Which column?' }));
  };
  asked('app-1');
  asked('app-2');
  const base = { person: 'ana', repo: 'app', title: 'CSV', draft: false, submitted: '2026-11-17T11:00:00Z' } as const;
  const waiting = h.add({ ...base, state: 'ended', outcome: 'needs-input', question: 'Which column?', animus_job: 'app-1' }, '# CSV\n', '');
  const again = h.add({ ...base, state: 'queued', answer: 'The second.', animus_job: 'app-2' }, '# CSV\n', '');
  const [w, a] = [jobView(await h.page(waiting.id), NOW), jobView(await h.page(again.id), NOW)];
  h.stop();
  assert.deepEqual(w.questions, [
    { question: 'A4?', answer: 'Yes.', answered: true },
    { question: 'Which column?', answer: 'Not answered yet.', answered: false },
  ]);
  assert.deepEqual(a.questions, [
    { question: 'A4?', answer: 'Yes.', answered: true },
    { question: 'Which column?', answer: 'The second.', answered: true },
  ]);
});

// Protects: the log follows its end unless the person scrolled up. Fails when: a person reading back up is pulled down to the end every two seconds.
test('the log follows its end only while it is scrolled to the end', () => {
  assert.equal(atEnd({ scrollTop: 600, scrollHeight: 1000, clientHeight: 400 }), true);
  assert.equal(atEnd({ scrollTop: 598, scrollHeight: 1000, clientHeight: 400 }), true);
  assert.equal(atEnd({ scrollTop: 300, scrollHeight: 1000, clientHeight: 400 }), false);
});

const PNG = Buffer.from([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a, 1, 2, 3]);

/** A UI job's shots folder as `animus shots` leaves it: the images under build/, and the manifest that lists them. */
function shotsFolder(animus: string, job: string, build: string[]): string {
  const dir = join(animus, 'jobs', job, 'shots');
  mkdirSync(join(dir, 'build'), { recursive: true });
  writeFileSync(join(animus, 'jobs', job, 'state.json'), JSON.stringify({ job }));
  for (const f of build) writeFileSync(join(dir, f), PNG);
  writeFileSync(join(dir, 'manifest.json'), JSON.stringify({ job, target: 'app', tree: 't', at: '2026-11-17T10:30:00Z', build, reference: [], design: 'missing' }));
  return dir;
}

const ui = { state: 'ended', person: 'ana', repo: 'app', title: 'Settings page', draft: false, submitted: '2026-11-17T10:00:00Z' } as const;

// Protects: criterion 5, a job's screenshots on its page, for a valid token only. Fails when: the page leaves them off, or Helix serves them without a token.
test('a job page lists its screenshots, and Helix serves each one to a valid token only', async () => {
  const h = await helix();
  shotsFolder(h.animus, 'app-8', ['build/settings@390x844.png', 'build/settings@1280x800.png']);
  const job = h.add({ ...ui, animus_job: 'app-8' }, '# Settings\n', '');

  const v = jobView(await h.page(job.id), NOW);
  const src = `/jobs/${job.id}/shots/build/settings%40390x844.png`;
  const get = (token?: string) => fetch(new URL(src, h.url), token ? { headers: { authorization: `Bearer ${token}` } } : {});
  const [shown, none, wrong] = await Promise.all([get('ben-token'), get(), get('not-a-token')]);
  const body = Buffer.from(await shown.arrayBuffer());
  h.stop();

  assert.deepEqual(v.shots, [
    { name: 'settings@390x844', src },
    { name: 'settings@1280x800', src: `/jobs/${job.id}/shots/build/settings%401280x800.png` },
  ]);
  assert.deepEqual([shown.status, shown.headers.get('content-type'), body], [200, 'image/png', PNG]);
  assert.deepEqual([none.status, wrong.status], [401, 401]);
});

// Protects: criterion 5, no path reaches outside a job's screenshots. Fails when: a name that climbs out, or a file of the folder that is not a screenshot, is served.
test('Helix serves only the screenshots a job\'s shots folder lists, and nothing a name climbs out to', async () => {
  const h = await helix();
  shotsFolder(h.animus, 'app-8', ['build/settings@390x844.png']);
  writeFileSync(join(h.animus, 'secret.png'), PNG);
  const job = h.add({ ...ui, animus_job: 'app-8' }, '# Settings\n', '');
  const other = h.add({ ...ui }, '# No folder\n', '');
  const names = [
    `${job.id}/shots/manifest.json`,
    `${job.id}/shots/build%2Fother.png`,
    `${job.id}/shots/build%2F..%2Fmanifest.json`,
    `${job.id}/shots/..%2Fstate.json`,
    `${job.id}/shots/build%2F..%2F..%2F..%2F..%2Fsecret.png`,
    `${job.id}/shots/%2Fetc%2Fpasswd`,
    `${other.id}/shots/build%2Fsettings%40390x844.png`,
  ];
  const statuses = await Promise.all(names.map(async (n) => (await fetch(new URL(`/jobs/${n}`, h.url), { headers: { authorization: 'Bearer ben-token' } })).status));
  h.stop();
  assert.deepEqual(statuses, names.map(() => 404));
});

// Protects: a screenshot the manifest lists cannot lead outside the folder. Fails when: a link a capture command left in build/ is followed.
test('a listed screenshot that links outside the job\'s folder is not served', { skip: process.platform === 'win32' && 'links need privileges on Windows' }, async () => {
  const h = await helix();
  const dir = shotsFolder(h.animus, 'app-8', []);
  writeFileSync(join(h.animus, 'secret.png'), PNG);
  symlinkSync(join(h.animus, 'secret.png'), join(dir, 'build', 'home.png'));
  writeFileSync(join(dir, 'manifest.json'), JSON.stringify({ build: ['build/home.png'], reference: [] }));
  const job = h.add({ ...ui, animus_job: 'app-8' }, '# Settings\n', '');
  const res = await fetch(new URL(`/jobs/${job.id}/shots/build/home.png`, h.url), { headers: { authorization: 'Bearer ben-token' } });
  h.stop();
  assert.equal(res.status, 404);
});
