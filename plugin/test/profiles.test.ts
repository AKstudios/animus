import assert from 'node:assert/strict';
import { test } from 'node:test';
import { escalate, loadFactory, modelFor, raise, resolvePlan } from '../src/profiles.ts';

const factory = loadFactory();
const plan = (size: string, difficulty: string, type = 'feature') => resolvePlan(factory, { size, difficulty, type } as Parameters<typeof resolvePlan>[1]);

test('size picks the stages', () => {
  assert.deepEqual([plan('trivial', 'routine').gates, plan('trivial', 'routine').review], ['affected', undefined]);
  assert.equal(plan('small', 'routine').review?.tier, 'fast');
  assert.equal(plan('medium', 'routine').review?.tier, 'standard');
  assert.equal(plan('medium', 'routine').setup, 'full');
});

test('difficulty picks the tier and effort', () => {
  assert.deepEqual(plan('trivial', 'routine').implement, { tier: 'fast', effort: 'low' });
  assert.deepEqual(plan('small', 'routine').implement, { tier: 'standard', effort: 'medium' });
  assert.deepEqual(plan('small', 'hard').implement, { tier: 'standard', effort: 'high' });
  assert.deepEqual(plan('medium', 'hard').implement, { tier: 'deep', effort: 'high' });
});

test('a risky job is reviewed at the deep tier whatever its size', () => {
  const p = plan('trivial', 'risky');
  assert.equal(p.implement.tier, 'deep');
  assert.equal(p.review?.tier, 'deep');
});

test('a ui job gets the full stack, the ui reviewer and screenshots', () => {
  const p = plan('small', 'routine', 'ui');
  assert.equal(p.setup, 'full');
  assert.equal(p.review?.role, 'ui-reviewer');
  assert.deepEqual(p.evidence, ['commands', 'screenshots']);
});

test('a large spec and a type not built yet are refused with the reason', () => {
  assert.throws(() => plan('large', 'routine'), /Split it into medium specs/);
  assert.throws(() => plan('small', 'routine', 'refactor'), /does not run yet.*Types that run: feature, backend, ui, bug/s);
  assert.throws(() => plan('small', 'routine', 'poetry'), /not one of/);
});

test('tiers name models through one map, and a raise stops at deep', () => {
  assert.equal(modelFor(factory, 'standard'), 'sonnet');
  assert.deepEqual([raise('fast'), raise('standard'), raise('deep')], ['standard', 'deep', 'deep']);
});

test('the implementer may raise a profile and never lower it', () => {
  const small = plan('small', 'routine');
  const up = escalate(factory, small, { difficulty: 'risky', why: 'it touches auth' });
  assert.equal(up.plan.review?.tier, 'deep');
  assert.deepEqual(up.applied, { difficulty: 'risky' });
  const down = escalate(factory, plan('medium', 'hard'), { size: 'small', difficulty: 'routine', why: 'easy' });
  assert.deepEqual(down.applied, {});
  assert.equal(down.plan.size, 'medium');
});
