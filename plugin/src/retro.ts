// A retro (docs/specs/insights-2-lessons.md): one read-only session reads a
// project's recent run records, assembled here by script from the run log, the
// job folders and outcomes.json, and proposes lessons. The session never
// writes anything: its answer is parsed here, and a script drops what breaks
// the rules and stores the rest as proposed.
import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { basename, delimiter, join } from 'node:path';
import type { Agent, AgentResult } from './agent.ts';
import { addProposals, inScope, LESSON_AGENTS, readLessons, SCOPES, seenAgain, stateOf, type Lesson } from './lessons.ts';
import { animusHome, loadState, readRuns, type Run } from './log.ts';
import { readOutcomes, type Outcomes } from './outcomes.ts';
import { modelFor, readPrompt, type Factory } from './profiles.ts';
import { AnimusError } from './proc.ts';

export const MAX_PROPOSALS = 5;
const DAY = 24 * 60 * 60 * 1000;

const RETRO_SCHEMA = {
  type: 'object', required: ['proposals'],
  properties: {
    proposals: { type: 'array', items: { type: 'object', required: ['text', 'scope', 'agent', 'cites'], properties: {
      text: { type: 'string' }, scope: { enum: SCOPES }, agent: { enum: LESSON_AGENTS }, cites: { type: 'array', items: { type: 'string' } },
    } } },
    seen_again: { type: 'array', items: { type: 'object', required: ['id', 'cites'], properties: { id: { type: 'integer' }, cites: { type: 'array', items: { type: 'string' } } } } },
  },
} as const;

type Answer = { proposals?: { text?: unknown; scope?: unknown; agent?: unknown; cites?: unknown }[]; seen_again?: { id?: unknown; cites?: unknown }[] };

export type RetroJob = { job: string; text: string; /** Its pull request was reverted or reworked. */ flagged: boolean };

const list = (items: readonly string[]) => items.join(', ');

/** The Animus homes a retro reads: this one, and each in ANIMUS_RETRO_HOMES (a Helix with containers lists its people's, where their jobs write). */
export const retroHomes = (): string[] => [animusHome(), ...(process.env.ANIMUS_RETRO_HOMES?.split(delimiter).filter(Boolean) ?? [])];

/** What the retro reads about each job of a project that ran in the window: a few lines from its run log lines, folder and outcome, each from the home the job ran in. */
export function retroJobs(project: string, days: number, now: number, homes: readonly string[] = retroHomes()): RetroJob[] {
  const byJob = new Map<string, { home: string; runs: Run[] }>();
  for (const home of homes) {
    for (const r of readRuns(join(home, 'runs.jsonl'))) {
      if (basename(r.repo) !== project || Date.parse(r.ended) < now - days * DAY) continue;
      const known = byJob.get(r.job) ?? { home, runs: [] };
      known.runs.push(r);
      byJob.set(r.job, known);
    }
  }
  const outcomes: Outcomes = Object.assign({}, ...homes.map((h) => readOutcomes(join(h, 'outcomes.json'))));
  return [...byJob].map(([job, { home, runs: ofJob }]) => {
    const last = ofJob.at(-1)!;
    const pr = ofJob.findLast((r) => r.pr)?.pr;
    const o = pr ? outcomes[pr] : undefined;
    const state = loadState(job, home);
    const lines = [
      `## job ${job}: ${last.title}`,
      `${last.size}/${last.difficulty}/${last.type}; ${ofJob.length} run${ofJob.length === 1 ? '' : 's'}; ended ${last.outcome}${last.cause ? ` (cause ${last.cause})` : ''}${last.reason ? `: ${last.reason.split('\n')[0]!.slice(0, 200)}` : ''}; ${last.fix_rounds} fix rounds; $${ofJob.reduce((s, r) => s + r.cost_usd, 0).toFixed(2)}`,
    ];
    ofJob.flatMap((r) => r.gates).forEach((g, i) => {
      const failed = g.checks.filter((c) => !c.ok && !c.skipped).map((c) => c.name);
      const flaky = g.checks.filter((c) => c.flaky).map((c) => c.name);
      lines.push(`gates ${i + 1}: ${g.ok ? 'passed' : `failed ${list(failed)}`}${flaky.length ? `; flaky: ${list(flaky)}` : ''}`);
    });
    if (last.failing_checks?.length) lines.push(`still failing at the end: ${list(last.failing_checks)}`);
    const findings = last.review?.log ?? [];
    if (findings.length) lines.push(`review findings: ${findings.map((f) => `r${f.round} ${f.severity}${f.file ? ` ${f.file}${f.line ? `:${f.line}` : ''}` : ''} ${f.fate}`).join('; ')}`);
    for (const a of ofJob.flatMap((r) => r.agents)) {
      if (!a.tools) continue;
      const by = Object.entries(a.tools.by_tool).map(([n, c]) => `${n} ${c}`);
      lines.push(`session ${a.stage} ${a.role}: ${a.tools.calls} tool calls, ${a.tools.errors} failed (${list(by)})`);
    }
    for (const q of [...(state?.answers ?? []), ...(state?.outcome === 'needs-input' && state.question ? [{ question: state.question, answer: '(unanswered)' }] : [])]) lines.push(`question: ${q.question.replace(/\s+/g, ' ')} answer: ${q.answer.replace(/\s+/g, ' ')}`);
    if (o) lines.push(`pull request ${pr}: ${o.state.toLowerCase()}; ${o.human_commits} human commits${o.human_lines ? ` (+${o.human_lines.added} -${o.human_lines.removed} lines)` : ''}${o.reverted ? '; reverted' : ''}${o.reworked ? '; reworked' : ''}`);
    return { job, text: lines.join('\n'), flagged: Boolean(o?.reverted || o?.reworked) };
  });
}

