import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
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
  assert.deepEqual(v.live[0], { id: 7, page: '/jobs/7', repo: 'app', person: 'ana', personPage: '/people/ana', title: 'Export to PDF', by: [{ text: 'app' }, { text: 'ana', page: '/people/ana' }], elapsed: '12:30', stage: 2, stageText: 'GATES', stepText: 'step 3 of 6', stepShort: '3/6', who: 'gates · attempt 1', now: 'ok   typecheck' });
  // A job that has not said where it is yet has no stage on its track.
  assert.deepEqual([v.live[1]!.stage, v.live[1]!.stageText, v.live[1]!.stepText, v.live[1]!.who, v.live[1]!.elapsed], [-1, 'STARTING', '', 'starting', '00:06']);
  assert.deepEqual([v.running, v.slots, v.queued, v.asks], [2, 2, 0, 0]);
});

// Protects: a card draws no separator or empty `>` line for what the job lacks. Fails when: the view gives a person's page or a line to a job that has neither, or Helix loses its People link.
test('a running job with no person or line yet has neither, and only Helix links to people', () => {
  const j = job({ person: '', state: 'running', started: ago(1) });
  const local = view({ ...shown([j]), local: true }, null, NOW);
  const helix = view(shown([j]), null, NOW);
  assert.deepEqual([local.live[0]!.by, local.live[0]!.now], [[{ text: 'app' }], '']);
  assert.deepEqual(view(shown([job({ state: 'running' })]), null, NOW).live[0]!.by, [{ text: 'app' }, { text: 'ana', page: '/people/ana' }]);
  assert.deepEqual([local.people, helix.people], [false, true]);
});

// Protects: a waiting question is a card with its command, and the queue is its own short list. Fails when: the command is the wrong one for the source, the question is lost, or queued jobs keep the asking ones' heading.
test('a job waiting for an answer is a card with its question and the command that answers it; the queue is separate with places and reasons', () => {
  const jobs = [
    job({ id: 1, state: 'queued', submitted: ago(4) }),
    job({ id: 2, state: 'ended', outcome: 'needs-input', question: 'Which column?', title: 'CSV order', ended: ago(15) }),
    job({ id: 3, state: 'queued', submitted: ago(300), queued: ago(0.5), animus_job: 'a-1', resumed: 'answer' }),
    job({ id: 4, state: 'queued', submitted: ago(90), queued: ago(75), animus_job: 'a-2', resumed: 'restart' }),
  ];
  const v = view(shown(jobs), null, NOW);
  assert.deepEqual(v.needs, [{ id: 2, page: '/jobs/2', question: 'Which column?', title: 'CSV order', repo: 'app', person: 'ana', personPage: '/people/ana', waited: '15m', command: 'animus answer 2 "…"' }]);
  assert.deepEqual(v.line.map((w) => [w.id, w.tag, w.note]), [
    [1, 'Queued', 'Position 1 in the queue, waiting 4m.'],
    [3, 'Queued again', 'Has its answer and carries on from where it stopped. Position 2 in the queue, waiting less than a minute.'],
    [4, 'Queued again', 'Helix stopped while it ran, so it carries on from where it stopped. Position 3 in the queue, waiting 1h 15m.'],
  ]);
  assert.deepEqual([v.queued, v.asks], [3, 1]);
  assert.equal(view({ ...shown(jobs), local: true }, null, NOW).needs[0]!.command, 'animus resume 2 --answer "…"');
});

// Protects: the headline sentence, its ask-coloured part and the last-finished tag. Fails when: a count or plural is wrong, the quiet words show while a job needs the person, or the last finished job's tag is missing.
test('the headline is built from the counts and names the last job that finished', () => {
  const ask = job({ state: 'ended', outcome: 'needs-input', question: '?', ended: ago(50) });
  const run = () => job({ state: 'running', started: ago(1) });
  const merged = job({ id: 19, state: 'ended', outcome: 'pr', pr: 'https://github.com/o/r/pull/19', ended: ago(8) });
  const d = { ...shown([ask, run(), run(), run(), merged]), closed: [{ job: 19, number: 19, merged: true, at: ago(2) }] };
  assert.deepEqual(view(d, null, NOW).headline, { needs: '1 job needs you.', rest: '3 agents at work.', last: { when: 'Last finished 8m ago', tag: 'Merged #19', tone: 'merged' } });
  assert.deepEqual(view(shown([run(), run()]), null, NOW).headline, { needs: '', rest: '2 agents at work.' });
  assert.deepEqual(view(shown([]), null, NOW).headline, { needs: '', rest: 'All quiet. Nothing needs you.' });
  assert.deepEqual(view(shown([ask, job({ state: 'ended', outcome: 'needs-input', question: '?' })]), null, NOW).headline, { needs: '2 jobs need you.', rest: '' });
  // A picked project counts only its own jobs.
  assert.equal(view({ ...d, jobs: [...d.jobs, job({ repo: 'site', state: 'running', started: ago(1) })] }, 'site', NOW).headline.rest, '1 agent at work.');
});

