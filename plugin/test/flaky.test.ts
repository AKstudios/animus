import assert from 'node:assert/strict';
import { mkdtempSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
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
// Fails the first time it runs and passes after: the marker lives outside the worktree.
const flakyCriteria = (marker: string) => `1. The feature says done.\n   $ grep -q done src/feature.txt && { [ -f ${marker} ] || { touch ${marker}; exit 1; }; }\n`;

// Protects: criterion 2. Fails when: a check that passes on the second run still sends the work back, or the run log and output do not name it.
test('a check that fails then passes on the same tree is accepted, marked flaky and announced', async () => {
  const marker = join(mkdtempSync(join(tmpdir(), 'flaky-')), 'ran');
  const { agent, calls } = fakeAgent([say('done'), () => clean()]);
  const d = deps(agent);
  const run = await runJob({ repo: makeRepo(), specFile: writeSpec(SMALL, flakyCriteria(marker)) }, d);

  assert.equal(run.outcome, 'pr');
  assert.equal(run.fix_rounds, 0);
  assert.equal(calls.length, 2);
  const gate = readRuns().find((r) => r.job === run.job)!.gates[0]!;
  assert.deepEqual(gate.checks.filter((c) => c.flaky).map((c) => c.name), ['acceptance-1']);
  assert.ok(d.lines.includes('flaky: acceptance-1 failed, then passed on the same code'));
});

// Protects: criterion 2's "as now". Fails when: a check failing twice is accepted as flaky.
test('a check that fails twice sends the work back and is not marked flaky', async () => {
  const { agent } = fakeAgent([say('no'), say('done'), () => clean()]);
  const run = await runJob({ repo: makeRepo(), specFile: writeSpec(SMALL) }, deps(agent));

  assert.equal(run.fix_rounds, 1);
  assert.deepEqual(readRuns().find((r) => r.job === run.job)!.gates.flatMap((g) => g.checks.filter((c) => c.flaky)), []);
});
