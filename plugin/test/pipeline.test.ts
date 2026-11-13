import assert from 'node:assert/strict';
import { existsSync, readFileSync } from 'node:fs';
import { join } from 'node:path';
import { test } from 'node:test';
import { loadState, readRuns } from '../src/log.ts';
import { runJob } from '../src/pipeline.ts';
import { git, AnimusError } from '../src/proc.ts';
import { clean, deps, done, fakeAgent, makeRepo, write, writeSpec, type Step } from './helpers.ts';

const SMALL = 'size: small\ndifficulty: routine\ntype: feature';
const say = (text: string, commit = true): Step => (req) => {
  write(req.cwd, 'src/feature.txt', `${text}\n`);
  if (commit) { git(req.cwd, ['add', '-A']); git(req.cwd, ['commit', '-qm', `say ${text}`]); }
  return done();
};

test('a small job is implemented, gated, reviewed by a fresh read-only session, and opened as a PR', async () => {
  const repo = makeRepo();
  const { agent, calls } = fakeAgent([say('done'), () => clean()]);
  const d = deps(agent);
  const run = await runJob({ repo, specFile: writeSpec(SMALL) }, d);

  assert.equal(run.outcome, 'pr');
  assert.equal(run.pr, 'https://example.test/pr/1');
  assert.deepEqual(d.published.map((p) => [p.branch, p.draft]), [[`animus/${run.job}`, false]]);
  assert.deepEqual(calls.map((c) => [c.role, c.tier, c.effort, Boolean(c.readOnly), c.resume]), [
    ['implementer', 'standard', 'medium', false, undefined],
    ['reviewer', 'fast', 'medium', true, undefined],
  ]);
  assert.match(calls[1]!.prompt, /git diff [0-9a-f]{40}\.\.\.HEAD/);
  // The branch holds the work; the worktree is gone.
  assert.equal(git(repo, ['show', `animus/${run.job}:src/feature.txt`]), 'done');
  assert.ok(!existsSync(calls[0]!.cwd));
  // The body shows each criterion with its check's result and the reviewer's verdict.
  const body = d.published[0]!.body;
  assert.match(body, /\| 1 \| The feature says done\. \| passed: `grep -q done src\/feature\.txt` \| met: src\/feature\.txt \|/);
  assert.match(body, /Nothing flagged/);
});

test('every run writes one line to the run log', async () => {
  const repo = makeRepo();
  const { agent } = fakeAgent([say('done'), () => clean()]);
  const run = await runJob({ repo, specFile: writeSpec(SMALL) }, deps(agent));
  const line = readRuns().find((r) => r.job === run.job)!;
  assert.deepEqual([line.size, line.difficulty, line.type, line.trigger, line.outcome], ['small', 'routine', 'feature', 'cli', 'pr']);
  assert.deepEqual(line.agents.map((a) => [a.stage, a.role, a.tier, a.model]), [['implement', 'implementer', 'standard', 'fake'], ['review-1', 'reviewer', 'fast', 'fake']]);
  assert.equal(line.cost_usd, 0.02);
  assert.equal(line.turns, 6);
  assert.deepEqual(line.gates.map((g) => [g.attempt, g.ok]), [[1, true]]);
  assert.deepEqual(line.review, { rounds: 1, findings: 0, blockers: 0, acted_on: 0, open: 0 });
  assert.equal(line.fix_rounds, 0);
  assert.ok(line.factory_version && line.started && line.ms.total >= 0);
});

test('work the implementer left uncommitted is committed for it', async () => {
  const repo = makeRepo();
  const { agent } = fakeAgent([say('done', false), () => clean()]);
  const run = await runJob({ repo, specFile: writeSpec(SMALL) }, deps(agent));
  assert.equal(run.outcome, 'pr');
  assert.equal(git(repo, ['show', `animus/${run.job}:src/feature.txt`]), 'done');
});

test('a failed gate goes back to the same session one tier up', async () => {
  const repo = makeRepo();
  const { agent, calls } = fakeAgent([say('nearly'), say('done'), () => clean()]);
  const run = await runJob({ repo, specFile: writeSpec(SMALL) }, deps(agent));
  assert.equal(run.outcome, 'pr');
  assert.equal(run.fix_rounds, 1);
  assert.deepEqual(run.gates.map((g) => g.ok), [false, true]);
  assert.deepEqual([calls[1]!.role, calls[1]!.tier, calls[1]!.resume], ['implementer', 'deep', 'session-1']);
  assert.match(calls[1]!.prompt, /FAIL acceptance-1: grep -q done/);
});

