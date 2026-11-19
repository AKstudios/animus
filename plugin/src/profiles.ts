// Task profiles: config/profiles.yaml read into a plan for one job
// (docs/factory.md, "Task profiles"). An agent only proposes labels; this
// script turns them into stages, tiers and gates, so two jobs with the same
// labels run the same way and the run log compares like with like.
import { readFileSync } from 'node:fs';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { parse } from 'yaml';
import { isRecord } from './profile.ts';
import { AnimusError } from './proc.ts';

export const TIERS = ['fast', 'standard', 'deep'] as const;
export type Tier = (typeof TIERS)[number];
export const SIZES = ['trivial', 'small', 'medium', 'large'] as const;
export type Size = (typeof SIZES)[number];
export const DIFFICULTIES = ['routine', 'hard', 'risky'] as const;
export type Difficulty = (typeof DIFFICULTIES)[number];

type Run = { tier: Tier; effort: string };
type SizeProfile = { looks_like?: string; setup?: string; gates?: string; review?: string; reject?: string };
type DifficultyProfile = Run & { signals?: string; review?: Tier; sizes?: Record<string, Partial<Run>> };
type TypeProfile = { setup?: string; reviewer?: string; evidence?: string[]; prove?: string; later?: string };

export type Factory = {
  provider: string;
  providers: Record<string, Record<Tier, string>>;
  limits: { gate_rounds: number; review_rounds: number; context_budget?: number; context_cap?: number; session_usd?: Partial<Record<Tier, number>> };
  /** The session that cuts a spec into slices, the sizes it runs for, and the most slices a plan may have. */
  planner?: Run & { sizes: string[]; max_slices: number };
  drafter?: Run & { max_usd: number };
  retro?: Run & { max_usd: number };
  provisioner?: Run & { max_usd: number };
  sizes: Record<string, SizeProfile>;
  difficulties: Record<string, DifficultyProfile>;
  types: Record<string, TypeProfile>;
  /** Vendored skills: the roles that get each, with the file each role is given, and the job types it is limited to. */
  skills?: Record<string, { types?: string[]; roles: Record<string, string> }>;
};

export type Labels = { size: Size; difficulty: Difficulty; type: string };

export type Plan = Labels & {
  /** deps: clone and dependencies. services, full: the project's services too, once jobs run in containers. */
  setup: string;
  gates: 'affected' | 'full';
  implement: Run;
  /** Absent: the job is not reviewed. */
  review?: Run & { role: string };
  evidence: string[];
  /** fails-on-base: a gate proves the job's tests fail without its change (gates.ts). */
  prove?: 'fails-on-base';
};

export const PLUGIN_ROOT = join(dirname(fileURLToPath(import.meta.url)), '..');

/** A role's standing instructions (prompts/<role>.md). */
export const readPrompt = (role: string) => readFileSync(join(PLUGIN_ROOT, 'prompts', `${role}.md`), 'utf8');

export function loadFactory(file = join(PLUGIN_ROOT, 'config', 'profiles.yaml')): Factory {
  const raw = parse(readFileSync(file, 'utf8')) as unknown;
  if (!isRecord(raw) || !isRecord(raw.sizes) || !isRecord(raw.difficulties) || !isRecord(raw.types) || !isRecord(raw.providers)) {
    throw new AnimusError(`${file}: needs provider, providers, sizes, difficulties and types`);
  }
  return raw as unknown as Factory;
}

/** One tier up, for the round after a failed gate; deep stays deep. */
export function raise(tier: Tier): Tier {
  return TIERS[Math.min(TIERS.indexOf(tier) + 1, TIERS.length - 1)]!;
}

/** The model a tier means with the configured provider. */
export function modelFor(factory: Factory, tier: Tier): string {
  const model = factory.providers[factory.provider]?.[tier];
  if (!model) throw new AnimusError(`profiles.yaml: provider ${factory.provider} has no model for tier ${tier}`);
  return model;
}