const told = (l: Lesson) => `- ${l.id} (${l.scope}, for the ${l.agent}): ${l.text}`;

function retroPrompt(project: string, days: number, jobs: readonly RetroJob[], known: { kept: Lesson[]; dismissed: Lesson[]; proposed: Lesson[] }): string {
  return [
    `Project ${project}: its ${jobs.length} job${jobs.length === 1 ? '' : 's'} of the last ${days} days. Propose at most ${MAX_PROPOSALS} lessons from them.`,
    `Kept lessons. Do not propose these again; if the jobs below show one again, answer it in seen_again with its id and the new jobs that show it:\n${known.kept.map(told).join('\n') || '(none)'}`,
    `Dismissed lessons. A person said no to each: do not propose them or anything close:\n${known.dismissed.map(told).join('\n') || '(none)'}`,
    `Already proposed, waiting for a person. Do not propose these again:\n${known.proposed.map(told).join('\n') || '(none)'}`,
    `<jobs>\n${jobs.map((j) => j.text).join('\n\n')}\n</jobs>`,
  ].join('\n\n');
}

const normal = (s: string) => s.toLowerCase().replace(/\s+/g, ' ').trim();

/**
 * Runs the retro for a project over its last `days` days. Proposals the script
 * keeps: one sentence, a known scope and agent, cites that are jobs of the
 * window, and at least two of them (one is enough when its pull request was
 * reverted or reworked); one a person kept, dismissed or was already shown is
 * dropped, and only the first MAX_PROPOSALS are stored.
 */
export function runRetro(p: { factory: Factory; agent: Agent; project: string; days: number; now?: number; log?: (line: string) => void }): { proposed: Lesson[]; seen: number[]; result: AgentResult } {
  const retro = p.factory.retro;
  if (!retro) throw new AnimusError('profiles.yaml has no retro');
  const now = p.now ?? Date.now();
  const jobs = retroJobs(p.project, p.days, now);
  if (!jobs.length) throw new AnimusError(`${p.project} has no run in the last ${p.days} days to look back on`);
  const inWindow = new Map(jobs.map((j) => [j.job, j]));
  const all = readLessons().filter((l) => inScope(l, p.project));
  const known = { kept: all.filter((l) => stateOf(l, now) === 'kept'), dismissed: all.filter((l) => l.status === 'dismissed'), proposed: all.filter((l) => l.status === 'proposed') };
  p.log?.(`retro: ${modelFor(p.factory, retro.tier)}, ${retro.effort} effort, at most $${retro.max_usd}`);
  // No worktree and no files of its own: the session reads nothing but the folder it starts in, which is empty.
  const cwd = mkdtempSync(join(tmpdir(), 'animus-retro-'));
  let result: AgentResult;
  try {
    result = p.agent({ role: 'retro', tier: retro.tier, effort: retro.effort, prompt: retroPrompt(p.project, p.days, jobs, known), cwd, system: readPrompt('retro'), schema: RETRO_SCHEMA, filesOnly: true, maxUsd: retro.max_usd });
  } finally { rmSync(cwd, { recursive: true, force: true }); }
  if (!result.ok) throw new AnimusError(`the retro session ended with ${result.status}, so no lesson was proposed`);
  const answer = result.output as Answer | undefined;
  if (!answer || !Array.isArray(answer.proposals)) throw new AnimusError('the retro session answered with no proposals');

  const cited = (v: unknown) => [...new Set(Array.isArray(v) ? v.filter((c): c is string => typeof c === 'string' && inWindow.has(c)) : [])];
  const blocked = new Set([...known.kept, ...known.dismissed, ...known.proposed].map((l) => normal(l.text)));
  const keep: Pick<Lesson, 'text' | 'scope' | 'project' | 'agent' | 'cites'>[] = [];
  for (const raw of answer.proposals) {
    const text = typeof raw.text === 'string' ? raw.text.replace(/\s+/g, ' ').trim() : '';
    const cites = cited(raw.cites);
    const scope = SCOPES.find((s) => s === raw.scope);
    const agent = LESSON_AGENTS.find((a) => a === raw.agent);
    if (!text || !scope || !agent || blocked.has(normal(text))) continue;
    if (cites.length < 2 && !(cites.length === 1 && inWindow.get(cites[0]!)!.flagged)) continue;
    blocked.add(normal(text));
    keep.push({ text, scope, project: p.project, agent, cites });
  }
  const proposed = addProposals(keep.slice(0, MAX_PROPOSALS), now);

  // Only a lesson that is kept now can be seen again, and only in jobs it did not already cite.
  const seen: number[] = [];
  for (const s of Array.isArray(answer.seen_again) ? answer.seen_again : []) {
    const lesson = known.kept.find((l) => l.id === s.id);
    const fresh = cited(s.cites).filter((c) => !lesson?.cites.includes(c));
    if (!lesson || !fresh.length) continue;
    seenAgain(lesson.id, fresh, now);
    seen.push(lesson.id);
  }
  return { proposed, seen, result };
}