// Protects: THIS WEEK counts only the last 7 days, and merged only closed PRs that merged. Fails when: an older job or an unmerged PR is counted, or the median is the mean.
test('this week counts merged PRs, gates passed first time, cost per merged PR and the median finished job over 7 days', () => {
  const day = 24 * 60;
  const done = (took: number, cost: number, endedAgo: number, fix_rounds?: number) => job({ state: 'ended', outcome: 'pr', started: ago(endedAgo + took), ended: ago(endedAgo), cost_usd: cost, ...(fix_rounds === undefined ? {} : { fix_rounds }) });
  const jobs = [done(10, 1, 60, 0), done(30, 2.5, day, 2), done(20, 4, 6 * day), done(99, 50, 8 * day), job({ state: 'ended', outcome: 'needs-input', question: '?', ended: ago(5) })];
  const d = { ...shown(jobs), closed: [
    { job: jobs[0]!.id as number, number: 1, merged: true, at: ago(30) },
    { job: jobs[1]!.id as number, number: 2, merged: false, at: ago(30) },
    { job: jobs[3]!.id as number, number: 3, merged: true, at: ago(8 * day) },
  ] };
  assert.deepEqual(view(d, null, NOW).week, { merged: '1', firstPass: '50%', perMerged: '$7.50', median: '20m' });
  assert.deepEqual(view(shown([]), null, NOW).week, { merged: '0', firstPass: '–', perMerged: '–', median: '–' });
  // A merged PR's tick is in the merged colour.
  assert.deepEqual(view(d, null, NOW).projects[0]!.ticks.slice(0, 2), ['merged', 'ended']);
});

// Protects: FINISHED lists every job that is over, tagged with what became of it. Fails when: a merged or closed PR is not told apart, a PR GitHub has not answered about is guessed, an open PR or a waiting job is listed twice, or a failure loses its reason.
test('finished lists the jobs that ended, newest first, with the PR\'s fate from GitHub and failures with their reasons', () => {
  const pr = (n: number) => `https://github.com/o/r/pull/${n}`;
  const d: Display = { ...shown([
    job({ id: 1, state: 'ended', outcome: 'pr', pr: pr(112), started: ago(40), ended: ago(18) }),
    job({ id: 2, state: 'ended', outcome: 'draft-pr', pr: pr(31) }),
    job({ id: 3, state: 'ended', outcome: 'failed', ended: ago(5), reason: 'the GitHub token in the env file does not work' }),
    job({ id: 4, state: 'cancelled', started: ago(10), ended: ago(9.25), person: 'ben' }),
    job({ id: 5, state: 'ended', outcome: 'dry-run', started: ago(11), ended: ago(0), cost_usd: 0 }),
    job({ id: 6, state: 'ended', outcome: 'needs-input', question: '?' }),
    job({ id: 7, state: 'ended', outcome: 'pr', pr: pr(7) }),
    job({ id: 8, state: 'ended', outcome: 'pr', pr: pr(8) }),
    job({ id: 9, state: 'stopped', resume: 'animus resume 9' }),
  ]),
  prs: [{ job: 7, repo: 'app', person: 'ana', number: 7, title: 't', url: pr(7), draft: false, created: ago(1) }],
  closed: [{ job: 1, number: 112, merged: true, at: ago(2) }, { job: 8, number: 8, merged: false, at: ago(3) }] };
  const v = view(d, null, NOW);
  assert.deepEqual(v.finished.map((r) => [r.id, r.tag, r.tone, r.repo, r.person, r.personPage, r.meta, r.reason]), [
    [9, 'Stopped', 'fail', 'app', 'ana', '/people/ana', '', 'It stopped before it ended. To carry on: animus resume 9'],
    [8, 'Closed #8', 'mute', 'app', 'ana', '/people/ana', 'not merged', undefined],
    [5, 'Dry run', 'mute', 'app', 'ana', '/people/ana', '11m · $0.00', undefined],
    [4, 'Cancelled', 'mute', 'app', 'ben', '/people/ben', '45s', undefined],
    [3, 'Failed', 'fail', 'app', 'ana', '/people/ana', '', 'the GitHub token in the env file does not work'],
    [2, 'PR #31', 'ink', 'app', 'ana', '/people/ana', '', undefined],
    [1, 'Merged #112', 'merged', 'app', 'ana', '/people/ana', '22m · merged in 16m', undefined],
  ]);
  assert.deepEqual(v.prs.map((p) => p.id), [7]);
});

