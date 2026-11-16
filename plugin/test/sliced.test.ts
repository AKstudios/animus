// A job done in slices: the planner's cut, then one fresh session per slice,
// each gated on the criteria of the slices so far, then the whole spec.
import assert from 'node:assert/strict';
import { test } from 'node:test';
import { loadState, readRuns } from '../src/log.ts';
import { runJob } from '../src/pipeline.ts';
import { git } from '../src/proc.ts';
import { clean, deps, done, fakeAgent, makeRepo, write, writeSpec, type Step } from './helpers.ts';

const MEDIUM = 'size: medium\ndifficulty: routine\ntype: feature';
const CRITERIA = '1. The feature says done.\n   $ grep -q done src/feature.txt\n2. The second file says two.\n   $ grep -q two src/second.txt\n3. The third file says three.\n   $ grep -q three src/third.txt\n';
const CUT = {
  brief: 'Each file holds one word.',
  slices: [
    { title: 'The feature', delivers: 'The feature file says done.', criteria: [1], after: [] },
    { title: 'The second file', delivers: 'The second file says two.', criteria: [2], after: [1] },
    { title: 'The third file', delivers: 'The third file says three.', criteria: [3], after: [1] },
  ],
};
const planner: Step = () => ({ output: CUT, session: 'plan' });
const put = (file: string, text: string, session: string): Step => (req) => {
  write(req.cwd, file, `${text}\n`);
  git(req.cwd, ['add', '-A']);
  git(req.cwd, ['commit', '-q', '--allow-empty', '-m', `${file} says ${text}`]);
  return { ...done(`${file} says ${text}.`), session };
};
const one = put('src/feature.txt', 'done', 's1');
const two = put('src/second.txt', 'two', 's2');
const three = put('src/third.txt', 'three', 's3');

test('a medium job is cut by the planner and done slice by slice, each in a fresh session gated on the criteria so far, then reviewed whole', async () => {
  const repo = makeRepo();
  const { agent, calls } = fakeAgent([planner, one, two, three, () => clean(3)]);
  const d = deps(agent);
  const run = await runJob({ repo, specFile: writeSpec(MEDIUM, CRITERIA) }, d);

  assert.equal(run.outcome, 'pr');
  assert.deepEqual(calls.map((c) => [c.role, Boolean(c.readOnly), c.resume]), [
    ['planner', true, undefined], ['implementer', false, undefined], ['implementer', false, undefined], ['implementer', false, undefined], ['reviewer', true, undefined],
  ]);
  assert.deepEqual(run.agents.map((a) => a.stage), ['plan-1', 'slice-1', 'slice-2', 'slice-3', 'review-1']);
  assert.deepEqual(run.slices, { by: 'planner', planned: 3, done: 3 });
  assert.ok(run.skills.includes('to-tickets'));

  // A slice's session is told its slice, its criteria, what is done, what is left, and the brief.
  const second = calls[2]!.prompt;
  assert.match(second, /done in 3 slices[\s\S]*You do slice 2, and only that one\./);
  assert.match(second, /Your slice: The second file\nWhen it is done: The second file says two\./);
  assert.match(second, /criteria your slice finishes[^\n]*\n2\. The second file says two\.\n   \$ grep -q two src\/second\.txt\n\n/);
  assert.match(second, /Done by the sessions before you[^\n]*\n1\. The feature: src\/feature\.txt says done\.\n\n/);
  assert.match(second, /Do not build these or write their tests:\n3\. The third file \(criteria 3\)\n\n/);
  assert.match(second, /Each file holds one word\./);
  assert.match(second, /\$ grep -q two src\/second\.txt\n\nThe whole spec follows/);
  assert.doesNotMatch(second.split('The whole spec follows')[0]!.split('Run them yourself')[1]!, /third/);

  // Slices one and two are gated on the criteria so far; the last is gated with the whole spec.
  const gates = d.lines.filter((l) => /^gates/.test(l));
  assert.deepEqual(gates.map((l) => l.split(':')[0]), ['gates for slice 1 of 3, run 1', 'gates for slice 2 of 3, run 2', 'gates, run 3']);
  assert.deepEqual(run.gates[0]!.checks.map((c) => [c.name, c.skipped]), [['test', true], ['acceptance-1', false], ['acceptance-2', true], ['acceptance-3', true]]);
  assert.deepEqual(run.gates[2]!.checks.filter((c) => !c.skipped).map((c) => c.name), ['acceptance-1', 'acceptance-2', 'acceptance-3']);

  assert.match(d.published[0]!.body, /^Done in this order[^\n]*\n\n1\. \*\*The feature\*\*: src\/feature\.txt says done\.\n2\. \*\*The second file\*\*: src\/second\.txt says two\.\n3\. \*\*The third file\*\*: src\/third\.txt says three\.\n/);
});

