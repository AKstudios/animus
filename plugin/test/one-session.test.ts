// --one-session: a medium or large spec goes to one implementer session, with no planner.
import assert from 'node:assert/strict';
import { spawnSync } from 'node:child_process';
import { test } from 'node:test';
import { fixTarget } from '../src/fix.ts';
import { loadState } from '../src/log.ts';
import { runJob } from '../src/pipeline.ts';
import { git } from '../src/proc.ts';
import { clean, cli, deps, done, fakeAgent, makeRepo, write, writeSpec, type Step } from './helpers.ts';

const LARGE = 'size: large\ndifficulty: routine\ntype: feature';
const CRITERIA = '1. The feature says done.\n   $ grep -q done src/feature.txt\n2. The second file says two.\n   $ grep -q two src/second.txt\n';
const both: Step = (req) => {
  write(req.cwd, 'src/feature.txt', 'done\n');
  write(req.cwd, 'src/second.txt', 'two\n');
  git(req.cwd, ['add', '-A']);
  git(req.cwd, ['commit', '-q', '--allow-empty', '-m', 'both files']);
  return { ...done('Both files.'), session: 's1' };
};
const roles = (calls: { role: string }[]) => calls.map((c) => c.role);

// Protects: criteria 1 and 2. Fails when: the planner is asked, the criteria are split between sessions, or the record does not say the person chose it.
test('a large spec with oneSession asks no planner, runs one implementer session with every criterion, and the record says the person chose it', async () => {
  const repo = makeRepo();
  const { agent, calls } = fakeAgent([both, () => clean(2)]);
  const run = await runJob({ repo, specFile: writeSpec(LARGE, CRITERIA), oneSession: true }, deps(agent));

  assert.equal(run.outcome, 'pr');
  assert.deepEqual(roles(calls), ['implementer', 'reviewer']);
  assert.match(calls[0]!.prompt, /The feature says done\.[\s\S]*The second file says two\./);
  assert.deepEqual(run.slices, { by: 'person', planned: 1, done: 1 });
});

// Protects: criterion 5. Fails when: a job picked up again, or a fix of it, asks the planner or loses that the person chose one session.
test('a one-session job that is resumed, then fixed, asks no planner and stays one session', async () => {
  const repo = makeRepo();
  const asking: Step = () => ({ output: { status: 'needs-input', summary: '', question: 'Two, or 2?' }, session: 's1' });
  const stopped = await runJob({ repo, specFile: writeSpec(LARGE, CRITERIA), oneSession: true }, deps(fakeAgent([asking]).agent));
  assert.equal(stopped.outcome, 'needs-input');
  assert.equal(loadState(stopped.job)!.one_session, true);

  const resumed = fakeAgent([both, () => clean(2)]);
  const run = await runJob({ repo, resume: { state: loadState(stopped.job)!, answer: 'Two.' } }, deps(resumed.agent));
  assert.equal(run.outcome, 'pr');
  assert.deepEqual(roles(resumed.calls), ['implementer', 'reviewer']);
  assert.equal(run.slices!.by, 'person');

  const { run: opened, state } = fixTarget(repo, '1', () => 'OPEN');
  const fixing = fakeAgent([both, () => clean(2)]);
  const fixed = await runJob({ repo, fix: { of: opened.job, from: state!, ask: 'Say it twice', pr: opened.pr! } }, deps(fixing.agent));
  assert.deepEqual(roles(fixing.calls), ['implementer', 'reviewer']);
  assert.deepEqual(fixed.slices, { by: 'person', planned: 1, done: 1 });
});

// Protects: criterion 3. Fails when: plan --one-session asks for a planner session (it would need a model) or does not say the spec is one slice.
test('animus plan --one-session prints the spec as one slice without asking a planner', () => {
  const r = spawnSync(process.execPath, ['--disable-warning=ExperimentalWarning', cli, 'plan', writeSpec(LARGE, CRITERIA), '--one-session', '--repo', makeRepo()], { encoding: 'utf8', env: process.env });
  assert.equal(r.status, 0, r.stdout + r.stderr);
  assert.match(r.stdout, /one slice \(one session, as asked: no planner session\)/);
  assert.match(r.stdout, /criteria {2}1\. The feature says done\.\n {17}2\. The second file says two\./);
});
