// How one spec is cut into slices: the short pieces of work a job does in
// order, each in a fresh session, on one branch, toward one pull request. An
// agent proposes the cut (the planner, with the to-tickets skill) and this
// script decides whether to take it: every acceptance criterion held by
// exactly one slice, each slice with something to show, the order sound, and
// no more slices than the spec has criteria to grade them by.
import type { Agent, AgentResult } from './agent.ts';
import { modelFor, readPrompt, type Factory } from './profiles.ts';
import { AnimusError } from './proc.ts';
import { criteriaList } from './review.ts';
import type { PersonalSkill } from './personal.ts';
import { roleSkills } from './skills.ts';
import type { Spec } from './spec.ts';

export type Slice = {
  title: string;
  /** What someone could see working once this slice is done and no later one is. */
  delivers: string;
  /** The spec's acceptance criteria this slice finishes, by number from 1. */
  criteria: number[];
  /** The slices, by number from 1, that must be done before this one starts. */
  after: number[];
  /** Changes no behaviour and holds no criteria: it makes a later slice easy. */
  prefactor?: boolean;
};

export type Slicing = {
  /** What every slice's session is told beside its own part: shared decisions, names and places. */
  brief: string;
  slices: Slice[];
};

export const SLICING_SCHEMA = {
  type: 'object',
  required: ['brief', 'slices'],
  properties: {
    brief: { type: 'string' },
    slices: {
      type: 'array',
      items: {
        type: 'object',
        required: ['title', 'delivers', 'criteria', 'after'],
        properties: {
          title: { type: 'string' },
          delivers: { type: 'string' },
          criteria: { type: 'array', items: { type: 'integer' } },
          after: { type: 'array', items: { type: 'integer' } },
          prefactor: { type: 'boolean' },
        },
      },
    },
  },
} as const;

const isInts = (v: unknown): v is number[] => Array.isArray(v) && v.every((n) => Number.isInteger(n));

/** The planner's answer, if it has the shape asked for. */
export function asSlicing(output: unknown): Slicing | undefined {
  if (typeof output !== 'object' || output === null) return undefined;
  const o = output as { brief?: unknown; slices?: unknown };
  if (typeof o.brief !== 'string' || !Array.isArray(o.slices)) return undefined;
  const slices: Slice[] = [];
  for (const raw of o.slices as Record<string, unknown>[]) {
    if (typeof raw?.title !== 'string' || typeof raw.delivers !== 'string' || !isInts(raw.criteria) || !isInts(raw.after)) return undefined;
    slices.push({ title: raw.title.trim(), delivers: raw.delivers.trim(), criteria: raw.criteria, after: raw.after, ...(raw.prefactor === true ? { prefactor: true } : {}) });
  }
  return { brief: o.brief.trim(), slices };
}

/** A spec done in one session: one slice that holds every criterion. No agent is asked. */
export function oneSlice(spec: Pick<Spec, 'title' | 'criteria'>): Slicing {
  return { brief: '', slices: [{ title: spec.title, delivers: 'Everything the spec asks for.', criteria: spec.criteria.map((_, i) => i + 1), after: [] }] };
}

/**
 * Why a proposed cut is refused; empty when it is taken. The rules are the
 * failures the to-tickets skill reports of itself, made checkable: too many
 * tickets, tickets that are a layer with nothing to show, and criteria that
 * nothing owns or that two tickets each think the other will meet.
 */