/** The plan for these labels. Throws for a size or type the factory does not run. */
export function resolvePlan(factory: Factory, labels: Labels & { criteria?: readonly { commands: readonly string[] }[] }): Plan {
  const size = factory.sizes[labels.size];
  const difficulty = factory.difficulties[labels.difficulty];
  const type = factory.types[labels.type];
  if (!size) throw new AnimusError(`size ${labels.size} is not one of ${Object.keys(factory.sizes).join(', ')}`);
  if (!difficulty) throw new AnimusError(`difficulty ${labels.difficulty} is not one of ${Object.keys(factory.difficulties).join(', ')}`);
  if (!type) throw new AnimusError(`type ${labels.type} is not one of ${Object.keys(factory.types).join(', ')}`);
  if (size.reject) throw new AnimusError(size.reject);
  if (type.later) {
    const built = Object.entries(factory.types).filter(([, t]) => !t.later).map(([name]) => name);
    throw new AnimusError(`type ${labels.type} does not run yet: ${type.later}. Types that run: ${built.join(', ')}`);
  }
  if (type.prove !== undefined && type.prove !== 'fails-on-base') throw new AnimusError(`profiles.yaml: types.${labels.type}.prove must be fails-on-base`);
  if (type.prove && labels.criteria && !labels.criteria.some((c) => c.commands.length)) {
    throw new AnimusError(`a ${labels.type} spec needs a \`$ command\` under at least one acceptance criterion: the test that fails before the fix and passes after it`);
  }
  const implement: Run = { tier: difficulty.tier, effort: difficulty.effort, ...difficulty.sizes?.[labels.size] };
  const reviewTier = difficulty.review ?? (size.review && size.review !== 'none' ? (size.review as Tier) : undefined);
  const plan: Plan = {
    size: labels.size, difficulty: labels.difficulty, type: labels.type,
    setup: type.setup ?? size.setup ?? 'full',
    gates: size.gates === 'affected' ? 'affected' : 'full',
    implement,
    evidence: ['commands', ...(type.evidence ?? [])],
  };
  if (type.prove) plan.prove = type.prove;
  if (reviewTier) plan.review = { tier: reviewTier, effort: labels.difficulty === 'routine' ? 'medium' : 'high', role: type.reviewer ?? 'reviewer' };
  return plan;
}

export type Escalation = { size?: string; difficulty?: string; why: string };

/**
 * The implementer may raise a job's size or difficulty, never lower it. A
 * raise to large is recorded but changes nothing: the work is already under way.
 */
export function escalate(factory: Factory, plan: Plan, e: Escalation): { plan: Plan; applied: Partial<Labels> } {
  const applied: Partial<Labels> = {};
  const size = SIZES.find((s) => s === e.size);
  const difficulty = DIFFICULTIES.find((d) => d === e.difficulty);
  if (size && size !== 'large' && SIZES.indexOf(size) > SIZES.indexOf(plan.size)) applied.size = size;
  if (difficulty && DIFFICULTIES.indexOf(difficulty) > DIFFICULTIES.indexOf(plan.difficulty)) applied.difficulty = difficulty;
  if (!applied.size && !applied.difficulty) return { plan, applied };
  return { plan: resolvePlan(factory, { size: plan.size, difficulty: plan.difficulty, type: plan.type, ...applied }), applied };
}

/** The plan in a few lines, for `animus plan` and the start of a run. */
export function describePlan(factory: Factory, plan: Plan): string {
  const run = (r: Run) => `${modelFor(factory, r.tier)} (${r.tier} tier, ${r.effort} effort)`;
  return [
    `${plan.size}, ${plan.difficulty}, ${plan.type}`,
    `  setup      ${plan.setup}`,
    `  implement  ${run(plan.implement)}`,
    ...(factory.limits.context_budget ? [`  sessions   a fresh session past ${Math.round(factory.limits.context_budget / 1000)}k tokens of context${factory.limits.context_cap ? `, compacted at ${Math.round(factory.limits.context_cap / 1000)}k` : ''}${factory.limits.session_usd?.[plan.implement.tier] ? `, at most $${factory.limits.session_usd[plan.implement.tier]} each` : ''}`] : []),
    `  gates      ${plan.gates}${plan.prove ? ', and the job\'s tests must fail on the base commit' : ''}, sent back at most ${factory.limits.gate_rounds} times`,
    `  review     ${plan.review ? `${plan.review.role}, ${run(plan.review)}, sent back at most ${factory.limits.review_rounds} time(s)` : 'skipped'}`,
    `  evidence   ${plan.evidence.join(', ')}`,
  ].join('\n');
}
