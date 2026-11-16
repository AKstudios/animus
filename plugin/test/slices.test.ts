import assert from 'node:assert/strict';
import { test } from 'node:test';
import { loadFactory } from '../src/profiles.ts';
import { roleSkills } from '../src/skills.ts';
import { checkSlicing, describeSlicing, oneSlice, planSlices, type Slice, type Slicing } from '../src/slices.ts';
import { parseSpec } from '../src/spec.ts';
import { fakeAgent, makeRepo } from './helpers.ts';

const factory = loadFactory();
const spec = (size: string, criteria = 3) => parseSpec(`---\nsize: ${size}\n---\n# Meal notes\n\nPeople can keep a note on a meal.\n\n## Acceptance criteria\n\n${Array.from({ length: criteria }, (_, i) => `${i + 1}. Criterion ${i + 1}.\n   $ npm test`).join('\n')}\n`);
const slice = (over: Partial<Slice>): Slice => ({ title: 'A note is saved', delivers: 'A note typed on a meal is there after a reload.', criteria: [], after: [], ...over });
const GOOD: Slicing = { brief: 'Notes live on the plan entry.', slices: [slice({ criteria: [1] }), slice({ title: 'A note is shown', criteria: [2, 3], after: [1] })] };

test('a plan is taken when every criterion is held by one slice, each slice has something to show, and the order is sound', () => {
  assert.deepEqual(checkSlicing(spec('medium'), GOOD, 8), []);
  assert.deepEqual(checkSlicing(spec('medium'), oneSlice(spec('medium')), 8), []);
  const withPrefactor: Slicing = { brief: 'b', slices: [slice({ title: 'Split the plan store', prefactor: true }), slice({ criteria: [1, 2, 3], after: [1] })] };
  assert.deepEqual(checkSlicing(spec('medium'), withPrefactor, 8), []);
});

test('a plan is refused for each way the to-tickets skill is known to go wrong, and the refusal says what to change', () => {
  const s = spec('medium');
  const refused = (plan: Slicing, max = 8) => checkSlicing(s, plan, max).join('\n');
  assert.match(refused({ brief: 'b', slices: [] }), /no slices/);
  // Too many tickets: more than the limit, or more than there are criteria to grade them.
  assert.match(refused(GOOD, 1), /2 slices and the most allowed is 1/);
  assert.match(refused({ brief: 'b', slices: [slice({ criteria: [1] }), slice({ criteria: [2] }), slice({ criteria: [3] }), slice({ criteria: [] })] }), /4 slices that deliver behaviour and the spec has 3 acceptance criteria[\s\S]*slice 4 \(A note is saved\) holds no acceptance criterion/);
  // A layer: nothing to show.
  assert.match(refused({ brief: 'b', slices: [slice({ criteria: [1, 2, 3], delivers: '' })] }), /does not say what it delivers/);
  // Criteria nobody owns, two owners, or that do not exist.
  assert.match(refused({ brief: 'b', slices: [slice({ criteria: [1] }), slice({ criteria: [1, 2] })] }), /criterion 1 is held by slice 1 and slice 2[\s\S]*no slice holds criterion 3/);
  assert.match(refused({ brief: 'b', slices: [slice({ criteria: [1, 2, 3, 4] })] }), /names criterion 4, and the spec has criteria 1 to 3/);
  // Order: a slice may wait only for one before it.
  assert.match(refused({ brief: 'b', slices: [slice({ criteria: [1], after: [2] }), slice({ criteria: [2, 3], after: [5] })] }), /runs after slice 2, which is not before it[\s\S]*runs after slice 5, and the plan has slices 1 to 2/);
  // Prefactors: first, one, and holding nothing.
  assert.match(refused({ brief: 'b', slices: [slice({ criteria: [1, 2] }), slice({ prefactor: true, criteria: [3] })] }), /is a prefactor and holds criteria[\s\S]*is a prefactor and is not first/);
  assert.match(refused({ brief: '', slices: GOOD.slices }), /no brief/);
});

test('a size the planner is not asked about is one slice by script, with no session', () => {
  const { agent, calls } = fakeAgent([]);
  const planned = planSlices({ factory, agent, spec: spec('small'), cwd: makeRepo() });
  assert.equal(calls.length, 0);
  assert.deepEqual([planned.by, planned.slicing.slices.length, planned.slicing.slices[0]!.criteria], ['script', 1, [1, 2, 3]]);
  assert.match(describeSlicing(spec('small'), planned), /one slice \(this size is not cut/);
});

test('the planner proposes in a read-only session with the to-tickets skill, and a refused plan goes back to it once with the reasons', () => {
  const bad: Slicing = { brief: 'b', slices: [slice({ criteria: [1] })] };
  const { agent, calls } = fakeAgent([() => ({ output: bad, session: 'plan-session' }), () => ({ output: GOOD })]);
  const lines: string[] = [];
  const planned = planSlices({ factory, agent, spec: spec('medium'), cwd: makeRepo(), log: (l) => lines.push(l) });

  assert.deepEqual([planned.by, planned.slicing.slices.length, planned.sessions.map((s) => s.stage)], ['planner', 2, ['plan-1', 'plan-2']]);
  assert.deepEqual(calls.map((c) => [c.role, c.tier, c.readOnly, c.resume, c.compactAt, c.maxUsd]), [['planner', 'standard', true, undefined, 160_000, 8], ['planner', 'standard', true, 'plan-session', 160_000, 8]]);
  assert.match(calls[0]!.system!, /You plan one job before any code is written[\s\S]*# Skill: to-tickets\n\nHow this skill applies inside Animus:[\s\S]*tracer bullet/);
  assert.match(calls[0]!.prompt, /at most 8 slices[\s\S]*1\. Criterion 1\.\n   \$ npm test[\s\S]*People can keep a note on a meal\./);
  assert.match(calls[1]!.prompt, /refused it[\s\S]*- no slice holds criterion 2\n- no slice holds criterion 3/);
  assert.match(lines.join('\n'), /refused: no slice holds criterion 2/);
  assert.match(describeSlicing(spec('medium'), planned), /2 slice\(s\), cut by the planner\n  1\. A note is saved\n       delivers  A note typed[\s\S]*  2\. A note is shown, after 1[\s\S]*criteria  2\. Criterion 2\.\n                 3\. Criterion 3\.[\s\S]*brief for every slice:\n  Notes live on the plan entry\./);
});

test('a plan refused twice, an answer that is not a plan, or a planner session that dies stops with the reason', () => {
  const bad: Slicing = { brief: 'b', slices: [slice({ criteria: [1] })] };
  assert.throws(() => planSlices({ factory, agent: fakeAgent([() => ({ output: bad }), () => ({ output: bad })]).agent, spec: spec('medium'), cwd: makeRepo() }), /refused twice:\n  no slice holds criterion 2/);
  assert.throws(() => planSlices({ factory, agent: fakeAgent([() => ({ output: { slices: 'none' } }), () => ({ output: {} })]).agent, spec: spec('medium'), cwd: makeRepo() }), /the answer was not a plan/);
  assert.throws(() => planSlices({ factory, agent: fakeAgent([() => ({ ok: false, status: 'error_max_budget_usd' })]).agent, spec: spec('large'), cwd: makeRepo() }), /planner's session ended with error_max_budget_usd/);
});

test('only the planner is granted to-tickets', () => {
  assert.deepEqual(roleSkills(factory, 'planner', 'feature').names, ['to-tickets']);
  assert.ok(!roleSkills(factory, 'implementer', 'feature').names.includes('to-tickets'));
});
