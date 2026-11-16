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

test('a session\'s context at its end is read from its last message, leaving out subagents and broken lines', async () => {
  const { mkdtempSync, writeFileSync } = await import('node:fs');
  const { tmpdir } = await import('node:os');
  const { join } = await import('node:path');
  const { contextAtEnd } = await import('../src/agent.ts');
  const file = join(mkdtempSync(join(tmpdir(), 'animus-transcript-')), 's.jsonl');
  const line = (usage: object, extra: object = {}) => JSON.stringify({ type: 'assistant', message: { usage }, ...extra });
  writeFileSync(file, [
    line({ input_tokens: 2, cache_read_input_tokens: 24_000, cache_creation_input_tokens: 4_000, output_tokens: 500 }),
    JSON.stringify({ type: 'user', message: { content: 'x' } }),
    line({ input_tokens: 2, cache_read_input_tokens: 49_000, cache_creation_input_tokens: 200, output_tokens: 1_900 }),
    line({ input_tokens: 9, cache_read_input_tokens: 900_000, output_tokens: 1 }, { isSidechain: true }),
    '{"type":"assistant","message":{"usage":{"input_tokens":5',
  ].join('\n'));
  assert.equal(contextAtEnd(file), 51_102);
  assert.equal(contextAtEnd(join(file, 'none')), undefined);
});
