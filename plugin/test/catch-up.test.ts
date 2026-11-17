import assert from 'node:assert/strict';
import { mkdtempSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { test } from 'node:test';
import { runJob } from '../src/pipeline.ts';
import { git } from '../src/proc.ts';
import { clean, deps, done, fakeAgent, makeRepo, write, writeSpec, type Step } from './helpers.ts';

const SMALL = 'size: small\ndifficulty: routine\ntype: feature';

/** A clone of a fresh project: the job fetches its base from the origin, which the test moves while the job runs. */
function cloned(): { origin: string; repo: string } {
  const origin = makeRepo();
  const repo = join(mkdtempSync(join(tmpdir(), 'animus-clone-')), 'project');
  git(origin, ['clone', '-q', origin, repo]);
  return { origin, repo };
}

const commit = (dir: string, message: string, files: Record<string, string>) => {
  for (const [file, text] of Object.entries(files)) write(dir, file, text);
  git(dir, ['add', '-A']);
  git(dir, ['commit', '-qm', message]);
};

const say = (text: string, extra: Record<string, string> = {}): Step => (req) => {
  commit(req.cwd, `say ${text}`, { 'src/feature.txt': `${text}\n`, ...extra });
  return done();
};

/** Runs a step after the base gained a commit in the origin. */
const baseMoves = (origin: string, files: Record<string, string>, step: Step): Step => (req) => {
  commit(origin, 'the base moves', files);
  return step(req);
};

test('a base that moved during the job is merged in with one merge commit, every gate runs again, and the PR names the commit', async () => {
  const { origin, repo } = cloned();
  const { agent, calls } = fakeAgent([baseMoves(origin, { 'src/other.txt': 'other\n' }, say('done')), () => clean()]);
  const d = deps(agent);
  const run = await runJob({ repo, specFile: writeSpec(SMALL) }, d);

  assert.equal(run.outcome, 'pr');
  const moved = git(origin, ['rev-parse', 'main']);
  const branch = `animus/${run.job}`;
  assert.equal(git(repo, ['rev-parse', `${branch}^2`]), moved);
  assert.equal(git(repo, ['rev-list', '--count', '--merges', `${run.base}..${branch}`]), '1');
  assert.equal(calls.length, 2);
  assert.deepEqual(run.gates.map((g) => [g.ok, g.checks.find((c) => c.name === 'acceptance-1')?.skipped]), [[true, false], [true, false]]);
  assert.match(d.published[0]!.body, new RegExp(`Caught up with main at ${moved}`));
});

test('a base that did not move is not merged and no gate runs again', async () => {
  const { repo } = cloned();
  const { agent } = fakeAgent([say('done'), () => clean()]);
  const d = deps(agent);
  const run = await runJob({ repo, specFile: writeSpec(SMALL) }, d);

  assert.equal(run.outcome, 'pr');
  assert.equal(git(repo, ['rev-list', '--count', '--merges', `${run.base}..animus/${run.job}`]), '0');
  assert.equal(run.gates.length, 1);
  assert.doesNotMatch(d.published[0]!.body, /Caught up/);
});

test('gates that fail after a clean catch-up go back to the implementer with two fix rounds of their own, and the PR opens once they pass', async () => {
  const { origin, repo } = cloned();
  // The job's code names src/app.txt, which the base renames while the job runs.
  const spec = writeSpec(SMALL, '1. The feature says done and names a file that exists.\n   $ grep -q done src/feature.txt && test -f "$(cat src/uses.txt)"\n');
  const rename: Step = (req) => {
    git(origin, ['mv', 'src/app.txt', 'src/main.txt']);
    git(origin, ['commit', '-qm', 'rename app to main']);
    return say('done', { 'src/uses.txt': 'src/app.txt\n' })(req);
  };
  const { agent, calls } = fakeAgent([
    say('nearly', { 'src/uses.txt': 'src/app.txt\n' }),
    rename,
    () => clean(),
    say('done still', { 'src/uses.txt': 'src/missing.txt\n' }),
    say('done', { 'src/uses.txt': 'src/main.txt\n' }),
  ]);
  const d = deps(agent);
  const run = await runJob({ repo, specFile: spec }, d);

  assert.equal(run.outcome, 'pr');
  assert.deepEqual(calls.map((c) => c.role), ['implementer', 'implementer', 'reviewer', 'implementer', 'implementer']);
  assert.deepEqual(run.gates.map((g) => g.ok), [false, true, false, false, true]);
  assert.equal(run.fix_rounds, 3);
  const moved = git(origin, ['rev-parse', 'main']);
  assert.match(calls[3]!.prompt, new RegExp(`merged main at ${moved}`));
  assert.match(calls[3]!.prompt, /FAIL acceptance-1/);
  assert.deepEqual(d.published.map((p) => p.draft), [false]);
  assert.match(d.published[0]!.body, new RegExp(`Caught up with main at ${moved}`));
});

test('a job that failed opens its draft PR after the same catch-up', async () => {
  const { origin, repo } = cloned();
  const { agent } = fakeAgent([baseMoves(origin, { 'src/other.txt': 'other\n' }, say('no')), say('still no'), say('never')]);
  const d = deps(agent);
  const run = await runJob({ repo, specFile: writeSpec(SMALL) }, d);

  assert.equal(run.outcome, 'draft-pr');
  const moved = git(origin, ['rev-parse', 'main']);
  assert.equal(git(repo, ['rev-parse', `animus/${run.job}^2`]), moved);
  assert.match(d.published[0]!.body, new RegExp(`Caught up with main at ${moved}`));
});