export function checkSlicing(spec: Pick<Spec, 'criteria'>, s: Slicing, maxSlices: number): string[] {
  const problems: string[] = [];
  const n = s.slices.length;
  if (!n) return ['the plan has no slices: a spec that fits one session is one slice holding every criterion'];
  if (n > maxSlices) problems.push(`the plan has ${n} slices and the most allowed is ${maxSlices}: merge slices that only make sense together`);
  if (n > 1 && !s.brief) problems.push('the plan has no brief: with more than one slice, each session needs the decisions and names the slices share');

  const working = s.slices.filter((x) => !x.prefactor).length;
  if (working > spec.criteria.length) {
    problems.push(`the plan has ${working} slices that deliver behaviour and the spec has ${spec.criteria.length} acceptance criteria: a slice is graded by the criteria it holds, so there cannot be more of them than criteria. Merge slices`);
  }
  if (n - working > 1) problems.push(`the plan has ${n - working} prefactor slices: at most one, at the front`);

  const owner = new Map<number, number>();
  s.slices.forEach((slice, i) => {
    const at = `slice ${i + 1}${slice.title ? ` (${slice.title})` : ''}`;
    if (!slice.title) problems.push(`slice ${i + 1} has no title`);
    if (!slice.delivers) problems.push(`${at} does not say what it delivers: what could someone see working when it is done and no later slice is?`);
    if (slice.prefactor) {
      if (slice.criteria.length) problems.push(`${at} is a prefactor and holds criteria: a prefactor changes no behaviour, so it finishes none`);
      if (i !== 0) problems.push(`${at} is a prefactor and is not first: prefactoring is done before the slices it helps`);
    } else if (!slice.criteria.length) {
      problems.push(`${at} holds no acceptance criterion, so nothing grades it: give it the criteria it finishes, or merge it into the slice that holds them`);
    }
    for (const c of slice.criteria) {
      if (c < 1 || c > spec.criteria.length) problems.push(`${at} names criterion ${c}, and the spec has criteria 1 to ${spec.criteria.length}`);
      else if (owner.has(c)) problems.push(`criterion ${c} is held by slice ${owner.get(c)} and slice ${i + 1}: give it to the one that finishes it`);
      else owner.set(c, i + 1);
    }
    for (const a of slice.after) {
      if (a < 1 || a > n) problems.push(`${at} runs after slice ${a}, and the plan has slices 1 to ${n}`);
      else if (a >= i + 1) problems.push(`${at} runs after slice ${a}, which is not before it: list the slices in the order they run`);
    }
  });
  spec.criteria.forEach((_, i) => { if (!owner.has(i + 1)) problems.push(`no slice holds criterion ${i + 1}`); });
  return problems;
}

/** Whether a spec of this size is cut by the planner; otherwise it is one slice by script. */
export const isPlanned = (factory: Pick<Factory, 'planner'>, size: string) => Boolean(factory.planner?.sizes.includes(size));

export type Planned = {
  slicing: Slicing;
  /** planner: a session proposed it and the check took it. script: one slice, no session. */
  by: 'planner' | 'script' | 'person';
  /** The planner's sessions, for the run log. */
  sessions: { stage: string; result: AgentResult }[];
};

function planPrompt(spec: Spec, maxSlices: number): string {
  return [
    `Cut this spec into slices. It is labelled ${spec.size}, ${spec.difficulty}, ${spec.type}. A plan may have at most ${maxSlices} slices, and no more slices that deliver behaviour than the spec has acceptance criteria (${spec.criteria.length}).`,
    `The acceptance criteria, numbered as your answer must number them:\n${criteriaList(spec)}`,
    `The spec:\n\n${spec.text.trim()}`,
  ].join('\n\n');
}

/**
 * The slices of one spec. A size the planner is not asked about is one slice.
 * Otherwise the planner proposes, the check decides, and a refused plan goes
 * back to the same session once with the reasons.
 */