test('gates that still fail after two fix rounds end the job as a draft PR with the failure report', async () => {
  const repo = makeRepo();
  const { agent, calls } = fakeAgent([say('no'), say('still no'), say('never')]);
  const d = deps(agent);
  const run = await runJob({ repo, specFile: writeSpec(SMALL) }, d);
  assert.equal(run.outcome, 'draft-pr');
  assert.equal(calls.length, 3);
  assert.equal(run.fix_rounds, 2);
  assert.match(run.reason!, /gates still fail after 2 fix round/);
  assert.equal(d.published[0]!.draft, true);
  assert.match(d.published[0]!.body, /\*\*This job failed and needs you\.\*\*/);
});

test('review blockers go back once, the gates run again, and a second review settles it', async () => {
  const repo = makeRepo();
  const blocker = { severity: 'blocker', file: 'src/feature.txt', problem: 'It does not say please.', cause: 'implementation' };
  const { agent, calls } = fakeAgent([
    say('done'),
    () => ({ output: { status: 'reviewed', summary: 'One problem.', criteria: [], findings: [blocker, { severity: 'should-fix', problem: 'Name it better.' }] } }),
    say('done please'),
    () => clean(),
  ]);
  const d = deps(agent);
  const run = await runJob({ repo, specFile: writeSpec(SMALL) }, d);
  assert.equal(run.outcome, 'pr');
  assert.deepEqual(calls.map((c) => c.role), ['implementer', 'reviewer', 'implementer', 'reviewer']);
  assert.match(calls[2]!.prompt, /It does not say please/);
  assert.doesNotMatch(calls[2]!.prompt, /Name it better/);
  assert.match(calls[3]!.prompt, /review 2, after a fix round/);
  assert.deepEqual(run.review, { rounds: 2, findings: 2, blockers: 1, acted_on: 1, open: 0 });
  assert.equal(run.gates.length, 2);
});

