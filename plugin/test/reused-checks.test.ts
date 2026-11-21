// The gates take over what `animus check` passed in the session, on the same code.
import assert from 'node:assert/strict';
import { spawnSync } from 'node:child_process';
import { existsSync, mkdtempSync, readFileSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { test } from 'node:test';
import { jobDir, readRuns } from '../src/log.ts';
import { runJob } from '../src/pipeline.ts';
import { git } from '../src/proc.ts';
import { clean, cli, deps, done, fakeAgent, makeRepo, write, writeSpec, type Step } from './helpers.ts';

const SMALL = 'size: small\ndifficulty: routine\ntype: feature';
const MEDIUM = 'size: medium\ndifficulty: routine\ntype: feature';

/** A project whose every command writes its name to a tally outside the worktree, so a test sees what ran. */
function project(): { repo: string; tally: string; ran: () => string[] } {
  const tally = join(mkdtempSync(join(tmpdir(), 'animus-ran-')), 'ran.txt');
  const repo = makeRepo();
  write(repo, '.animus/animus.yaml', `commands:\n  test: echo test >> ${tally} && grep -q done src/feature.txt\n`);
  git(repo, ['commit', '-qam', 'tally the test runs']);
  return { repo, tally, ran: () => existsSync(tally) ? readFileSync(tally, 'utf8').split('\n').filter(Boolean) : [] };
}

const check = (cwd: string) => spawnSync(process.execPath, ['--disable-warning=ExperimentalWarning', cli, 'check'], { cwd, env: { ...process.env, HELIX_URL: '', HELIX_TOKEN: '' }, encoding: 'utf8' });

/** The session: the feature says done (committed unless `leave`), `animus check`, then `after` changes the worktree. */
const session = (said: { code?: number | null; out?: string }, after: (cwd: string) => void = () => {}, leave = false): Step => (req) => {
  write(req.cwd, 'src/feature.txt', 'done\n');
  if (!leave) { git(req.cwd, ['add', '-A']); git(req.cwd, ['commit', '-qm', 'say done']); }
  const r = check(req.cwd);
  Object.assign(said, { code: r.status, out: r.stdout });
  after(req.cwd);
  return done();
};

const lastRun = (job: string) => readRuns().find((r) => r.job === job)!;
const checks = (job: string, attempt = 0) => lastRun(job).gates[attempt]!.checks.map((c) => ({ name: c.name, ok: c.ok, reused: Boolean(c.reused) }));

// Protects: criterion 1. Fails when: the gates run a command the session's check passed on the same code, or the reused result loses the session's time and output.
test('after a passing animus check with nothing changed, the gates run no command and reuse each result with its time and output', async () => {
  const { repo, tally, ran } = project();
  const said: { code?: number | null; out?: string } = {};
  const { agent } = fakeAgent([session(said), () => clean()]);
  const run = await runJob({ repo, specFile: writeSpec(SMALL, `1. The feature says done.\n   $ echo acceptance >> ${tally} && sleep 0.2 && echo the session said done\n`) }, deps(agent));

  assert.equal(said.code, 0, said.out);
  assert.equal(run.outcome, 'pr');
  assert.deepEqual(ran(), ['test', 'acceptance']);
  assert.deepEqual(checks(run.job), [{ name: 'test', ok: true, reused: true }, { name: 'acceptance-1', ok: true, reused: true }]);
  const seconds = (lastRun(run.job).gates[0]!.checks[1]!.ms / 1000).toFixed(1);
  assert.notEqual(seconds, '0.0');
  assert.match(said.out!, new RegExp(`ok   acceptance-1: .* \\(${seconds}s\\)`));
  assert.match(readFileSync(join(jobDir(run.job), 'gates', 'run-1.txt'), 'utf8'), /=== acceptance-1: .*\nthe session said done/);
});

// Protects: criterion 2. Fails when: a change after the check, committed or not, leaves the gates reusing results from other code.
const CHANGES: [string, (cwd: string) => void][] = [
  ['a file changed and committed', (cwd) => { write(cwd, 'src/feature.txt', 'done, and more\n'); git(cwd, ['commit', '-qam', 'more']); }],
  ['a file added and left uncommitted', (cwd) => write(cwd, 'src/new.txt', 'new\n')],
  ['a file deleted and left uncommitted', (cwd) => rmSync(join(cwd, 'src/app.txt'))],
];
for (const [what, change] of CHANGES) {
  test(`${what} after a passing animus check makes the gates run every check again`, async () => {
    const { repo, tally, ran } = project();
    const said: { code?: number | null; out?: string } = {};
    const { agent } = fakeAgent([session(said, change), () => clean()]);
    const run = await runJob({ repo, specFile: writeSpec(SMALL, `1. The feature says done.\n   $ echo acceptance >> ${tally} && grep -q done src/feature.txt\n`) }, deps(agent));

    assert.equal(said.code, 0, said.out);
    assert.deepEqual(ran(), ['test', 'acceptance', 'test', 'acceptance']);
    assert.deepEqual(checks(run.job), [{ name: 'test', ok: true, reused: false }, { name: 'acceptance-1', ok: true, reused: false }]);
  });
}

// Protects: criterion 3, a failed check. Fails when: the gates reuse a failure, or stop reusing the passes beside it.
test('a check that failed in the session is run by the gates while the ones that passed are reused', async () => {
  const { repo, tally, ran } = project();
  const marker = join(mkdtempSync(join(tmpdir(), 'animus-once-')), 'failed');
  const said: { code?: number | null; out?: string } = {};
  const { agent } = fakeAgent([session(said), () => clean(2)]);
  const criteria = `1. The feature says done.\n   $ echo one >> ${tally} && grep -q done src/feature.txt\n2. The second passes once it has failed.\n   $ echo two >> ${tally} && { [ -f ${marker} ] || { touch ${marker}; exit 1; }; }\n`;
  const run = await runJob({ repo, specFile: writeSpec(SMALL, criteria) }, deps(agent));

  assert.equal(said.code, 1);
  assert.deepEqual(ran(), ['test', 'one', 'two', 'two']);
  assert.deepEqual(checks(run.job), [{ name: 'test', ok: true, reused: true }, { name: 'acceptance-1', ok: true, reused: true }, { name: 'acceptance-2', ok: true, reused: false }]);
});

// Protects: criterion 3, a check skipped for a later slice. Fails when: the gates take a skipped check for a passed one.
test('a check the session skipped for a later slice is run by the gates while the ones that passed are reused', async () => {
  const { repo, tally, ran } = project();
  const cut = { brief: 'Two words.', slices: [
    { title: 'The feature', delivers: 'The feature says done.', criteria: [1], after: [] },
    { title: 'The second', delivers: 'The second check passes.', criteria: [2], after: [1] },
  ] };
  const said: { code?: number | null; out?: string } = {};
  const { agent } = fakeAgent([() => ({ output: cut, session: 'plan' }), session(said), () => done(), () => clean(2)]);
  const criteria = `1. The feature says done.\n   $ echo one >> ${tally} && grep -q done src/feature.txt\n2. The second check passes.\n   $ echo two >> ${tally}\n`;
  const run = await runJob({ repo, specFile: writeSpec(MEDIUM, criteria) }, deps(agent));

  assert.equal(said.code, 0, said.out);
  assert.deepEqual(ran(), ['test', 'one', 'two']);
  assert.deepEqual(checks(run.job, 1), [{ name: 'test', ok: true, reused: true }, { name: 'acceptance-1', ok: true, reused: true }, { name: 'acceptance-2', ok: true, reused: false }]);
});

// Protects: criterion 4. Fails when: the job's commit of the session's leftover work makes the gates take it for new code.
test('leftover work the job commits after a passing animus check does not make the gates run again', async () => {
  const { repo, tally, ran } = project();
  const said: { code?: number | null; out?: string } = {};
  const { agent } = fakeAgent([session(said, () => {}, true), () => clean()]);
  const run = await runJob({ repo, specFile: writeSpec(SMALL, `1. The feature says done.\n   $ echo acceptance >> ${tally} && grep -q done src/feature.txt\n`) }, deps(agent));

  assert.equal(said.code, 0, said.out);
  assert.deepEqual(ran(), ['test', 'acceptance']);
  assert.deepEqual(checks(run.job), [{ name: 'test', ok: true, reused: true }, { name: 'acceptance-1', ok: true, reused: true }]);
});
