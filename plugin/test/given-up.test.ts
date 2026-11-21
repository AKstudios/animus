import assert from 'node:assert/strict';
import { test } from 'node:test';
import { runJob } from '../src/pipeline.ts';
import { git } from '../src/proc.ts';
import { clean, deps, fakeAgent, makeRepo, write, writeSpec, type Step } from './helpers.ts';

const SMALL = 'size: small\ndifficulty: routine\ntype: feature';
const gaveUp = (text: string, commit = true): Step => (req) => {
  write(req.cwd, 'src/feature.txt', `${text}\n`);
  if (commit) { git(req.cwd, ['add', '-A']); git(req.cwd, ['commit', '-qm', `say ${text}`]); }
  return { output: { status: 'failed', summary: 'my test run hung', notes: 'try the gates' } };
};

test('an implementer that gives up after changing code is checked by the gates, and its note goes in the PR', async () => {
  const repo = makeRepo();
  const { agent, calls } = fakeAgent([gaveUp('done'), () => clean()]);
  const d = deps(agent);
  const run = await runJob({ repo, specFile: writeSpec(SMALL) }, d);
  assert.equal(run.outcome, 'pr');
  assert.deepEqual(calls.map((c) => c.role), ['implementer', 'reviewer']);
  assert.equal(d.published[0]!.draft, false);
  assert.match(d.published[0]!.body, /The implementer reported it failed: my test run hung try the gates/);
});

test('work an implementer gave up on and left uncommitted is checked too', async () => {
  const repo = makeRepo();
  const { agent } = fakeAgent([gaveUp('done', false), () => clean()]);
  const run = await runJob({ repo, specFile: writeSpec(SMALL) }, deps(agent));
  assert.equal(run.outcome, 'pr');
});

test('gates that fail after a given-up session go back to the implementer, and the job fails only if they still fail', async () => {
  const repo = makeRepo();
  const { agent, calls } = fakeAgent([gaveUp('no'), gaveUp('still no'), gaveUp('never')]);
  const d = deps(agent);
  const run = await runJob({ repo, specFile: writeSpec(SMALL) }, d);
  assert.equal(run.outcome, 'draft-pr');
  assert.equal(calls.length, 3);
  assert.equal(run.fix_rounds, 2);
  assert.match(run.reason!, /gates still fail after 2 fix round/);
});

test('an implementer that gives up having changed nothing ends the job as failed', async () => {
  const repo = makeRepo();
  const { agent } = fakeAgent([() => ({ output: { status: 'failed', summary: 'cannot' } })]);
  const d = deps(agent);
  const run = await runJob({ repo, specFile: writeSpec(SMALL) }, d);
  assert.equal(run.outcome, 'failed');
  assert.equal(run.reason, "cannot");
  assert.equal(d.published.length, 0);
});

// Protects: the reason says why it stopped. Fails when the reason is the summary of the work.
test('a give-up\'s reason is the implementer\'s notes, else its question, else its summary; the summary stays on the run', async () => {
  const stop = async (output: Record<string, unknown>) => runJob({ repo: makeRepo(), specFile: writeSpec(SMALL) }, deps(fakeAgent([() => ({ output })]).agent));
  const withNotes = await stop({ status: 'failed', summary: 'tried the parser', notes: 'the API has no such call' });
  assert.equal(withNotes.reason, 'the API has no such call');
  assert.equal(withNotes.summary, 'tried the parser');
  assert.equal(withNotes.cause, 'agent-error');
  assert.equal((await stop({ status: 'failed', summary: 'tried', question: 'which API?' })).reason, 'which API?');
  assert.equal((await stop({ status: 'failed', summary: 'cannot' })).reason, 'cannot');
});