test('a slice whose gates fail gets its own fix rounds in its own session, and one that still fails ends the job with the slices not done', async () => {
  const repo = makeRepo();
  const wrong = put('src/second.txt', 'tow', 's2');
  const { agent, calls } = fakeAgent([planner, one, wrong, wrong, wrong]);
  const d = deps(agent);
  const run = await runJob({ repo, specFile: writeSpec(MEDIUM, CRITERIA) }, d);

  assert.equal(run.outcome, 'draft-pr');
  assert.match(run.reason!, /the gates for slice 2 of 3 still fail after 2 fix round\(s\)/);
  assert.deepEqual(calls.map((c) => c.resume), [undefined, undefined, undefined, 's2', 's2']);
  assert.deepEqual(run.slices, { by: 'planner', planned: 3, done: 1 });
  assert.match(d.published[0]!.body, /2\. \*\*The second file\*\*: \*not finished\*\n3\. \*\*The third file\*\*: \*not finished\*/);
});

test('a slice that stops to ask is picked up in its own session with the cut kept, and the later slices follow', async () => {
  const repo = makeRepo();
  const first = fakeAgent([planner, one, () => ({ output: { status: 'needs-input', summary: '', question: 'Two, or 2?' }, session: 's2' })]);
  const run = await runJob({ repo, specFile: writeSpec(MEDIUM, CRITERIA) }, deps(first.agent));
  assert.equal(run.outcome, 'needs-input');
  assert.deepEqual(loadState(run.job)!.slices_done, ['src/feature.txt says done.']);

  const second = fakeAgent([two, three, () => clean(3)]);
  const d = deps(second.agent);
  const again = await runJob({ repo, resume: { state: loadState(run.job)!, answer: 'Two.' } }, d);
  assert.equal(again.outcome, 'pr');
  assert.deepEqual(second.calls.map((c) => [c.role, c.resume]), [['implementer', 's2'], ['implementer', undefined], ['reviewer', undefined]]);
  assert.match(second.calls[0]!.prompt, /The person's answer: Two\./);
  assert.match(second.calls[1]!.prompt, /You do slice 3, and only that one\./);
  assert.deepEqual(readRuns().filter((r) => r.job === run.job).map((r) => r.slices?.done), [1, 3]);
});

test('what the review sends back after the last slice goes to that slice\'s session, and the finished branch has its own gate rounds', async () => {
  const repo = makeRepo();
  const blocker = { output: { status: 'reviewed', summary: 'One blocker.', criteria: [], findings: [{ severity: 'blocker', problem: 'three is misspelt' }] } };
  const { agent, calls } = fakeAgent([planner, put('src/feature.txt', 'no', 's1'), one, two, three, () => blocker, three, () => clean(3)]);
  const run = await runJob({ repo, specFile: writeSpec(MEDIUM, CRITERIA) }, deps(agent));
  assert.equal(run.outcome, 'pr');
  assert.deepEqual(calls.map((c) => c.resume), [undefined, undefined, 's1', undefined, undefined, undefined, 's3', undefined]);
  assert.equal(run.fix_rounds, 1);
});

test('a cut the check refuses twice does not stop the job: it runs as one slice, as it did before there was a planner', async () => {
  const repo = makeRepo();
  const bad = { brief: 'b', slices: [{ title: 'Half', delivers: 'Half of it.', criteria: [1], after: [] }] };
  const all: Step = (req) => { one(req); two(req); return three(req); };
  const { agent, calls } = fakeAgent([() => ({ output: bad }), () => ({ output: bad }), all, () => clean(3)]);
  const d = deps(agent);
  const run = await runJob({ repo, specFile: writeSpec(MEDIUM, CRITERIA) }, d);
  assert.equal(run.outcome, 'pr');
  assert.deepEqual(calls.map((c) => c.role), ['planner', 'planner', 'implementer', 'reviewer']);
  assert.equal(run.slices?.by, 'script');
  assert.match(run.slices!.fallback!, /refused twice/);
  assert.match(d.lines.join('\n'), /no plan was taken, so the job runs as one slice/);
  assert.match(calls[2]!.prompt, /^Job [^\n]*You are in a fresh worktree/);
  assert.doesNotMatch(d.published[0]!.body, /Done in this order/);
});