export function planSlices(p: { factory: Factory; agent: Agent; spec: Spec; cwd: string; personal?: readonly PersonalSkill[]; /** The planner's lessons, as a section of its instructions; asked for only when it is going to plan. */ lessons?: () => string; log?: (line: string) => void; record?: (stage: string, result: AgentResult) => void; /** The person chose one session: the planner is not asked. */ oneSession?: boolean }): Planned {
  const { factory, spec } = p;
  if (p.oneSession) return { slicing: oneSlice(spec), by: 'person', sessions: [] };
  const planner = factory.planner;
  if (!planner || !isPlanned(factory, spec.size)) return { slicing: oneSlice(spec), by: 'script', sessions: [] };
  const log = p.log ?? (() => {});
  const skills = roleSkills(factory, 'planner', spec.type, p.cwd, p.personal);
  const system = [readPrompt('planner'), skills.system, p.lessons?.()].filter(Boolean).join('\n\n');
  const sessions: Planned['sessions'] = [];
  let prompt = planPrompt(spec, planner.max_slices);
  let session: string | undefined;
  let problems: string[] = [];
  for (let attempt = 1; attempt <= 2; attempt++) {
    log(`plan${attempt > 1 ? ', again' : ''}: ${modelFor(factory, planner.tier)}, ${planner.effort} effort`);
    const r = p.agent({
      role: 'planner', tier: planner.tier, effort: planner.effort, prompt, cwd: p.cwd, system, schema: SLICING_SCHEMA, readOnly: true,
      ...(skills.dirs.length ? { addDirs: skills.dirs } : {}), ...(session ? { resume: session } : {}),
      ...(factory.limits.context_cap ? { compactAt: factory.limits.context_cap } : {}), ...(factory.limits.session_usd?.[planner.tier] ? { maxUsd: factory.limits.session_usd[planner.tier]! } : {}),
    });
    sessions.push({ stage: `plan-${attempt}`, result: r });
    p.record?.(`plan-${attempt}`, r);
    if (!r.ok) throw new AnimusError(`the planner's session ended with ${r.status}${r.text ? `: ${r.text.slice(0, 300)}` : ''}`);
    const slicing = asSlicing(r.output);
    problems = slicing ? checkSlicing(spec, slicing, planner.max_slices) : ['the answer was not a plan: it needs `brief` and `slices`, each slice with title, delivers, criteria and after'];
    if (slicing && !problems.length) return { slicing, by: 'planner', sessions };
    for (const line of problems) log(`  refused: ${line}`);
    session = r.session;
    prompt = `A script checked your plan and refused it. Answer again with the whole plan, changed so that none of these holds:\n\n${problems.map((x) => `- ${x}`).join('\n')}`;
  }
  throw new AnimusError(`the planner's plan was refused twice:\n${problems.map((x) => `  ${x}`).join('\n')}`);
}

/**
 * The criteria a job part-way through its slices is held to: those of the
 * slices done and of the one being worked on. Undefined once every slice is
 * done, or for a job of one slice: then the whole spec holds.
 */
export function criteriaSoFar(slicing: Slicing | undefined, done: number): Set<number> | undefined {
  if (!slicing || slicing.slices.length < 2 || done >= slicing.slices.length) return undefined;
  return new Set(slicing.slices.slice(0, done + 1).flatMap((s) => s.criteria));
}

export function describeSlicing(spec: Pick<Spec, 'criteria'>, planned: Pick<Planned, 'slicing' | 'by'>): string {
  const { slices, brief } = planned.slicing;
  const head = planned.by === 'person' ? 'one slice (one session, as asked: no planner session)' : planned.by === 'script' ? 'one slice (this size is not cut: no planner session)' :`${slices.length} slice(s), cut by the planner`;
  const lines = slices.flatMap((s, i) => [
    `  ${i + 1}. ${s.title}${s.prefactor ? ' (prefactor)' : ''}${s.after.length ? `, after ${s.after.join(', ')}` : ''}`,
    `       delivers  ${s.delivers}`,
    ...(s.criteria.length ? [`       criteria  ${s.criteria.map((c) => `${c}. ${spec.criteria[c - 1]?.text.split('\n')[0] ?? ''}`).join('\n                 ')}`] : []),
  ]);
  return [head, ...lines, ...(brief ? ['', 'brief for every slice:', ...brief.split('\n').map((l) => `  ${l}`)] : [])].join('\n');
}