test('blockers still open after the one fix round end the job as a draft PR that lists them', async () => {
  const repo = makeRepo();
  const blocked = () => ({ output: { status: 'reviewed', summary: 'Still wrong.', criteria: [], findings: [{ severity: 'blocker', problem: 'It is wrong.' }] } });
  const { agent } = fakeAgent([say('done'), blocked, say('done again'), blocked]);
  const d = deps(agent);
  const run = await runJob({ repo, specFile: writeSpec(SMALL) }, d);
  assert.equal(run.outcome, 'draft-pr');
  assert.match(d.published[0]!.body, /Still open after the review's fix round: It is wrong\./);
  assert.equal(run.review?.open, 1);
});

test('a trivial job skips the review and says so in the PR', async () => {
  const repo = makeRepo();
  const { agent, calls } = fakeAgent([say('done')]);
  const d = deps(agent);
  const run = await runJob({ repo, specFile: writeSpec('size: trivial\ndifficulty: routine\ntype: feature') }, d);
  assert.equal(run.outcome, 'pr');
  assert.deepEqual([calls[0]!.tier, calls[0]!.effort], ['fast', 'low']);
  assert.equal(run.review, null);
  assert.match(d.published[0]!.body, /Not reviewed: a trivial job skips the review/);
});

test('an implementer that raises the job to risky gets it reviewed at the deep tier', async () => {
  const repo = makeRepo();
  const { agent, calls } = fakeAgent([
    (req) => ({ ...say('done')(req), output: { status: 'done', summary: 'Done.', escalate: { difficulty: 'risky', why: 'It deletes data.' } } }),
    () => clean(),
  ]);
  const run = await runJob({ repo, specFile: writeSpec('size: trivial\ndifficulty: routine\ntype: feature') }, deps(agent));
  assert.deepEqual([calls[1]!.role, calls[1]!.tier], ['reviewer', 'deep']);
  assert.deepEqual(run.escalations, [{ difficulty: 'risky', why: 'It deletes data.' }]);
  assert.equal(run.difficulty, 'risky');
});

test('a job that needs input stops with its question, and the answer resumes the same job and session', async () => {
  const repo = makeRepo();
  const first = fakeAgent([() => ({ output: { status: 'needs-input', summary: '', question: 'Done, or finished?' } })]);
  const d = deps(first.agent);
  const run = await runJob({ repo, specFile: writeSpec(SMALL) }, d);
  assert.equal(run.outcome, 'needs-input');
  assert.equal(run.question, 'Done, or finished?');
  assert.equal(d.published.length, 0);
  assert.ok(existsSync(first.calls[0]!.cwd));

  const second = fakeAgent([say('done'), () => clean()]);
  const again = await runJob({ repo, resume: { state: loadState(run.job)!, answer: 'Done.' } }, deps(second.agent));
  assert.equal(again.job, run.job);
  assert.equal(again.outcome, 'pr');
  assert.equal(second.calls[0]!.resume, 'session-1');
  assert.match(second.calls[0]!.prompt, /Done, or finished\?[\s\S]*The person's answer: Done\./);
  assert.deepEqual(readRuns().filter((r) => r.job === run.job).map((r) => [r.trigger, r.outcome]), [['cli', 'needs-input'], ['resume', 'pr']]);
});

test('a session that dies leaves a failed run, and a draft PR only if it committed work', async () => {
  const repo = makeRepo();
  const { agent } = fakeAgent([() => ({ ok: false, status: 'error_max_turns' })]);
  const d = deps(agent);
  const run = await runJob({ repo, specFile: writeSpec(SMALL) }, d);
  assert.equal(run.outcome, 'failed');
  assert.match(run.reason!, /session ended with error_max_turns/);
  assert.equal(d.published.length, 0);
});

test('a dry run writes the PR body and pushes nothing', async () => {
  const repo = makeRepo();
  const { agent } = fakeAgent([say('done'), () => clean()]);
  const d = deps(agent);
  const run = await runJob({ repo, specFile: writeSpec(SMALL), dryRun: true }, d);
  assert.equal(run.outcome, 'dry-run');
  assert.equal(d.published.length, 0);
  assert.match(readFileSync(join(run.dir, 'pr-body.md'), 'utf8'), /## Acceptance criteria/);
});

test('a change under a protected path is flagged at the top of the PR', async () => {
  const repo = makeRepo();
  const { agent } = fakeAgent([(req) => { write(req.cwd, '.github/workflows/ci.yml', 'on: push\n'); return say('done')(req); }, () => clean()]);
  const d = deps(agent);
  const run = await runJob({ repo, specFile: writeSpec(SMALL) }, d);
  assert.deepEqual(run.protected_touched, ['.github/workflows/ci.yml']);
  assert.match(d.published[0]!.body, /Changes under protected paths: `\.github\/workflows\/ci\.yml`/);
});

test('a large spec is refused before anything starts', async () => {
  const repo = makeRepo();
  const { agent, calls } = fakeAgent([]);
  await assert.rejects(runJob({ repo, specFile: writeSpec('size: large\ndifficulty: routine\ntype: feature') }, deps(agent)), AnimusError);
  assert.equal(calls.length, 0);
  assert.equal(git(repo, ['branch', '--list', 'animus/*']), '');
});

test('a ui job hands the reviewer the screenshots a script took, and lists them in the PR', async () => {
  const repo = makeRepo();
  write(repo, '.animus/animus.yaml', 'commands:\n  test: grep -q done src/feature.txt\nui:\n  targets:\n    app: { url: "http://127.0.0.1:$PORT", serve: "true" }\n');
  git(repo, ['commit', '-qam', 'ui target']);
  const { agent, calls } = fakeAgent([say('done'), () => clean()]);
  let taken = 0;
  const d = deps(agent, {
    shots: async (_cwd, job, _profile, dir) => { taken++; return { dir, reused: taken > 1, shots: { job: job.id, target: 'app', tree: 't', at: '', build: ['build/home@390x844.png'], reference: [], design: 'missing' } }; },
  });
  const run = await runJob({ repo, specFile: writeSpec('size: small\ndifficulty: routine\ntype: ui') }, d);
  assert.equal(run.outcome, 'pr');
  assert.equal(calls[1]!.role, 'ui-reviewer');
  assert.match(calls[1]!.prompt, /build\/home@390x844\.png/);
  assert.match(calls[0]!.prompt, /This is a UI job on the app target/);
  assert.match(d.published[0]!.body, /## Screenshots[\s\S]*build\/home@390x844\.png/);
});
