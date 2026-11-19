// What a person's runs used, and who a run's person is, for the display's
// people pages (plugin/display/shape.ts Usage). Read from a run log by both
// Helix (each person's own) and the local display (this machine's).
import { USAGE_DAYS, type ProfilesInfo, type TokenCount, type Usage } from '../display/shape.ts';
import { TIERS, type Factory } from './profiles.ts';
import type { Run } from './log.ts';

const sum = (t: Partial<TokenCount> | undefined) => (t?.input ?? 0) + (t?.output ?? 0) + (t?.cache_read ?? 0) + (t?.cache_write ?? 0);

/** All of a run's tokens: input, output and cache together. */
export const runTokens = (r: Pick<Run, 'tokens'>) => sum(r.tokens);

/** Each job's tokens over its runs, by Animus job. */
export function tokensByJob(runs: readonly Pick<Run, 'job' | 'tokens'>[]): Map<string, number> {
  const by = new Map<string, number>();
  for (const r of runs) by.set(r.job, (by.get(r.job) ?? 0) + runTokens(r));
  return by;
}

/**
 * The name a run's person is shown by: the git user name it recorded, else an
 * address's part before the @, so the display never shows an email address.
 */
export function personOf(r: Pick<Run, 'submitter' | 'submitter_name'> | undefined): string {
  if (!r) return '';
  if (r.submitter_name?.trim()) return r.submitter_name.trim();
  return r.submitter.includes('@') ? r.submitter.split('@')[0]! : r.submitter;
}

/** What these runs used; `now` in ms sets the days charted. */
export function usageOf(runs: readonly Run[], now: number): Usage {
  const tokens: TokenCount = { input: 0, output: 0, cache_read: 0, cache_write: 0 };
  const models = new Map<string, Usage['models'][number]>();
  const roles = new Map<string, Usage['roles'][number]>();
  const day = (ms: number) => new Date(ms).toISOString().slice(0, 10);
  const days = new Map(Array.from({ length: USAGE_DAYS }, (_, i) => [day(now - (USAGE_DAYS - 1 - i) * 86_400_000), { cost_usd: 0, tokens: 0 }]));
  let cost = 0;
  for (const r of runs) {
    cost += r.cost_usd ?? 0;
    for (const k of ['input', 'output', 'cache_read', 'cache_write'] as const) tokens[k] += r.tokens?.[k] ?? 0;
    const d = days.get((r.ended || r.started || '').slice(0, 10));
    if (d) { d.cost_usd += r.cost_usd ?? 0; d.tokens += runTokens(r); }
    for (const a of r.agents ?? []) {
      const m = models.get(a.model) ?? { model: a.model, sessions: 0, cost_usd: 0, tokens: 0 };
      const o = roles.get(a.role) ?? { role: a.role, sessions: 0, cost_usd: 0, tokens: 0 };
      for (const x of [m, o]) { x.sessions += 1; x.cost_usd += a.cost_usd; x.tokens += sum(a.tokens); }
      models.set(a.model, m);
      roles.set(a.role, o);
    }
  }
  const big = <T extends { cost_usd: number }>(xs: Iterable<T>) => [...xs].sort((a, b) => b.cost_usd - a.cost_usd);
  return { runs: runs.length, cost_usd: cost, tokens, models: big(models.values()), roles: big(roles.values()), days: [...days].map(([d, v]) => ({ day: d, ...v })) };
}

/** The factory's profiles as the display explains them (ProfilesInfo): only the types that run. */
export function profilesInfo(f: Factory): ProfilesInfo {
  const models = Object.fromEntries(TIERS.flatMap((t) => (f.providers[f.provider]?.[t] ? [[t, f.providers[f.provider]![t]]] : [])));
  return {
    provider: f.provider, models,
    ...(f.planner ? { planner: { tier: f.planner.tier, effort: f.planner.effort, sizes: f.planner.sizes } } : {}),
    sizes: Object.entries(f.sizes).filter(([, s]) => !s.reject).map(([name, s]) => ({
      name, ...(s.looks_like ? { looks_like: s.looks_like } : {}),
      ...(s.setup ? { setup: s.setup } : {}), ...(s.gates ? { gates: s.gates } : {}), ...(s.review ? { review: s.review } : {}),
    })),
    difficulties: Object.entries(f.difficulties).map(([name, d]) => ({
      name, ...(d.signals ? { signals: d.signals } : {}), tier: d.tier, effort: d.effort,
      ...(d.review ? { review: d.review } : {}), ...(d.sizes ? { sizes: d.sizes } : {}),
    })),
    types: Object.entries(f.types).filter(([, t]) => !t.later).map(([name, t]) => ({
      name, ...(t.reviewer ? { reviewer: t.reviewer } : {}), ...(t.evidence?.length ? { evidence: t.evidence } : {}), ...(t.prove ? { prove: t.prove } : {}),
    })),
  };
}
