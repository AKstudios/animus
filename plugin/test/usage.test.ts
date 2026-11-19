import assert from 'node:assert/strict';
import { test } from 'node:test';
import { loadFactory } from '../src/profiles.ts';
import type { Run } from '../src/log.ts';
import { personOf, profilesInfo, tokensByJob, usageOf } from '../src/usage.ts';

const tok = (input: number, output = 0, cache_read = 0, cache_write = 0) => ({ input, output, cache_read, cache_write });
const agent = (role: string, model: string, cost_usd: number, tokens: ReturnType<typeof tok>) => ({ role, model, cost_usd, tokens, stage: role, tier: 'fast', effort: '', ok: true, ms: 0, turns: 0, calls: 0, errors: 0 });
const run = (over: Partial<Run>) => ({ job: 'j', submitter: 'a@b.c', started: '2026-11-17T10:00:00Z', ended: '2026-11-17T10:05:00Z', cost_usd: 0, tokens: tok(0), agents: [], ...over }) as unknown as Run;

// Protects: criterion 1, a person shown by name. Fails when: an address, or a blank git name, is shown.
test('a person is the git user name the run recorded, else the part of the address before the @', () => {
  assert.deepEqual(
    [{ submitter: 'ana@x.io', submitter_name: 'Ana Lee' }, { submitter: 'ana@x.io', submitter_name: '  ' }, { submitter: 'ana@x.io' }, { submitter: 'ana' }, undefined].map((r) => personOf(r)),
    ['Ana Lee', 'ana', 'ana', 'ana', ''],
  );
});

// Protects: criterion 9, a job's tokens. Fails when: cache tokens are left out or runs of one job are not added.
test('a job\'s tokens are the input, output and cache of all its runs', () => {
  const by = tokensByJob([run({ job: 'a', tokens: tok(1, 2, 3, 4) }), run({ job: 'a', tokens: tok(10) }), run({ job: 'b', tokens: tok(5) })]);
  assert.deepEqual([...by], [['a', 20], ['b', 5]]);
});

// Protects: criterion 2, a person's usage. Fails when: totals, the split, the model and role tables or the 30 days are wrong, or a run outside the window is charted.
test('usage adds runs, sessions by model and by role, and cost by day over the last 30 days', () => {
  const now = Date.parse('2026-11-18T12:00:00Z');
  const u = usageOf([
    run({ cost_usd: 3, tokens: tok(100, 20, 30, 40), agents: [agent('plan', 'm-small', 1, tok(10)), agent('implement', 'm-big', 2, tok(90, 20, 30, 40))] }),
    run({ cost_usd: 1, tokens: tok(5), ended: '2026-10-01T00:00:00Z', agents: [agent('implement', 'm-big', 1, tok(5))] }),
  ], now);
  assert.deepEqual([u.runs, u.cost_usd, u.tokens], [2, 4, tok(105, 20, 30, 40)]);
  assert.deepEqual(u.models, [{ model: 'm-big', sessions: 2, cost_usd: 3, tokens: 185 }, { model: 'm-small', sessions: 1, cost_usd: 1, tokens: 10 }]);
  assert.deepEqual(u.roles.map((r) => [r.role, r.sessions, r.cost_usd]), [['implement', 2, 3], ['plan', 1, 1]]);
  assert.equal(u.days.length, 30);
  assert.deepEqual([u.days[0]!.day, u.days[29]!.day], ['2026-10-20', '2026-11-18']);
  assert.deepEqual(u.days.filter((d) => d.cost_usd).map((d) => [d.day, d.cost_usd, d.tokens]), [['2026-11-17', 3, 190]]);
});

// Protects: criterion 11, the labels explainer. Fails when: a rejecting size or a later type is explained, or the models are not by tier.
test('the profiles explain each size, difficulty and type that runs, and the models by tier', () => {
  const f = loadFactory();
  const info = profilesInfo(f);
  const later = Object.entries(f.types).filter(([, t]) => t.later).map(([n]) => n);
  assert.ok(later.length > 0);
  assert.deepEqual(info.types.map((t) => t.name), Object.keys(f.types).filter((n) => !later.includes(n)));
  assert.deepEqual(info.models, Object.fromEntries(Object.entries(f.providers[f.provider]!)));
  assert.deepEqual(info.difficulties.map((d) => d.name), Object.keys(f.difficulties));
});
