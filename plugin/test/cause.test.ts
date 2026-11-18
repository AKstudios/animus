import assert from 'node:assert/strict';
import { test } from 'node:test';
import { readRuns } from '../src/log.ts';
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
