import assert from 'node:assert/strict';
import { spawnSync } from 'node:child_process';
import { copyFileSync, mkdtempSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { beforeEach, test } from 'node:test';
import { accept, addProposals, dismiss, describeLessons, expiresAt, lessonsForPrompt, lessonsSection, readLessons, stateOf, lessonsFile, type Lesson } from '../src/lessons.ts';
import { animusHome, appendRun, runLog, writeJson, type Run } from '../src/log.ts';
import { outcomesFile } from '../src/outcomes.ts';
import { loadFactory } from '../src/profiles.ts';
import { runRetro } from '../src/retro.ts';
import { cli, fakeAgent, type Step } from './helpers.ts';

const DAY = 24 * 60 * 60 * 1000;
const NOW = Date.parse('2026-06-10T12:00:00Z');
const at = (daysAgo: number) => new Date(NOW - daysAgo * DAY).toISOString();

beforeEach(() => { for (const f of [lessonsFile(), runLog(), outcomesFile()]) rmSync(f, { force: true }); });

/** A run in the log: only what the retro reads. */
function run(job: string, over: Partial<Run> = {}): Run {
  return {
    job, repo: '/work/meal-planner', title: `Title of ${job}`, size: 'small', difficulty: 'routine', type: 'feature', outcome: 'pr', fix_rounds: 0, cost_usd: 1,
    ended: at(1), gates: [], agents: [], review: null, ...over,
  } as unknown as Run;
}

const answer = (output: unknown): Step => () => ({ output });
const proposal = (text: string, cites: string[], over = {}) => ({ text, scope: 'project', agent: 'implementer', cites, ...over });
const retro = (step: Step, over: { project?: string; days?: number } = {}) => {
  const { agent, calls } = fakeAgent([step]);
  return { calls, go: () => runRetro({ factory: loadFactory(), agent, project: 'meal-planner', days: 7, now: NOW, ...over }) };
};

test('a retro stores proposals that cite two jobs, or one whose pull request was reworked, and drops the rest', () => {
  for (const j of ['a', 'b', 'c', 'd']) appendRun(run(j, j === 'd' ? { pr: 'https://example.test/pr/4' } : {}));
  writeJson(outcomesFile(), { 'https://example.test/pr/4': { pr: 'https://example.test/pr/4', job: 'd', state: 'MERGED', human_commits: 2, reworked: true } });
  const { go } = retro(answer({ proposals: [
    proposal('Close servers tests start.', ['a', 'b']),
    proposal('Run lint before finishing.', ['c']),
    proposal('Do not rewrite shared helpers.', ['d']),
    proposal('A lesson from jobs nobody ran.', ['a', 'nowhere']),
    proposal('The same job twice is one job.', ['b', 'b']),
  ] }));

  const { proposed } = go();

  assert.deepEqual(proposed.map((l) => [l.id, l.text, l.cites, l.status, l.uses]), [
    [1, 'Close servers tests start.', ['a', 'b'], 'proposed', 0],
    [2, 'Do not rewrite shared helpers.', ['d'], 'proposed', 0],
  ]);
  assert.equal(readLessons().length, 2);
});

test('a retro stores at most five proposals', () => {
  for (const j of ['a', 'b']) appendRun(run(j));
  const { go } = retro(answer({ proposals: Array.from({ length: 7 }, (_, i) => proposal(`Lesson number ${i}.`, ['a', 'b'])) }));

  assert.deepEqual(go().proposed.map((l) => l.text), ['Lesson number 0.', 'Lesson number 1.', 'Lesson number 2.', 'Lesson number 3.', 'Lesson number 4.']);
});

test('a retro reads only the project\'s runs in the window, in a read-only session of the retro role with no worktree', () => {
  appendRun(run('here', { gates: [{ attempt: 1, ok: false, ms: 1, checks: [{ name: 'lint', ok: false, skipped: false, ms: 1 }] }] }));
  appendRun(run('too-old', { ended: at(8) }));
  appendRun(run('elsewhere', { repo: '/work/other' }));
  const { go, calls } = retro(answer({ proposals: [] }));

  go();

  const [req] = calls;
  assert.deepEqual([req!.role, req!.tier, req!.filesOnly], ['retro', 'standard', true]);
  assert.match(req!.prompt, /job here: Title of here/);
  assert.match(req!.prompt, /gates 1: failed lint/);
  assert.doesNotMatch(req!.prompt, /too-old|elsewhere/);
});

test('a retro with no run in the window starts no session', () => {
  const { go, calls } = retro(answer({ proposals: [] }));

  assert.throws(go, /no run in the last 7 days/);
  assert.equal(calls.length, 0);
});

test('accept keeps a proposed lesson and dismiss drops it, and the next retro is told both and may not propose them again', () => {
  for (const j of ['a', 'b']) appendRun(run(j));
  retro(answer({ proposals: [proposal('Close servers tests start.', ['a', 'b']), proposal('Run lint before finishing.', ['a', 'b'], { agent: 'reviewer', scope: 'factory' })] })).go();

  assert.equal(accept(1, NOW).status, 'kept');
  assert.equal(dismiss(2).status, 'dismissed');
  const next = retro(answer({ proposals: [proposal('close servers  tests start.', ['a', 'b']), proposal('Run LINT before finishing.', ['a', 'b']), proposal('Name tests by behavior.', ['a', 'b'])] }));
  const { proposed } = next.go();

  assert.match(next.calls[0]!.prompt, /Kept lessons[^]*- 1 \(project, for the implementer\): Close servers tests start\.[^]*Dismissed lessons[^]*- 2 \(factory, for the reviewer\): Run lint before finishing\./);
  assert.deepEqual(proposed.map((l) => [l.id, l.text]), [[3, 'Name tests by behavior.']]);
});

test('a retro is told of the factory lessons of other projects but not their project lessons', () => {
  for (const j of ['a', 'b']) appendRun(run(j));
  retro(answer({ proposals: [proposal('About meal-planner only.', ['a', 'b'])] }), { project: 'meal-planner' }).go();
  appendRun(run('x', { repo: '/work/other' }));
  appendRun(run('y', { repo: '/work/other' }));
  retro(answer({ proposals: [proposal('Holds anywhere.', ['x', 'y'], { scope: 'factory' })] }), { project: 'other' }).go();
  accept(1, NOW); accept(2, NOW);

  const next = retro(answer({ proposals: [] }), { project: 'other' });
  next.go();

  assert.match(next.calls[0]!.prompt, /Holds anywhere/);
  assert.doesNotMatch(next.calls[0]!.prompt, /About meal-planner only/);
});

test('a retro that sees a kept lesson again adds the new jobs and starts its 60 days over; one that cites no new job changes nothing', () => {
  for (const j of ['a', 'b', 'c']) appendRun(run(j));
  retro(answer({ proposals: [proposal('Close servers tests start.', ['a', 'b'])] })).go();
  accept(1, NOW - 50 * DAY);
  const before = expiresAt(readLessons()[0]!);

  retro(answer({ proposals: [], seen_again: [{ id: 1, cites: ['a'] }] })).go();
  assert.equal(expiresAt(readLessons()[0]!), before);

  const { seen } = retro(answer({ proposals: [], seen_again: [{ id: 1, cites: ['c'] }] })).go();

  const l = readLessons()[0]!;
  assert.deepEqual([seen, l.cites, expiresAt(l)], [[1], ['a', 'b', 'c'], NOW + 60 * DAY]);
});

test('a kept lesson expires 60 days after it was accepted, is listed as expired, and accept keeps it again', () => {
  for (const j of ['a', 'b']) appendRun(run(j));
  retro(answer({ proposals: [proposal('Close servers tests start.', ['a', 'b'])] })).go();
  accept(1, NOW - 61 * DAY);

  const l = readLessons()[0]!;
  assert.equal(stateOf(l, NOW - 2 * DAY), 'kept');
  assert.equal(stateOf(l, NOW), 'expired');
  assert.match(describeLessons([l], NOW), /expired \(1\)\n {2}1 {2}Close servers tests start\.\n.*expired 1 days ago: animus lessons accept 1 keeps it again/);

  accept(1, NOW);

  assert.equal(stateOf(readLessons()[0]!, NOW + 59 * DAY), 'kept');
});

test('animus lessons lists proposed and kept lessons with ids, cites, uses and days left, and accepts and dismisses by id', () => {
  const lesson = (id: number, text: string, over = {}) => ({ id, text, scope: 'project', project: 'meal-planner', agent: 'implementer', cites: ['a', 'b'], status: 'proposed', created: new Date(Date.now() - 30 * DAY).toISOString(), uses: 0, ...over });
  const env = { ...process.env, ANIMUS_HOME: animusHome() };
  const animus = (...args: string[]) => spawnSync(process.execPath, ['--disable-warning=ExperimentalWarning', cli, 'lessons', ...args], { encoding: 'utf8', env });
  writeJson(lessonsFile(), { next: 4, lessons: [lesson(1, 'Proposed one.'), lesson(2, 'Kept one.', { status: 'kept', acceptedAt: new Date(Date.now() - 20 * DAY).toISOString(), uses: 4 }), lesson(3, 'Gone one.', { status: 'dismissed' })] });

  const listed = animus().stdout;
  assert.match(listed, /proposed \(1\)\n {2}1 {2}Proposed one\./);
  assert.match(listed, /kept \(1\)\n {2}2 {2}Kept one\.\n.*cites a, b; used 4x, (39|40) days left/);
  assert.doesNotMatch(listed, /Gone one/);

  assert.match(animus('accept', '1').stdout, /lesson 1 is kept/);
  assert.match(animus('dismiss', '2').stdout, /lesson 2 is dismissed/);
  assert.deepEqual(readLessons().map((l) => [l.id, l.status]), [[1, 'kept'], [2, 'dismissed'], [3, 'dismissed']]);
  const missing = animus('accept', '9');
  assert.deepEqual([missing.status, missing.stderr], [2, 'lessons on this machine: this machine has not joined a Helix\nanimus: no lesson 9: animus lessons lists them\n']);
});

// Protects: criteria 3 and 4, the choice of what a prompt carries. Fails when: a lesson of another project, agent or state reaches a prompt, or the cap or the order is wrong.
test('a prompt gets the kept, unexpired lessons of its project and the factory for that agent, newest first, at most 10', () => {
  const lesson = (text: string, over: Partial<Pick<Lesson, 'scope' | 'project' | 'agent'>> = {}) => ({ text, scope: 'project' as const, project: 'meal-planner', agent: 'implementer' as const, cites: ['a', 'b'], ...over });
  const old = addProposals([lesson('expired one')], NOW - 70 * DAY)[0]!;
  accept(old.id, NOW - 70 * DAY);
  const kept = addProposals(Array.from({ length: 11 }, (_, i) => lesson(`kept ${i + 1}`)), NOW - DAY);
  for (const l of kept) accept(l.id, NOW - DAY);
  const [factory, other, reviewers, proposed, dismissed] = addProposals([
    lesson('factory wide', { scope: 'factory', project: 'tracker' }), lesson('other project', { project: 'tracker' }), lesson('for reviewers', { agent: 'reviewer' }), lesson('still proposed'), lesson('dismissed'),
  ], NOW - DAY);
  for (const l of [factory!, other!, reviewers!]) accept(l.id, NOW - DAY);
  dismiss(dismissed!.id);

  const given = lessonsForPrompt('meal-planner', 'implementer', NOW);

  assert.deepEqual(given.map((l) => l.text), ['factory wide', ...[11, 10, 9, 8, 7, 6, 5, 4, 3].map((n) => `kept ${n}`)]);
  assert.deepEqual(lessonsForPrompt('meal-planner', 'reviewer', NOW).map((l) => l.text), ['for reviewers']);
  assert.ok(![old, proposed!].some((l) => given.some((g) => g.id === l.id)));
  assert.equal(lessonsSection([]), '');
  assert.match(lessonsSection(given), /^# Lessons from earlier jobs\n[\s\S]*\n- factory wide\n- kept 11\n/);
});

// Protects: criterion 1 on a Helix with containers. Fails when: a retro reads only its own home's run log, so jobs that ran in a person's home are never looked back on.
test('a retro reads the run log and job folder of each home in ANIMUS_RETRO_HOMES, as well as its own', () => {
  const person = mkdtempSync(join(tmpdir(), 'person-home-'));
  writeFileSync(join(person, 'runs.jsonl'), `${JSON.stringify(run('theirs'))}\n`);
  writeJson(join(person, 'jobs', 'theirs', 'state.json'), { job: 'theirs', outcome: 'needs-input', question: 'Which port?', answers: [] });
  appendRun(run('mine'));
  process.env.ANIMUS_RETRO_HOMES = person;
  try {
    const { go, calls } = retro(answer({ proposals: [proposal('Ask about ports early.', ['mine', 'theirs'])] }));
    const { proposed } = go();

    assert.match(calls[0]!.prompt, /job theirs: Title of theirs[\s\S]*question: Which port\? answer: \(unanswered\)/);
    assert.deepEqual(proposed.map((l) => l.cites), [['mine', 'theirs']]);
  } finally { delete process.env.ANIMUS_RETRO_HOMES; }
});

// Protects: criterion 3 for a contained job. Fails when: a job given Helix's lessons by ANIMUS_LESSONS_FILE reads its own home's instead.
test('lessons come from ANIMUS_LESSONS_FILE when it is set', () => {
  const [l] = addProposals([{ text: 'Close servers.', scope: 'project', project: 'meal-planner', agent: 'implementer', cites: ['a', 'b'] }], NOW);
  accept(l!.id, Date.now());
  const helixFile = join(mkdtempSync(join(tmpdir(), 'helix-lessons-')), 'lessons.json');
  copyFileSync(lessonsFile(), helixFile);
  rmSync(lessonsFile());
  process.env.ANIMUS_LESSONS_FILE = helixFile;
  try {
    assert.deepEqual(lessonsForPrompt('meal-planner', 'implementer', Date.now()).map((x) => x.text), ['Close servers.']);
    assert.deepEqual(readLessons(), []);
  } finally { delete process.env.ANIMUS_LESSONS_FILE; }
});
