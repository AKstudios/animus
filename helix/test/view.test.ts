import assert from 'node:assert/strict';
import { test } from 'node:test';
import type { Display, DisplayJob } from '../../plugin/display/shape.ts';
import { clock, span, view } from '../../plugin/display/view.ts';

const NOW = Date.parse('2026-11-16T12:00:00Z');
const ago = (minutes: number) => new Date(NOW - minutes * 60_000).toISOString();
const STAGES = ['setup', 'implement', 'gates', 'review', 'evidence', 'pr'];

let next = 1;
const job = (over: Partial<DisplayJob>): DisplayJob => ({ id: next++, state: 'queued', person: 'ana', repo: 'app', title: `Job ${next}`, submitted: ago(30), ...over });
const shown = (jobs: DisplayJob[], slots = 2): Display => ({
  name: 'office', at: new Date(NOW).toISOString(), slots, stages: STAGES,
  repos: [{ name: 'app', base: 'main', gates: ['test', 'typecheck'] }, { name: 'site', base: 'develop', gates: [] }], jobs,
});

test('a running job shows its stage, who is working, the last line it said and how long it has run', () => {
  const v = view(shown([
    job({ id: 7, state: 'running', title: 'Export to PDF', started: ago(12.5), progress: { stage: 'gates', who: 'gates · attempt 1', at: ago(1) }, now: 'ok   typecheck' }),
    job({ id: 8, state: 'running', started: ago(0.1) }),
  ]), null, NOW);
  assert.deepEqual(v.live[0], { id: 7, page: '/jobs/7', repo: 'app', person: 'ana', personPage: '/people/ana', title: 'Export to PDF', elapsed: '12:30', stage: 2, stageText: 'GATES', stepText: 'step 3 of 6', stepShort: '3/6', who: 'gates · attempt 1', now: 'ok   typecheck' });
  // A job that has not said where it is yet has no stage on its track.
  assert.deepEqual([v.live[1]!.stage, v.live[1]!.stageText, v.live[1]!.stepText, v.live[1]!.who, v.live[1]!.elapsed], [-1, 'STARTING', '', 'starting', '00:06']);
  assert.deepEqual([v.running, v.slots, v.queued, v.asks], [2, 2, 0, 0]);
});

test('waiting lists the jobs that ask first, then the queue in order with each job\'s place and why it is there again', () => {
  const v = view(shown([
    job({ id: 1, state: 'queued', submitted: ago(4) }),
    job({ id: 2, state: 'ended', outcome: 'needs-input', question: 'Which column?', title: 'CSV order' }),
    job({ id: 3, state: 'queued', submitted: ago(300), queued: ago(0.5), animus_job: 'a-1', resumed: 'answer' }),
    job({ id: 4, state: 'queued', submitted: ago(90), queued: ago(75), animus_job: 'a-2', resumed: 'restart' }),
  ]), null, NOW);
  assert.deepEqual(v.waiting.map((w) => [w.id, w.tag, w.note]), [
    [2, 'NEEDS INPUT', 'Which column?'],
    [1, 'QUEUED', 'Position 1 in the queue, waiting 4m.'],
    [3, 'QUEUED AGAIN', 'Has its answer and carries on from where it stopped. Position 2 in the queue, waiting less than a minute.'],
    [4, 'QUEUED AGAIN', 'Helix stopped while it ran, so it carries on from where it stopped. Position 3 in the queue, waiting 1h 15m.'],
  ]);
  assert.deepEqual([v.queued, v.asks], [3, 1]);
});

