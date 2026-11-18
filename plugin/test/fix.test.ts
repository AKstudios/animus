import assert from 'node:assert/strict';
import { existsSync, mkdtempSync, readFileSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { test } from 'node:test';
import { fixAlone, fixTarget } from '../src/fix.ts';
import { jobDir, loadState, saveProgress, saveState } from '../src/log.ts';
import { runJob, type Deps } from '../src/pipeline.ts';
import { BODY_LIMIT, prBody, SPEC_SUMMARY } from '../src/pr.ts';
import { loadFactory, resolvePlan } from '../src/profiles.ts';
import { git } from '../src/proc.ts';
import { parseSpec } from '../src/spec.ts';
import { clean, deps, done, fakeAgent, makeRepo, write, writeSpec, type Step } from './helpers.ts';

const SMALL = 'size: small\ndifficulty: routine\ntype: feature';
const say = (text: string, session?: string, context?: number): Step => (req) => {
  write(req.cwd, 'src/feature.txt', `${text}\n`);
  git(req.cwd, ['add', '-A']);
  git(req.cwd, ['commit', '-qm', `say ${text}`]);
  return { ...done(), ...(session ? { session } : {}), ...(context !== undefined ? { context } : {}) };
};

/** A finished job's pull request, for a fix to continue; its session is `session`. */
async function opened(repo: string, session: string, context?: number) {
  const d = deps(fakeAgent([say('done', session, context), () => clean()]).agent);
  const run = await runJob({ repo, specFile: writeSpec(SMALL) }, d);
  assert.equal(run.pr, 'https://example.test/pr/1');
  return run;
}

const fixOf = (repo: string, ask: string, agent: ReturnType<typeof fakeAgent>['agent'], over: Partial<Deps> = {}) => {
  const d = deps(agent, over);
  const { run, state } = fixTarget(repo, '1', () => 'OPEN');
  return runJob({ repo, fix: { of: run.job, from: state!, ask, pr: run.pr! } }, d).then((fixed) => ({ run: fixed, d }));
};

// Protects: criteria 1 and 2 of the fix spec. Fails when: a fix is a new job on a new branch, or does not carry on from the implementer's session, or a second fix starts from the first job's session, or the body loses Closes #N, the criteria or the Fixes list.
test('a fix carries on from the job it continues, on the same branch and pull request, and a second fix from the first fix', async () => {
  process.env.ANIMUS_CLOSES = '7';
  const repo = makeRepo();
  const first = await opened(repo, 'session-job');
  delete process.env.ANIMUS_CLOSES;

  const a = fakeAgent([say('done, again', 'session-fix-1'), () => clean()]);
  const one = await fixOf(repo, 'Say it twice', a.agent);

  assert.equal(one.run.outcome, 'pr');
  assert.equal(one.run.fix_of, first.job);
  assert.equal(one.run.trigger, 'fix');
  assert.notEqual(one.run.job, first.job);
  assert.equal(one.d.published[0]!.branch, first.branch);
  // The implementer carries on from the session that opened the pull request; the reviewer is told the ask too.
  assert.deepEqual(a.calls.map((c) => [c.role, c.resume]), [['implementer', 'session-job'], ['reviewer', undefined]]);
  assert.match(a.calls[0]!.prompt, /Say it twice/);
  assert.match(a.calls[1]!.prompt, /Say it twice/);
  const body = one.d.published[0]!.body;
  assert.match(body, /^Closes #7$/m);
  assert.match(body, /\| 1 \| The feature says done\. \| passed: `grep -q done src\/feature\.txt` \| met: src\/feature\.txt \|/);
  assert.match(body, new RegExp(`\\| 1 \\| Say it twice \\| \`${one.run.job}\` \\| \\$0\\.0\\d \\|`));

  const b = fakeAgent([say('done, thrice'), () => clean()]);
  const two = await fixOf(repo, 'Once more', b.agent);

  assert.equal(two.run.fix_of, one.run.job);
  assert.equal(b.calls[0]!.resume, 'session-fix-1');
  assert.match(two.d.published[0]!.body, /^Closes #7$/m);
  assert.match(two.d.published[0]!.body, /\| 1 \| Say it twice \|[\s\S]*\| 2 \| Once more \|/);
  assert.equal(loadState(two.run.job)!.fix_of, one.run.job);
});

// Protects: criterion 2 of the fix spec. Fails when: a session over the context budget is resumed anyway, or the fresh one lacks the spec, the pull request's diff, the answers or the ask.
test('a fix starts a fresh session from a handoff when the last session ended over the context budget', async () => {
  const repo = makeRepo();
  const asking = fakeAgent([() => ({ output: { status: 'needs-input', summary: '', question: 'Done, or finished?' } })]);
  const stopped = await runJob({ repo, specFile: writeSpec(SMALL) }, deps(asking.agent));
  await runJob({ repo, resume: { state: loadState(stopped.job)!, answer: 'Done.' } }, deps(fakeAgent([say('done', 'session-job', 130_000), () => clean()]).agent));

  const a = fakeAgent([say('done, again'), () => clean()]);
  const { run } = await fixOf(repo, 'Say it twice', a.agent);

  assert.equal(run.outcome, 'pr');
  assert.equal(run.handoffs, 1);
  assert.equal(a.calls[0]!.resume, undefined);
  assert.match(a.calls[0]!.prompt, /The feature file should say done\.[\s\S]*\+done[\s\S]*Done, or finished\?[\s\S]*Done\.[\s\S]*Say it twice/);
  assert.match(a.calls[1]!.prompt, /Say it twice/);
});

// Protects: criterion 3 of the fix spec. Fails when: the fix starts from the local branch and loses or overwrites a hand push, or the implementer is not told about it.
test('a fix starts from the branch as GitHub has it and tells the implementer the commits it lacked', async () => {
  const repo = makeRepo();
  const origin = mkdtempSync(join(tmpdir(), 'animus-origin-'));
  git(origin, ['init', '-q', '--bare']);
  git(repo, ['remote', 'add', 'origin', origin]);
  const first = await opened(repo, 'session-job');
  git(repo, ['push', '-q', 'origin', first.branch]);
  const other = join(mkdtempSync(join(tmpdir(), 'animus-other-')), 'clone');
  git(tmpdir(), ['clone', '-q', '--branch', first.branch, origin, other]);
  write(other, 'src/hand.txt', 'by hand\n');
  git(other, ['add', '-A']);
  git(other, ['commit', '-qm', 'Hand fix on GitHub']);
  git(other, ['push', '-q', 'origin', first.branch]);

  let hadHandFile = false;
  const a = fakeAgent([(req) => { hadHandFile = existsSync(join(req.cwd, 'src/hand.txt')); return say('done, again')(req); }, () => clean()]);
  const { run } = await fixOf(repo, 'Say it twice', a.agent);

  assert.equal(run.outcome, 'pr');
  assert.ok(hadHandFile);
  assert.match(a.calls[0]!.prompt, /Hand fix on GitHub/);
  assert.match(git(repo, ['log', '--format=%s', first.branch]), /Hand fix on GitHub/);
});

// Protects: criterion 6. Fails when: a fix whose earlier job folder and worktree are gone does not take the spec from the pull request's description or the branch from GitHub, resumes a session, loses Closes #N or the Fixes list, or does not record that it began without the earlier session.
test('a fix runs from the pull request alone when the earlier job folder and worktree are gone', async () => {
  process.env.ANIMUS_CLOSES = '7';
  const repo = makeRepo();
  const origin = mkdtempSync(join(tmpdir(), 'animus-origin-'));
  git(origin, ['init', '-q', '--bare']);
  git(repo, ['remote', 'add', 'origin', origin]);
  const first = await opened(repo, 'session-job');
  delete process.env.ANIMUS_CLOSES;
  git(repo, ['push', '-q', 'origin', first.branch]);
  const one = await fixOf(repo, 'Say it twice', fakeAgent([say('done, again', 'session-fix-1'), () => clean()]).agent);
  const body = one.d.published[0]!.body;
  const { run: latest, state } = fixTarget(repo, '1', () => 'OPEN');
  assert.equal(latest.job, one.run.job);
  assert.equal(fixAlone(repo, latest, state, () => undefined), undefined, 'its branch is here: it is reopened, not left alone');
  git(repo, ['push', '-q', 'origin', first.branch]);
  // A job removes its worktree when it ends: with its branch here it is reopened, so only the branch gone too leaves the pull request alone.
  git(repo, ['branch', '-D', first.branch]);
  const fromGithub = { body, head: first.branch, base: 'main' };
  assert.equal(fixAlone(repo, latest, state, () => fromGithub)?.branch, first.branch);
  rmSync(jobDir(one.run.job), { recursive: true });

  const alone = fixAlone(repo, latest, loadState(latest.job), () => fromGithub)!;
  const a = fakeAgent([say('done, thrice', 'session-fix-2'), () => clean()]);
  const d = deps(a.agent);
  const two = await runJob({ repo, fix: { of: latest.job, alone, ask: 'Once more', pr: latest.pr! } }, d);

  assert.equal(two.outcome, 'pr');
  assert.equal(two.fix_of, one.run.job);
  assert.equal(two.without_session, true);
  assert.equal(d.published[0]!.branch, first.branch);
  assert.equal(a.calls[0]!.resume, undefined);
  assert.match(a.calls[0]!.prompt, /The feature file should say done\.[\s\S]*\+done[\s\S]*Once more/);
  assert.match(readFileSync(loadState(two.job)!.spec, 'utf8'), /The feature file should say done\./);
  assert.match(d.published[0]!.body, /^Closes #7$/m);
  assert.match(d.published[0]!.body, /\| 1 \| Say it twice \|[\s\S]*\| 2 \| Once more \|/);
});

// Protects: criterion 6. Fails when: a fix with nothing but a description that holds no spec block runs anyway.
test('a fix from the pull request alone is refused when its description holds no spec', async () => {
  const repo = makeRepo();
  await opened(repo, 'session-job');
  const { run } = fixTarget(repo, '1', () => 'OPEN');
  assert.throws(() => fixAlone(repo, run, undefined, () => ({ body: 'A description without the spec.', head: 'b', base: 'main' })), /holds no spec/);
});

// Protects: the spec's criterion for the body. Fails when: the spec is not in the description, its own code fence ends the block early, or a spec too long for GitHub's limit is put in anyway.
test('the pull request body holds the spec in a collapsed block, and leaves it out with a note past 65,536 characters', () => {
  const body = (text: string) => {
    const spec = parseSpec(`# Say done\n\n${text}\n\n## Acceptance criteria\n\n1. It says done.\n   $ true\n`);
    return prBody({ job: 'j', spec, plan: resolvePlan(loadFactory(), spec), summary: 's', gates: [], gateAttempts: 1, fixRounds: 0, reviewRounds: 0, open: [], protectedTouched: [], escalations: [], models: 'fake', cost_usd: 0 });
  };

  const short = body('Example:\n\n```sh\nanimus run\n```');
  assert.match(short, new RegExp(`<details><summary>${SPEC_SUMMARY}</summary>\\n\\n\`\`\`\`md\\n# Say done[\\s\\S]*\`\`\`sh\\nanimus run\\n\`\`\`[\\s\\S]*\\n\`\`\`\`\\n\\n</details>$`));

  const long = body('x'.repeat(BODY_LIMIT));
  assert.ok(long.length <= BODY_LIMIT);
  assert.doesNotMatch(long, /<details>/);
  assert.match(long, /The spec is not in this description: .* 65,536 characters\.$/);
});

const notReady = () => ({ output: { status: 'not-ready', summary: 'It misses the point.', criteria: [], findings: [{ severity: 'blocker', problem: 'It is wrong.' }] } });

// Protects: criterion 4. Fails when: a pull request no job opened, a merged or closed one, or one with a fix running or waiting is fixed anyway, or the refusal does not name the fix.
test('a fix is refused, with one line, on a pull request no job opened, a merged or closed one, and one with a fix running or waiting', async () => {
  const repo = makeRepo();
  const first = await opened(repo, 'session-job');

  assert.throws(() => fixTarget(repo, '99', () => 'OPEN'), /no job opened pull request 99/);
  assert.throws(() => fixTarget(repo, '1', () => 'MERGED'), /pull request 1 is merged/);
  assert.throws(() => fixTarget(repo, '1', () => 'CLOSED'), /pull request 1 is closed/);

  const asking = fakeAgent([() => ({ output: { status: 'needs-input', summary: '', question: 'Which one?' } })]);
  const waiting = await fixOf(repo, 'Say it twice', asking.agent);
  assert.equal(waiting.run.outcome, 'needs-input');
  assert.throws(() => fixTarget(repo, '1', () => 'OPEN'), new RegExp(`has a fix waiting for an answer: job ${waiting.run.job}`));

  const state = { ...loadState(waiting.run.job)! };
  delete state.outcome;
  saveState(state);
  saveProgress(state.job, 'implement', 'implementer');
  assert.throws(() => fixTarget(repo, '1', () => 'OPEN'), new RegExp(`has a fix running: job ${state.job}`));
  // The tests share one Animus home and one pull request address: end the fix so the next test can fix it.
  saveState({ ...state, outcome: 'failed' });
  assert.equal(fixTarget(repo, '1', () => 'OPEN').run.job, first.job);
});

// Protects: criterion 5, a failed fix. Fails when: a fix that fails pushes, or changes the PR, or does not say why.
test('a fix that fails pushes nothing and reports why', async () => {
  const repo = makeRepo();
  await opened(repo, 'session-job');

  const { run, d } = await fixOf(repo, 'Say it twice', fakeAgent([() => done()]).agent);

  assert.equal(run.outcome, 'failed');
  assert.match(run.reason!, /the implementer changed nothing/);
  assert.equal(run.pr, undefined);
  assert.equal(d.published.length, 0);
});

// Protects: criterion 5, a refused fix. Fails when: the reviewer's refusal still pushes on a ready pull request, or does not push on a draft one, or turns the draft ready.
test('a fix the reviewer refuses pushes nothing on a ready pull request, and pushes as a draft on one that already was', async () => {
  const repo = makeRepo();
  await opened(repo, 'session-job');

  const ready = await fixOf(repo, 'Say it twice', fakeAgent([say('done wrongly'), () => notReady()]).agent, { prDraft: () => false });
  assert.equal(ready.run.outcome, 'failed');
  assert.match(ready.run.reason!, /the reviewer says the work is not ready: It misses the point/);
  assert.equal(ready.d.published.length, 0);
  assert.ok(ready.d.lines.some((l) => /It is wrong\./.test(l)));

  const draft = await fixOf(repo, 'Say it twice', fakeAgent([say('done differently'), () => notReady()]).agent, { prDraft: () => true });
  assert.equal(draft.run.outcome, 'draft-pr');
  assert.equal(draft.d.published.length, 1);
  assert.equal(draft.d.published[0]!.draft, true);
  assert.match(draft.d.published[0]!.body, /It misses the point/);
});

// Protects: criterion 5, a fix that passes. Fails when: a passing fix on a draft pull request leaves it a draft.
test('a fix that passes is published ready, which marks a draft pull request ready', async () => {
  const repo = makeRepo();
  await opened(repo, 'session-job');

  const { run, d } = await fixOf(repo, 'Say it twice', fakeAgent([say('done, again'), () => clean()]).agent, { prDraft: () => true });

  assert.equal(run.outcome, 'pr');
  assert.equal(d.published[0]!.draft, false);
});
