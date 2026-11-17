import assert from 'node:assert/strict';
import { mkdirSync, mkdtempSync, utimesSync, writeFileSync } from 'node:fs';
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
  return { animus, add, page, stop: () => { supervisor.stop(); server.close(); store.close(); } };
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
    { k: 'project', v: 'app' }, { k: 'person', v: 'ana' }, { k: 'state', v: 'ended' }, { k: 'outcome', v: 'draft pull request' },
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
    { name: 'typecheck', command: 'npm run typecheck', tag: 'ok', tone: 'ink', detail: '1.2s' },
    { name: 'test', command: 'npm test (all)', tag: 'FAIL', tone: 'fail', detail: '4.1s', output: 'not ok 3 - exports the cover\n\n  expected 1 page, got 0' },
    { name: 'lint', command: 'npm run lint', tag: 'skip', tone: 'mute', detail: 'no change under src/' },
    { name: 'acceptance-1', command: 'node --test test/pdf.test.ts', tag: 'FAIL', tone: 'fail', detail: '0.9s', output: 'not ok 1 - a book exports' },
  ]);
  assert.deepEqual(v.reviews, [
    { title: 'Review 1', summary: 'Close; the cover is lost.', findings: [
      { tag: 'BLOCKER', tone: 'fail', where: 'src/pdf.ts:40', problem: 'The cover page is dropped.', fix: 'Keep page one.' },
      { tag: 'NOTE', tone: 'mute', where: '', problem: 'The test names could say more.', fix: '' },
    ] },
    { title: 'Review 2', summary: 'The cover is kept now.', findings: [] },
  ]);
  assert.deepEqual(v.questions, [
    { question: 'A4 or Letter?', answer: 'A4.', answered: true },
    { question: 'Keep the cover?', answer: 'Yes, as page one.', answered: true },
  ]);
  assert.deepEqual([v.log, v.follow], [lines, false]);
});

// Protects: a job that has not started, or whose folder is missing, still has a page. Fails when: a missing file makes Helix fail the request.
test('a queued job\'s page shows its spec and facts, and says it has no stages, checks or review yet', async () => {
  const h = await helix();
  const job = h.add({ state: 'queued', person: 'ana', repo: 'app', title: 'Later', draft: false, submitted: '2026-11-17T11:59:00Z' }, '# Later\n', '');
  const v = jobView(await h.page(job.id), NOW);
  h.stop();
  assert.deepEqual(v.facts, [{ k: 'project', v: 'app' }, { k: 'person', v: 'ana' }, { k: 'state', v: 'queued' }, { k: 'submitted', v: '2026-11-17 11:59 UTC' }]);
  assert.equal(v.spec, '# Later\n');
  assert.deepEqual([v.stages.map((s) => s.took), v.slices, v.checks, v.reviews, v.questions, v.log, v.follow], [['', '', '', '', '', '', ''], [], [], [], [], '', true]);
});

const page = (job: Partial<DisplayJob>, over: Partial<JobPage> = {}): JobPage => ({
  at: new Date(NOW).toISOString(), stages: STAGES, log: '', ...over,
  job: { id: 9, state: 'running', person: 'ana', repo: 'app', title: 'Live', submitted: '2026-11-17T11:00:00Z', ...job },
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