test('recent lists ended jobs newest first, each with how it ended, what it took and why', () => {
  const v = view(shown([
    job({ id: 1, state: 'ended', outcome: 'pr', pr: 'https://github.com/o/r/pull/112', started: ago(40), ended: ago(18), cost_usd: 2.1, reason: 'not shown for a pull request' }),
    job({ id: 2, state: 'ended', outcome: 'draft-pr', pr: 'https://github.com/o/r/pull/31', started: ago(31), ended: ago(0), cost_usd: 3.4, reason: 'the gates still fail after 2 fix round(s):\nFAIL test' }),
    job({ id: 3, state: 'ended', outcome: 'failed', ended: ago(5), reason: 'the GitHub token in the env file does not work' }),
    job({ id: 4, state: 'cancelled', started: ago(10), ended: ago(9.25), person: 'ben' }),
    job({ id: 5, state: 'ended', outcome: 'dry-run', started: ago(11), ended: ago(0), cost_usd: 0 }),
    job({ id: 6, state: 'ended', outcome: 'needs-input', question: '?' }),
  ]), null, NOW);
  assert.deepEqual(v.recent.map((r) => [r.id, r.tag, r.tone, r.meta, r.reason, r.href]), [
    [5, 'DRY RUN', 'mute', '11m · $0.00', undefined, undefined],
    [4, 'CANCELLED', 'mute', '45s', undefined, undefined],
    [3, 'FAILED', 'fail', '', 'the GitHub token in the env file does not work', undefined],
    [2, 'DRAFT PR #31', 'ask', '31m · $3.40', 'the gates still fail after 2 fix round(s):', 'https://github.com/o/r/pull/31'],
    [1, 'PR #112', 'ink', '22m · $2.10', undefined, 'https://github.com/o/r/pull/112'],
  ]);
});

test('each project is summed up from its own jobs, and picking one narrows every section to it', () => {
  const d = shown([
    job({ id: 1, repo: 'app', state: 'ended', outcome: 'pr', pr: 'https://x.test/pull/1', cost_usd: 1.25 }),
    job({ id: 2, repo: 'app', state: 'ended', outcome: 'failed' }),
    job({ id: 3, repo: 'app', state: 'ended', outcome: 'needs-input', question: '?' }),
    job({ id: 4, repo: 'app', state: 'running', started: ago(1), cost_usd: 0.5 }),
    job({ id: 5, repo: 'site', state: 'queued' }),
    job({ id: 6, repo: 'app', state: 'queued' }),
    job({ id: 7, repo: 'app', state: 'cancelled' }),
  ], 4);
  const all = view(d, null, NOW);
  assert.deepEqual(all.projects, [
    { id: 'app', summary: '1 running · 1 queued · 1 ask', on: false, busy: true, ticks: ['ended', 'failed', 'ask', 'running', 'queued', 'queued'] },
    { id: 'site', summary: '1 queued', on: false, busy: false, ticks: ['queued'] },
  ]);
  assert.deepEqual([all.title, all.sel, all.live.length, all.waiting.length, all.recent.length], ['All projects', undefined, 1, 3, 3]);

  const app = view(d, 'app', NOW);
  assert.deepEqual(app.sel, { id: 'app', base: 'main', gates: 'test, typecheck', prs: 1, spent: '$1.75' });
  assert.deepEqual([app.title, app.projects[0]!.on, app.waiting.map((w) => w.id)], ['app', true, [3, 6]]);
  // The queue's order is the machine's, not the project's.
  assert.match(app.waiting[1]!.note, /^Position 2 in the queue/);
  // A project Helix no longer has is the same as none picked.
  assert.equal(view(d, 'gone', NOW).sel, undefined);
});

test('with no job to list, the display says so and how to send one', () => {
  const none = view(shown([], 8), null, NOW);
  assert.deepEqual(none.empty, { title: 'Nothing is running', text: 'No job has been submitted to this machine yet. From any project, send a spec:', free: '8 of 8 slots free' });
  const d = shown([job({ repo: 'app', state: 'running', started: ago(1) })], 8);
  assert.deepEqual(view(d, 'site', NOW).empty, { title: 'No jobs for site yet', text: 'Nobody has sent this project a spec. From its folder, run:', free: '7 of 8 slots free' });
  assert.equal(view(d, 'app', NOW).empty, undefined);
  assert.equal(view(shown([job({ state: 'queued' })], 1), null, NOW).noLive, 'No agent is working right now. The one slot is free.');
});

test('times read at a glance', () => {
  assert.deepEqual([clock(0), clock(462_000), clock(7_925_000), clock(-5)], ['00:00', '07:42', '132:05', '00:00']);
  assert.deepEqual([span(45_000), span(60_000), span(22 * 60_000), span(190 * 60_000)], ['45s', '1m', '22m', '3h 10m']);
});