// Protects: a section with nothing in it is not drawn. Fails when: WAITING, OPEN PRS or FINISHED keeps a heading with no rows.
test('a section with no rows is empty for the display to leave out', () => {
  const v = view(shown([job({ state: 'running', started: ago(1) })]), null, NOW);
  assert.deepEqual([v.needs.length, v.line.length, v.prs.length, v.finished.length], [0, 0, 0, 0]);
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
  assert.deepEqual([all.title, all.sel, all.live.length, all.needs.length + all.line.length, all.finished.length], ['All projects', undefined, 1, 3, 3]);

  const app = view(d, 'app', NOW);
  assert.deepEqual(app.sel, { id: 'app', base: 'main', gates: 'test, typecheck', prs: 1, spent: '$1.75' });
  assert.deepEqual([app.title, app.projects[0]!.on, [...app.needs, ...app.line].map((w) => w.id)], ['app', true, [3, 6]]);
  // The queue's order is the machine's, not the project's.
  assert.match(app.line[0]!.note, /^Position 2 in the queue/);
  // A project Helix no longer has is the same as none picked.
  assert.equal(view(d, 'gone', NOW).sel, undefined);
});

test('with no job to list, the display says so and how to send one', () => {
  const none = view(shown([], 8), null, NOW);
  assert.deepEqual(none.empty, { title: 'Nothing is running', text: 'No job has been submitted to this machine yet. From any project, send a spec:', free: '8 of 8 slots free', command: 'animus submit <spec file>' });
  const d = shown([job({ repo: 'app', state: 'running', started: ago(1) })], 8);
  assert.deepEqual(view(d, 'site', NOW).empty, { title: 'No jobs for site yet', text: 'Nobody has sent this project a spec. From its folder, run:', free: '7 of 8 slots free', command: 'animus submit <spec file>' });
  assert.equal(view(d, 'app', NOW).empty, undefined);
  assert.equal(view(shown([job({ state: 'queued' })], 1), null, NOW).noLive, 'No agent is working right now. The one slot is free.');
});

test('times read at a glance', () => {
  assert.deepEqual([clock(0), clock(462_000), clock(7_925_000), clock(-5)], ['00:00', '07:42', '132:05', '00:00']);
  assert.deepEqual([span(45_000), span(60_000), span(22 * 60_000), span(190 * 60_000)], ['45s', '1m', '22m', '3h 10m']);
});

// Protects: the idle animation only shows when nothing runs or is queued and no project is picked. Fails when: a queued job, a running job or a picked project still gets the animation, or a job waiting for an answer keeps it away.
test('the idle animation shows only with nothing running or queued and no project picked', () => {
  const asking = job({ repo: 'app', state: 'ended', outcome: 'needs-input', question: '?' });
  assert.equal(view(shown([], 8), null, NOW).idle, true);
  assert.equal(view(shown([asking], 8), null, NOW).idle, true);
  assert.equal(view(shown([job({ state: 'running', started: ago(1) })], 8), null, NOW).idle, false);
  assert.equal(view(shown([job({ state: 'queued' })], 8), null, NOW).idle, false);
  // A job on another project still counts: the slots are machine-wide.
  assert.equal(view(shown([job({ repo: 'site', state: 'running', started: ago(1) })], 8), 'app', NOW).idle, false);
  assert.equal(view(shown([asking], 8), 'app', NOW).idle, false);
  // A picked project Helix no longer has is the same as none picked.
  assert.equal(view(shown([], 8), 'gone', NOW).idle, true);
});

// Protects: the idle helix's rungs are out of phase under the CSP (style-src 'self' drops style attributes). Fails when app.ts sets a rung's pose inline, or helix.css lacks a pose and phase for one of the 16 rungs.
test('the idle helix gives every rung its pose and phase in the stylesheet, not in a style attribute', () => {
  const css = readFileSync(new URL('../../plugin/display/helix.css', import.meta.url), 'utf8');
  const app = readFileSync(new URL('../../plugin/display/app.ts', import.meta.url), 'utf8');
  const phases = [...css.matchAll(/\.sync-helix > :nth-child\((\d+)\) > \.sync-rung \{ --s: [-\d.]+; animation-delay: (-?[\d.]+)s; \}/g)].map((m) => m[2]);
  assert.equal(new Set(phases).size, 16);
  assert.doesNotMatch(app, /style="/);
});

// Protects: a running job is listed once, and a closed PR's finished row says it was not merged. Fails when: a running job also shows under Finished, or a merge time is not worked out from the job's end.
test('a running job shows only under working now, and a finished row says how long its PR took to merge', () => {
  const d: Display = { ...shown([
    job({ id: 1, state: 'running', started: ago(1) }),
    job({ id: 2, state: 'ended', outcome: 'pr', pr: 'https://github.com/o/r/pull/2', started: ago(60), ended: ago(30) }),
  ]), closed: [{ job: 2, number: 2, merged: true, at: ago(-150) }] };
  const v = view(d, null, NOW);
  assert.deepEqual([v.live.map((j) => j.id), v.finished.map((j) => [j.id, j.tag, j.meta])], [[1], [[2, 'Merged #2', '30m · merged in 3h 00m']]]);
});
