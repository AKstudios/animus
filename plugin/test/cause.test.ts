import assert from 'node:assert/strict';
import { test } from 'node:test';
import { dirname } from 'node:path';
import { CANCELLED_MARKER, readRuns } from '../src/log.ts';
import { runJob } from '../src/pipeline.ts';
import { git } from '../src/proc.ts';
import { clean, deps, done, fakeAgent, makeRepo, write, writeSpec, type Step } from './helpers.ts';

const SMALL = 'size: small\ndifficulty: routine\ntype: feature';
const say = (text: string): Step => (req) => {
  write(req.cwd, 'src/feature.txt', `${text}\n`);
  git(req.cwd, ['add', '-A']); git(req.cwd, ['commit', '-qm', `say ${text}`]);
  return done();
};
const blocked = () => ({ output: { status: 'reviewed', summary: 'Still wrong.', criteria: [], findings: [{ severity: 'blocker', problem: 'It is wrong.' }] } });

// Protects: criterion 3. Fails when: a run that did not deliver has no cause, or the wrong one, or loses the checks / blockers.
const cases: { name: string; steps: Step[]; spec?: string; cause: string; extra: Record<string, unknown> }[] = [
  { name: 'gates', steps: [say('no'), say('still no'), say('never')], cause: 'gates', extra: { failing_checks: ['acceptance-1'] } },
  { name: 'review', steps: [say('done'), blocked, say('done please'), blocked], cause: 'review', extra: { blockers_left: 1 } },
  { name: 'needs-input', steps: [() => ({ output: { status: 'needs-input', summary: '', question: 'Which?' } })], cause: 'needs-input', extra: {} },
  { name: 'budget', steps: [() => ({ ok: false, status: 'error_max_budget_usd' })], cause: 'budget', extra: {} },
  { name: 'context', steps: [() => ({ ok: false, status: 'prompt is too long' })], cause: 'context', extra: {} },
  { name: 'agent-error', steps: [() => ({ ok: false, status: 'error_max_turns' })], cause: 'agent-error', extra: {} },
];
for (const c of cases) {
  test(`a run that stops at ${c.name} has cause ${c.cause} in the run log`, async () => {
    const { agent } = fakeAgent(c.steps);
    const run = await runJob({ repo: makeRepo(), specFile: writeSpec(SMALL) }, deps(agent));
    const logged = readRuns().find((r) => r.job === run.job)!;
    assert.equal(logged.cause, c.cause);
    for (const [k, v] of Object.entries(c.extra)) assert.deepEqual(logged[k as 'cause'], v);
  });
}

test('a large spec whose cut is refused twice has cause plan', async () => {
  const bad = { brief: 'b', slices: [{ title: 'Half', delivers: 'Half of it.', criteria: [1], after: [] }] };
  const criteria = '1. One.\n   $ true\n2. Two.\n   $ true\n';
  const run = await runJob({ repo: makeRepo(), specFile: writeSpec('size: large\ndifficulty: routine\ntype: feature', criteria) }, deps(fakeAgent([() => ({ output: bad }), () => ({ output: bad })]).agent));
  assert.equal(readRuns().find((r) => r.job === run.job)!.cause, 'plan');
});

test('a spec refused at admission leaves a run with cause admit and starts no agent', async () => {
  const { agent, calls } = fakeAgent([]);
  const repo = makeRepo();
  await assert.rejects(runJob({ repo, specFile: writeSpec('size: small\ndifficulty: routine\ntype: bug', '1. The feature says done.\n') }, deps(agent)), /needs a `\$ command`/);
  const line = readRuns().find((r) => r.repo === repo)!;
  assert.deepEqual([line.cause, line.outcome, line.type, calls.length], ['admit', 'failed', 'bug', 0]);
});

// Protects: criterion 3's cancelled and interrupted. Fails when a signalled job leaves no run, or Helix's marker is ignored.
for (const [name, marked, cause] of [['a SIGTERM with no marker', false, 'interrupted'], ['a SIGTERM after Helix marked the job cancelled', true, 'cancelled']] as const) {
  test(`${name} leaves a run with cause ${cause}`, async () => {
    const repo = makeRepo();
    const specFile = writeSpec(SMALL);
    if (marked) write(dirname(specFile), CANCELLED_MARKER, '');
    const ended = new Error('exit');
    const { agent } = fakeAgent([() => { process.emit('SIGTERM', 'SIGTERM'); return done(); }]);
    await assert.rejects(runJob({ repo, specFile }, { ...deps(agent), exit: (code) => { assert.equal(code, 143); throw ended; } }), ended);
    const line = readRuns().find((r) => r.repo === repo)!;
    assert.deepEqual([line.cause, line.outcome], [cause, 'failed']);
  });
}

test('a run that ends as a pull request has no cause', async () => {
  const { agent } = fakeAgent([say('done'), () => clean()]);
  const run = await runJob({ repo: makeRepo(), specFile: writeSpec(SMALL) }, deps(agent));
  assert.equal(run.outcome, 'pr');
  assert.equal(readRuns().find((r) => r.job === run.job)!.cause, undefined);
});

test('a setup command that fails leaves a run with cause setup', async () => {
  const repo = makeRepo();
  write(repo, '.animus/animus.yaml', 'setup: exit 1\ncommands:\n  test: grep -q done src/feature.txt\n');
  git(repo, ['commit', '-qam', 'failing setup']);
  const run = await runJob({ repo, specFile: writeSpec(SMALL) }, deps(fakeAgent([]).agent));
  assert.deepEqual([run.outcome, readRuns().find((r) => r.job === run.job)!.cause], ['failed', 'setup']);
});
