import assert from 'node:assert/strict';
import { mkdtempSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { test } from 'node:test';
import { loadState } from '../src/log.ts';
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

// The job writes src/feature.txt, and the base adds its own while the job runs: the merge conflicts there.
const conflicting = (origin: string, extra: Record<string, string> = {}) => baseMoves(origin, { 'src/feature.txt': 'base\n', ...extra }, say('done'));
const branchMerges = (repo: string, run: { base: string; job: string }) => git(repo, ['rev-list', '--count', '--merges', `${run.base}..animus/${run.job}`]);

test('a conflict goes to a fresh session with the files, the spec and the base\'s commits, and the PR lists what it resolved', async () => {
  const { origin, repo } = cloned();
  const { agent, calls } = fakeAgent([conflicting(origin), () => clean(), say('done')]);
  const d = deps(agent);
  const run = await runJob({ repo, specFile: writeSpec(SMALL) }, d);

  assert.equal(run.outcome, 'pr');
  assert.deepEqual(calls.map((c) => [c.role, c.resume]), [['implementer', undefined], ['reviewer', undefined], ['implementer', undefined]]);
  assert.match(calls[2]!.prompt, /src\/feature\.txt/);
  assert.match(calls[2]!.prompt, /[0-9a-f]{7,} the base moves/);
  assert.match(calls[2]!.prompt, /The feature file should say done\./);
  const moved = git(origin, ['rev-parse', 'main']);
  assert.equal(git(repo, ['rev-parse', `animus/${run.job}^2`]), moved);
  assert.equal(run.gates.at(-1)!.ok, true);
  assert.match(d.published[0]!.body, /Conflicts with main that the implementer resolved: `src\/feature\.txt`/);
});

test('a resolution that leaves conflict markers does not hold, whatever the gates say', async () => {
  const { origin, repo } = cloned();
  // The markers keep "done" in the file, so the gates alone would pass it.
  const { agent } = fakeAgent([conflicting(origin), () => clean(), () => done()]);
  const run = await runJob({ repo, specFile: writeSpec(SMALL) }, deps(agent));

  assert.equal(run.outcome, 'needs-input');
  assert.match(run.question!, /conflict markers are left in src\/feature\.txt/);
  assert.equal(branchMerges(repo, run), '0');
});

test('gates that still fail after a resolution\'s fix rounds end the job as needs input with the conflicting files', async () => {
  const { origin, repo } = cloned();
  const { agent } = fakeAgent([conflicting(origin), () => clean(), say('base'), say('base still'), say('base again')]);
  const run = await runJob({ repo, specFile: writeSpec(SMALL) }, deps(agent));

  assert.equal(run.outcome, 'needs-input');
  assert.match(run.question!, /conflicts in src\/feature\.txt/);
  assert.match(run.question!, /the gates still fail after 2 fix round\(s\)/);
});

test('a session that cannot resolve a conflict asks, and the answer picks the job up at the catch-up', async () => {
  const { origin, repo } = cloned();
  const first = fakeAgent([conflicting(origin), () => clean(), () => ({ output: { status: 'needs-input', summary: '', question: 'Should it say done or base?' } })]);
  const run = await runJob({ repo, specFile: writeSpec(SMALL) }, deps(first.agent));
  assert.equal(run.outcome, 'needs-input');
  assert.match(run.question!, /conflicts in src\/feature\.txt[\s\S]*Should it say done or base\?/);
  assert.equal(branchMerges(repo, run), '0');

  const second = fakeAgent([say('done')]);
  const d = deps(second.agent);
  const again = await runJob({ repo, resume: { state: loadState(run.job)!, answer: 'Done.' } }, d);
  assert.equal(again.outcome, 'pr');
  assert.deepEqual(second.calls.map((c) => [c.role, c.resume]), [['implementer', undefined]]);
  assert.match(second.calls[0]!.prompt, /Should it say done or base\?[\s\S]*Done\./);
  assert.equal(git(repo, ['rev-parse', `animus/${run.job}^2`]), git(origin, ['rev-parse', 'main']));
  assert.match(d.published[0]!.body, /`src\/feature\.txt`/);
});

test('a conflict in a protected path ends the job as needs input with that path, before any session is asked', async () => {
  const { origin, repo } = cloned();
  // A resolving session would be a third call, which the fake agent refuses.
  const { agent } = fakeAgent([baseMoves(origin, { '.github/ci.yml': 'base\n' }, say('done', { '.github/ci.yml': 'job\n' })), () => clean()]);
  const run = await runJob({ repo, specFile: writeSpec(SMALL) }, deps(agent));

  assert.equal(run.outcome, 'needs-input');
  assert.match(run.question!, /protected/);
  assert.match(run.question!, /\.github\/ci\.yml/);
  assert.equal(branchMerges(repo, run), '0');
});
