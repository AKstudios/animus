import assert from 'node:assert/strict';
import { copyFileSync, existsSync, mkdtempSync, readFileSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { test } from 'node:test';
import { accept, addProposals, lessonsFile, readLessons } from '../src/lessons.ts';
import { loadProgress, loadState, readRuns } from '../src/log.ts';
import { jobOf, runJob } from '../src/pipeline.ts';
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
  assert.match(body, /\| 1 \| The feature says done\. \| passed \| met \|[^]*Check: passed: `grep -q done src\/feature\.txt`[^]*Review: met: src\/feature\.txt/);
  assert.doesNotMatch(body, /Needs you/);
});

// Protects: a job Helix submitted from an issue. Fails when: its pull request does not say it closes the issue, or a failure report's draft does.
test('the pull request body says Closes #<issue> when Helix set the issue, for a finished job only', async () => {
  process.env.ANIMUS_CLOSES = '7';
  try {
    const ok = deps(fakeAgent([say('done'), () => clean()]).agent);
    await runJob({ repo: makeRepo(), specFile: writeSpec(SMALL) }, ok);
    const failed = deps(fakeAgent([say('no'), say('still no'), say('never')]).agent);
    await runJob({ repo: makeRepo(), specFile: writeSpec(SMALL) }, failed);

    assert.match(ok.published[0]!.body, /^Closes #7$/m);
    assert.doesNotMatch(failed.published[0]!.body, /Closes #/);
  } finally { delete process.env.ANIMUS_CLOSES; }
});

// Protects: criterion 9 of the admit spec. Fails when: issue_link: refs in the profile is ignored and the PR still closes the issue on merge.
test('the pull request body says Refs #<issue> when the profile asks for issue_link: refs', async () => {
  process.env.ANIMUS_CLOSES = '7';
  try {
    const repo = makeRepo();
    write(repo, '.animus/animus.yaml', 'commands:\n  test: grep -q done src/feature.txt\nissue_link: refs\n');
    git(repo, ['commit', '-qam', 'refs, not closes']);
    const d = deps(fakeAgent([say('done'), () => clean()]).agent);
    await runJob({ repo, specFile: writeSpec(SMALL) }, d);

    assert.match(d.published[0]!.body, /^Refs #7$/m);
    assert.doesNotMatch(d.published[0]!.body, /Closes #/);
  } finally { delete process.env.ANIMUS_CLOSES; }
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
  assert.deepEqual(line.review, { rounds: 1, findings: 0, blockers: 0, acted_on: 0, open: 0, log: [] });
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

test('a running job says in its folder where it is: the stage, and who is working', async () => {
  const repo = makeRepo();
  const seen: string[] = [];
  const look = (step: Step): Step => (req) => {
    const p = loadProgress(jobOf(req.cwd)!)!;
    seen.push(`${p.stage}: ${p.who} [${p.model}, ${p.effort}]`);
    return step(req);
  };
  const { agent } = fakeAgent([look(say('nearly')), look(say('done')), look(() => clean())]);
  const run = await runJob({ repo, specFile: writeSpec(SMALL) }, deps(agent));
  assert.deepEqual(seen, ['implement: implementer · standard tier [sonnet, medium]', 'implement: implementer · deep tier · gate fix 1 [opus, medium]', 'review: reviewer · fast tier [haiku, medium]']);
  // Each session records when it started.
  assert.ok(run.agents.every((a) => Date.parse(a.started!) <= Date.parse(run.ended)));
  assert.deepEqual([loadProgress(run.job)!.stage, loadProgress(run.job)!.who], ['pr', 'pr · writing the description']);
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
  assert.deepEqual(run.review, {
    rounds: 2, findings: 2, blockers: 1, acted_on: 1, open: 0,
    log: [{ round: 1, severity: 'blocker', file: 'src/feature.txt', fate: 'fixed' }, { round: 1, severity: 'should-fix', fate: 'not-acted-on' }],
  });
  assert.equal(run.gates.length, 2);
});

test('blockers still open after the one fix round end the job as a draft PR that lists them', async () => {
  const repo = makeRepo();
  const blocked = () => ({ output: { status: 'reviewed', summary: 'Still wrong.', criteria: [], findings: [{ severity: 'blocker', problem: 'It is wrong.' }] } });
  const { agent } = fakeAgent([say('done'), blocked, say('done again'), blocked]);
  const d = deps(agent);
  const run = await runJob({ repo, specFile: writeSpec(SMALL) }, d);
  assert.equal(run.outcome, 'draft-pr');
  assert.match(d.published[0]!.body, /1 blocker still open: It is wrong\./);
  assert.equal(run.review?.open, 1);
  assert.deepEqual(run.review?.log?.map((l) => l.fate), ['fixed', 'open']);
});

// Protects: criterion 1 of the review-blockers spec. Fails when: a not-ready status ends the job though the review holds blockers a fix round would settle.
test('a not-ready review with a blocker sends it to the fix round like a reviewed one', async () => {
  const repo = makeRepo();
  const blocker = { severity: 'blocker', file: 'src/feature.txt', problem: 'It does not say please.', cause: 'implementation' };
  const { agent, calls } = fakeAgent([
    say('done'),
    () => ({ output: { status: 'not-ready', summary: 'Not ready.', criteria: [], findings: [blocker] } }),
    say('done please'),
    () => clean(),
  ]);
  const run = await runJob({ repo, specFile: writeSpec(SMALL) }, deps(agent));
  assert.equal(run.outcome, 'pr');
  assert.deepEqual(calls.map((c) => c.role), ['implementer', 'reviewer', 'implementer', 'reviewer']);
  assert.match(calls[2]!.prompt, /It does not say please/);
});

// Protects: criterion 2. Fails when: a not-ready review with nothing to fix is passed on, or loses the reviewer's summary as the reason.
test('a not-ready review with no blocker ends the job as failed with the summary as the reason', async () => {
  const repo = makeRepo();
  const { agent, calls } = fakeAgent([say('done'), () => ({ output: { status: 'not-ready', summary: 'Nothing here is usable.', criteria: [], findings: [{ severity: 'should-fix', problem: 'Name it better.' }] } })]);
  const run = await runJob({ repo, specFile: writeSpec(SMALL) }, deps(agent));
  assert.equal(run.outcome, 'draft-pr');
  assert.match(run.reason!, /Nothing here is usable\./);
  assert.equal(calls.length, 2);
});

const unmet = (proof: string) => () => ({ output: { status: 'reviewed', summary: 'One criterion fails.', criteria: [{ criterion: 1, met: false, proof }], findings: [] } });

// Protects: criterion 3. Fails when: an unmet verdict without a blocker lets the job open a ready pull request.
test('a criterion the review marks unmet becomes a blocker naming it, with the proof, and goes to the fix round', async () => {
  const repo = makeRepo();
  const { agent, calls } = fakeAgent([say('done'), unmet('src/feature.txt lacks please'), say('done please'), () => clean()]);
  const run = await runJob({ repo, specFile: writeSpec(SMALL) }, deps(agent));
  assert.equal(run.outcome, 'pr');
  assert.deepEqual(calls.map((c) => c.role), ['implementer', 'reviewer', 'implementer', 'reviewer']);
  assert.match(calls[2]!.prompt, /criterion 1[\s\S]*src\/feature\.txt lacks please/i);
  assert.deepEqual([run.review?.blockers, run.review?.acted_on], [1, 1]);
});

// Protects: criterion 3's "no blocker of that review names it". Fails when: a blocker that already gives the criterion number is doubled by the script.
test('an unmet criterion that a blocker already names by number adds no second blocker', async () => {
  const repo = makeRepo();
  const named = () => ({ output: { status: 'reviewed', summary: 'x', criteria: [{ criterion: 1, met: false, proof: 'p' }], findings: [{ severity: 'blocker', criterion: 1, problem: 'Says nothing.' }] } });
  const { agent, calls } = fakeAgent([say('done'), named, say('done please'), () => clean()]);
  const run = await runJob({ repo, specFile: writeSpec(SMALL) }, deps(agent));
  assert.equal(run.review?.blockers, 1);
  assert.doesNotMatch(calls[2]!.prompt, /Criterion 1 is not met/);
});

// Protects: criterion 4. Fails when: a criterion still unmet after the fix round opens a ready pull request, or the description does not name it.
test('a criterion still unmet after the fix round ends as a draft PR that names it as open', async () => {
  const repo = makeRepo();
  const { agent } = fakeAgent([say('done'), unmet('first'), say('done again'), unmet('still missing')]);
  const d = deps(agent);
  const run = await runJob({ repo, specFile: writeSpec(SMALL) }, d);
  assert.equal(run.outcome, 'draft-pr');
  assert.equal(d.published[0]!.draft, true);
  assert.match(d.published[0]!.body, /blockers? still open: .*[Cc]riterion 1.*still missing/);
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
  assert.match(d.published[0]!.body, /Review: no review: a trivial job skips it/);
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

test('a job that needs input stops with its question, and the answer resumes the same job and session and reaches the reviewer', async () => {
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
  // The reviewer is told what was asked and answered, or it would judge the answer as the implementer's guess.
  assert.match(second.calls[1]!.prompt, /Asked: Done, or finished\?\n  Answered: Done\./);
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

test('a breaking report puts a Breaking section in the pull request, and no report leaves none', async () => {
  const breaks = fakeAgent([(req) => ({ ...say('done')(req), output: { status: 'done', summary: 'Done.', breaking: 'Specs lose `type`. Delete it from yours.' } }), () => clean()]);
  const d = deps(breaks.agent);
  await runJob({ repo: makeRepo(), specFile: writeSpec(SMALL) }, d);
  assert.match(d.published[0]!.body, /^## Breaking\n\nSpecs lose `type`\. Delete it from yours\.$/m);

  const plain = fakeAgent([say('done'), () => clean()]);
  const d2 = deps(plain.agent);
  await runJob({ repo: makeRepo(), specFile: writeSpec(SMALL) }, d2);
  assert.doesNotMatch(d2.published[0]!.body, /## Breaking/);
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
  assert.match(d.published[0]!.body, /Screenshots \(1\)[\s\S]*build\/home@390x844\.png/);
});

test('pushed screenshots are shown in the PR as images, and a failed push falls back to their paths', async () => {
  const ui = 'commands:\n  test: grep -q done src/feature.txt\nui:\n  targets:\n    app: { url: "http://127.0.0.1:$PORT", serve: "true" }\n';
  const shots: NonNullable<Parameters<typeof deps>[1]>['shots'] = async (_cwd, job, _profile, dir) => ({ dir, reused: false, shots: { job: job.id, target: 'app', tree: 't', at: '', build: ['build/home@390x844.png', 'build/home@1280x800.png'], reference: [], design: 'missing' } });
  const spec = () => writeSpec('size: small\ndifficulty: routine\ntype: ui');
  const repo = makeRepo();
  write(repo, '.animus/animus.yaml', ui);
  git(repo, ['commit', '-qam', 'ui target']);

  const a = fakeAgent([say('done'), () => clean()]);
  const pushed = deps(a.agent, { shots, evidence: ({ files }) => Object.fromEntries(files.map((f) => [f, `https://example.test/${f}`])) });
  const run = await runJob({ repo, specFile: spec() }, pushed);
  const body = pushed.published[0]!.body;
  assert.match(body, /<img src="https:\/\/example\.test\/build\/home@390x844\.png" alt="home@390x844" width="390">/);
  assert.match(body, /!\[home@1280x800\]\(https:\/\/example\.test\/build\/home@1280x800\.png\)/);
  assert.match(body, new RegExp(`animus-evidence/${run.job}`));

  const b = fakeAgent([say('done'), () => clean()]);
  const refused = deps(b.agent, { shots, evidence: () => { throw new AnimusError('no remote'); } });
  assert.equal((await runJob({ repo, specFile: spec() }, refused)).outcome, 'pr');
  assert.match(refused.published[0]!.body, /- `build\/home@390x844\.png`[\s\S]*The images were not pushed/);
});

test('a job of another type that changes a ui target\'s files gets screenshots too', async () => {
  const repo = makeRepo();
  write(repo, '.animus/animus.yaml', 'commands:\n  test: grep -q done src/feature.txt\nui:\n  targets:\n    app: { url: "http://127.0.0.1:$PORT", serve: "true", paths: ["src/**"] }\n');
  git(repo, ['commit', '-qam', 'ui target']);
  const { agent, calls } = fakeAgent([say('done'), () => clean()]);
  const targets: (string | undefined)[] = [];
  const d = deps(agent, { shots: async (_cwd, job, _profile, dir) => { targets.push(job.target); return { dir, reused: false, shots: { job: job.id, target: 'app', tree: 't', at: '', build: ['build/home@390x844.png'], reference: [], design: 'missing' } }; } });
  const run = await runJob({ repo, specFile: writeSpec(SMALL) }, d);
  assert.equal(run.outcome, 'pr');
  assert.deepEqual(targets, ['app']);
  assert.equal(calls[1]!.role, 'reviewer');
  assert.match(d.published[0]!.body, /Screenshots \(1\)/);
});

const BUG = 'size: small\ndifficulty: routine\ntype: bug';
const BUG_CRITERIA = '1. The feature says done.\n   $ sh test/feature.test.sh\n';
/** The implementer's turn on a bug job: a test file with this script, and the fix. */
const fix = (testScript: string | undefined): Step => (req) => {
  if (testScript) write(req.cwd, 'test/feature.test.sh', `${testScript}\n`);
  return say('done', false)(req);
};

test('a bug job passes when its test fails on the base commit with only the test laid over it, and the PR shows that', async () => {
  const repo = makeRepo();
  const { agent, calls } = fakeAgent([fix('grep -q done src/feature.txt'), () => clean()]);
  const d = deps(agent);
  const run = await runJob({ repo, specFile: writeSpec(BUG, BUG_CRITERIA) }, d);
  assert.equal(run.outcome, 'pr');
  assert.deepEqual(run.gates[0]!.checks.map((c) => [c.name, c.ok]), [['test', true], ['acceptance-1', true], ['fails-on-base', true]]);
  assert.match(d.published[0]!.body, /\*\*fails-on-base\*\* passed in [\d.]+s: `sh test\/feature\.test\.sh`/);
  assert.match(calls[0]!.prompt, /This job must prove its test/);
  assert.match(calls[0]!.system!, /# Skill: tdd/);
  assert.equal(git(repo, ['worktree', 'list']).split('\n').length, 1);
});

test('a bug job whose test passes without the fix, or that has no test, is sent back', async () => {
  const repo = makeRepo();
  const { agent, calls } = fakeAgent([fix('true'), fix('grep -q done src/feature.txt'), () => clean()]);
  const run = await runJob({ repo, specFile: writeSpec(BUG, BUG_CRITERIA) }, deps(agent));
  assert.equal(run.outcome, 'pr');
  assert.deepEqual(run.gates.map((g) => g.ok), [false, true]);
  assert.match(calls[1]!.prompt, /FAIL fails-on-base[\s\S]*no test fails without the fix/);

  const none = fakeAgent([fix(undefined), fix(undefined), fix(undefined)]);
  const failed = await runJob({ repo, specFile: writeSpec(BUG) }, deps(none.agent));
  assert.equal(failed.outcome, 'draft-pr');
  assert.match(none.calls[1]!.prompt, /FAIL fails-on-base[\s\S]*changed no test file/);
});

test('a bug spec with no acceptance command is refused before anything starts', async () => {
  const { agent, calls } = fakeAgent([]);
  await assert.rejects(runJob({ repo: makeRepo(), specFile: writeSpec(BUG, '1. The feature says done.\n') }, deps(agent)), /needs a `\$ command`/);
  assert.equal(calls.length, 0);
});

// Protects: Helix's hand-off of a waiting job. Fails when: a job whose queue saw the earlier PR merge still looks for that spec's file (absent here) or waits again.
test('a spec with after: runs at once when the queue says the earlier pull request merged, whether or not the earlier spec is in the repo', async () => {
  const { agent } = fakeAgent([say('done'), () => clean()]);
  const looked: string[] = [];
  const d = deps(agent, { prState: (url) => { looked.push(url); return 'OPEN'; } });
  const run = await runJob({ repo: makeRepo(), specFile: writeSpec(`${SMALL}\nafter: docs/specs/none.md`), afterMerged: true }, d);
  assert.deepEqual([run.outcome, looked], ['pr', []]);
});

test('a spec with after: waits until the earlier spec\'s pull request is merged, and fails if it was closed unmerged', async () => {
  const repo = makeRepo();
  const first = writeSpec(SMALL);
  const a = fakeAgent([say('done'), () => clean()]);
  await runJob({ repo, specFile: first }, deps(a.agent, { publish: () => 'https://example.test/first' }));

  const states = ['OPEN', undefined, 'MERGED'] as const;
  let looks = 0;
  let sleeps = 0;
  const b = fakeAgent([say('done'), () => clean()]);
  const d = deps(b.agent, { prState: (url) => { assert.equal(url, 'https://example.test/first'); return states[looks++]; }, sleep: async () => { sleeps += 1; } });
  const run = await runJob({ repo, specFile: writeSpec(`${SMALL}\nafter: ${first}`) }, d);
  assert.equal(run.outcome, 'pr');
  assert.deepEqual([looks, sleeps], [3, 2]);
  assert.match(d.lines.join('\n'), /waiting: this spec runs after .*first is open[\s\S]*could not be read[\s\S]*is merged/);
  // Nothing started while it waited.
  assert.ok(d.lines.findIndex((l) => /is merged/.test(l)) < d.lines.findIndex((l) => /^implement:/.test(l)));

  const c = fakeAgent([]);
  await assert.rejects(runJob({ repo, specFile: writeSpec(`${SMALL}\nafter: ${first}`) }, deps(c.agent, { prState: () => 'CLOSED' })), /closed without merging/);
  await assert.rejects(runJob({ repo, specFile: writeSpec(`${SMALL}\nafter: docs/specs/none.md`) }, deps(c.agent)), /is not a spec file/);
});

test('a session that ended over the context budget is not resumed: the next round is a fresh session told what was done', async () => {
  const repo = makeRepo();
  // The first session fails the gate and ends long; the second fails it and ends short; the third passes.
  const long: Step = (req) => ({ ...say('no')(req), context: 130_000 });
  const short: Step = (req) => ({ ...say('still no')(req), context: 40_000, session: 'session-2' });
  const { agent, calls } = fakeAgent([long, short, say('done'), () => clean()]);
  const d = deps(agent);
  const run = await runJob({ repo, specFile: writeSpec(SMALL) }, d);

  assert.equal(run.outcome, 'pr');
  assert.equal(run.handoffs, 1);
  assert.deepEqual(calls.map((c) => c.resume), [undefined, undefined, 'session-2', undefined]);
  // The fresh session gets the spec and the gates again, where to read the work so far, and the round's own ask.
  assert.match(calls[1]!.prompt, /The feature file should say done\.[\s\S]*already under way[\s\S]*git diff [0-9a-f]{40}\.\.\.HEAD[\s\S]*The last session's summary: The feature says done\.[\s\S]*What is asked of you now:[\s\S]*the gates on your last commit and they failed/);
  assert.doesNotMatch(calls[2]!.prompt, /already under way/);
  assert.match(d.lines.join('\n'), /ended at 130k tokens of context, over the 100k budget: gate-fix-1 starts a fresh session/);
  assert.deepEqual(run.agents.map((a) => a.context), [130_000, 40_000, undefined, undefined]);
  // Every session is held to the cap and to its tier's dollars while it runs.
  // Every session is held to the cap and to its tier's dollars while it runs: standard, then deep for the fix rounds, fast for the review.
  assert.deepEqual(calls.map((c) => [c.compactAt, c.maxUsd]), [[160_000, 8], [160_000, 20], [160_000, 20], [160_000, 2]]);
});

test('a job picked up again starts a fresh session when the one it had ended over the budget', async () => {
  const repo = makeRepo();
  const first = fakeAgent([() => ({ output: { status: 'needs-input', summary: '', question: 'Done, or finished?' }, context: 150_000 })]);
  const run = await runJob({ repo, specFile: writeSpec(SMALL) }, deps(first.agent));
  assert.equal(loadState(run.job)!.context, 150_000);

  const second = fakeAgent([say('done'), () => clean()]);
  const again = await runJob({ repo, resume: { state: loadState(run.job)!, answer: 'Done.' } }, deps(second.agent));
  assert.equal(again.outcome, 'pr');
  assert.equal(second.calls[0]!.resume, undefined);
  assert.match(second.calls[0]!.prompt, /The feature file should say done\.[\s\S]*already under way[\s\S]*Done, or finished\?[\s\S]*The person's answer: Done\./);
});

// Protects: a job on Helix reads the profile from origin/<base>, not the clone's working tree (docs/adr/0008). Fails when: a clone left on another branch hands the job its old profile.
test('a job Helix runs reads the profile from origin/main even when the clone is on another branch', async () => {
  process.env.ANIMUS_CLOSES = '7';
  try {
    const repo = makeRepo();
    const origin = mkdtempSync(join(tmpdir(), 'animus-origin-'));
    git(origin, ['init', '-q', '--bare']);
    git(repo, ['remote', 'add', 'origin', origin]);
    git(repo, ['push', '-q', 'origin', 'main']);
    git(repo, ['fetch', '-q', 'origin']);
    git(repo, ['checkout', '-q', '-b', 'old-work']);
    write(repo, '.animus/animus.yaml', 'commands:\n  test: grep -q done src/feature.txt\nissue_link: refs\n');
    git(repo, ['commit', '-qam', 'a profile only this branch has']);
    const d = deps(fakeAgent([say('done'), () => clean()]).agent);
    await runJob({ repo, specFile: writeSpec(SMALL), trigger: 'helix' }, d);

    assert.match(d.published[0]!.body, /^Closes #7$/m);
  } finally { delete process.env.ANIMUS_CLOSES; }
});

// Protects: criterion 3. Fails when: a kept lesson does not reach the agent it is for, uses is not one per job, or the run log leaves out the ids.
test('a job gives each agent the kept lessons for it, counts one use per lesson, and logs their ids', async () => {
  const mine = { scope: 'project' as const, project: 'project', cites: ['a', 'b'] };
  const [implementer, factoryWide, reviewer, elsewhere] = addProposals([
    { ...mine, text: 'Close the servers your tests start.', agent: 'implementer' }, { ...mine, scope: 'factory', project: 'tracker', text: 'Name the check for each criterion.', agent: 'implementer' },
    { ...mine, text: 'Read the tests before the code.', agent: 'reviewer' }, { ...mine, project: 'tracker', text: 'Only the tracker has this.', agent: 'implementer' },
  ], Date.now());
  for (const l of [implementer!, factoryWide!, reviewer!, elsewhere!]) accept(l.id, Date.now());
  try {
    const { agent, calls } = fakeAgent([say('done'), () => clean()]);
    const run = await runJob({ repo: makeRepo(), specFile: writeSpec(SMALL) }, deps(agent));

    assert.match(calls[0]!.system!, /# Lessons from earlier jobs\n[\s\S]*- Name the check for each criterion\.\n- Close the servers your tests start\./);
    assert.doesNotMatch(calls[0]!.system!, /Read the tests|Only the tracker/);
    assert.match(calls[1]!.system!, /# Lessons from earlier jobs[\s\S]*- Read the tests before the code\./);
    assert.deepEqual(run.lessons, [factoryWide!.id, implementer!.id, reviewer!.id]);
    assert.deepEqual(readRuns().find((r) => r.job === run.job)!.lessons, run.lessons);
    assert.deepEqual(readLessons().map((l) => [l.id, l.uses]), [[implementer!.id, 1], [factoryWide!.id, 1], [reviewer!.id, 1], [elsewhere!.id, 0]]);
  } finally { rmSync(lessonsFile(), { force: true }); }
});

// Protects: criterion 3 on a Helix with containers. Fails when: a job given Helix's lessons read-only counts uses itself (it cannot write that file) or leaves their ids off its run line, which Helix counts from.
test('a job given lessons by ANIMUS_LESSONS_FILE logs their ids and leaves the counting to the file\'s keeper', async () => {
  const [l] = addProposals([{ text: 'Close the servers your tests start.', scope: 'project', project: 'project', agent: 'implementer', cites: ['a', 'b'] }], Date.now());
  accept(l!.id, Date.now());
  const helixFile = join(mkdtempSync(join(tmpdir(), 'helix-lessons-')), 'lessons.json');
  copyFileSync(lessonsFile(), helixFile);
  rmSync(lessonsFile());
  process.env.ANIMUS_LESSONS_FILE = helixFile;
  try {
    const { agent, calls } = fakeAgent([say('done'), () => clean()]);
    const run = await runJob({ repo: makeRepo(), specFile: writeSpec(SMALL) }, deps(agent));

    assert.match(calls[0]!.system!, /- Close the servers your tests start\./);
    assert.deepEqual(readRuns().find((r) => r.job === run.job)!.lessons, [l!.id]);
    assert.equal(existsSync(lessonsFile()), false);
    assert.equal(JSON.parse(readFileSync(helixFile, 'utf8')).lessons[0].uses, 0);
  } finally { delete process.env.ANIMUS_LESSONS_FILE; }
});
