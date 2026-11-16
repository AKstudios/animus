// Where Animus keeps what it knows about jobs: one folder per job, and the
// run log, one JSON line per run (docs/factory.md, "What to log"). Both live
// under Animus's home, outside every repository, so a job leaves nothing in
// the project but its branch.
import { appendFileSync, existsSync, mkdirSync, readFileSync, renameSync, writeFileSync } from 'node:fs';
import { homedir } from 'node:os';
import { join } from 'node:path';
import type { Tokens } from './agent.ts';
import type { Plan } from './profiles.ts';
import type { Finding } from './review.ts';
import type { Slicing } from './slices.ts';
import type { Workspace } from './workspace.ts';

export const animusHome = () => process.env.ANIMUS_HOME ?? join(homedir(), '.animus');
export const jobDir = (job: string) => join(animusHome(), 'jobs', job);
export const runLog = () => join(animusHome(), 'runs.jsonl');

export type AgentRun = {
  stage: string; role: string; tier: string; effort: string; model: string;
  session?: string; ok: boolean; status: string; cost_usd: number; turns: number; tokens: Tokens; ms: number; transcript?: string;
  /** Tokens in the session's context when it ended. */
  context?: number;
};

export type GateRun = { attempt: number; ok: boolean; ms: number; checks: { name: string; ok: boolean; skipped: boolean; ms: number }[] };

export type Outcome = 'pr' | 'draft-pr' | 'dry-run' | 'needs-input' | 'failed';

/** One line of the run log. */
export type Run = {
  job: string;
  repo: string;
  submitter: string;
  trigger: string;
  title: string;
  /** The spec file the job was started from, as a path on the machine that ran it. */
  spec_file?: string;
  size: string;
  difficulty: string;
  type: string;
  /** Labels the spec left out, so the defaults ran. */
  labels_defaulted: string[];
  /** The implementer's raises of size or difficulty, with its reason. */
  escalations: { size?: string; difficulty?: string; why: string }[];
  provider: string;
  /** The commit of Animus's prompts, profiles and scripts that ran the job. */
  factory_version: string;
  skills: string[];
  started: string;
  ended: string;
  /** Wall time per stage, in ms. queue is 0 in local mode; plan is the planner's sessions. */
  ms: { queue: number; setup: number; plan: number; implement: number; gates: number; review: number; evidence: number; pr: number; total: number };
  agents: AgentRun[];
  cost_usd: number;
  turns: number;
  tokens: Tokens;
  gates: GateRun[];
  /** Times the gates sent the work back. */
  fix_rounds: number;
  /** Rounds that began a fresh implementer session because the last one ended over the context budget. */
  handoffs?: number;
  /** How the spec was cut: by the planner or by script, into how many slices, and how many passed their gates. */
  slices?: { by: 'planner' | 'script'; planned: number; done: number; fallback?: string };
  review: { rounds: number; findings: number; blockers: number; acted_on: number; open: number } | null;
  outcome: Outcome;
  reason?: string;
  question?: string;
  pr?: string;
  branch: string;
  base: string;
  head?: string;
  /** Files changed under the profile's protected globs. */
  protected_touched: string[];
  /** The job's folder: spec, gate output, reviews, transcripts. */
  dir: string;
};

/** What a job needs to be picked up again: `animus resume`. */
export type JobState = {
  job: string;
  repo: string;
  spec: string;
  /** The spec file the job was started from; spec is the job's own copy of it. */
  source?: string;
  workspace: Workspace;
  plan: Plan;
  session?: string;
  /** Tokens in that session's context when it last ended: over the budget, the next round starts a fresh one. */
  context?: number;
  /** How the spec is cut, decided once when the job starts, and who cut it. */
  slicing?: Slicing;
  sliced_by?: 'planner' | 'script';
  /** The slices whose gates passed, as the summary each one's session gave. Its length is the slice the job is on. */
  slices_done?: string[];
  outcome?: Outcome;
  question?: string;
  /** The questions this job stopped to ask, each with the person's answer: the reviewer reads them beside the spec. */
  answers?: { question: string; answer: string }[];
  findings?: Finding[];
};

export const STAGES = ['setup', 'plan', 'implement', 'gates', 'review', 'evidence', 'pr'] as const;
export type Stage = (typeof STAGES)[number];

/** Where a running job is, for whoever watches it: the stage, and who or what is doing it. */
export type Progress = { stage: Stage; who: string; at: string };

export function writeJson(file: string, value: unknown): void {
  mkdirSync(join(file, '..'), { recursive: true });
  writeFileSync(`${file}.tmp`, `${JSON.stringify(value, null, 2)}\n`);
  renameSync(`${file}.tmp`, file);
}

export function saveState(state: JobState): void {
  writeJson(join(jobDir(state.job), 'state.json'), state);
}

export function loadState(job: string): JobState | undefined {
  const file = join(jobDir(job), 'state.json');
  return existsSync(file) ? (JSON.parse(readFileSync(file, 'utf8')) as JobState) : undefined;
}

export function saveProgress(job: string, stage: Stage, who: string): void {
  writeJson(join(jobDir(job), 'progress.json'), { stage, who, at: new Date().toISOString() } satisfies Progress);
}

export function loadProgress(job: string): Progress | undefined {
  try { return JSON.parse(readFileSync(join(jobDir(job), 'progress.json'), 'utf8')) as Progress; } catch { return undefined; }
}

export function appendRun(run: Run): void {
  mkdirSync(animusHome(), { recursive: true });
  appendFileSync(runLog(), `${JSON.stringify(run)}\n`);
}

export function readRuns(): Run[] {
  if (!existsSync(runLog())) return [];
  return readFileSync(runLog(), 'utf8').split('\n').filter(Boolean).flatMap((line) => {
    try { return [JSON.parse(line) as Run]; } catch { return []; }
  });
}

const duration = (ms: number) => (ms >= 60_000 ? `${Math.floor(ms / 60_000)}m${String(Math.round((ms % 60_000) / 1000)).padStart(2, '0')}s` : `${Math.round(ms / 1000)}s`);

/** `animus runs`: the latest runs, newest last, one line each. */
export function describeRuns(runs: readonly Run[]): string {
  if (!runs.length) return `no runs yet (${runLog()})`;
  const rows = runs.map((r) => [
    r.started.slice(0, 16).replace('T', ' '), r.job, `${r.size}/${r.difficulty}/${r.type}`, r.outcome,
    duration(r.ms.total), `$${r.cost_usd.toFixed(2)}`, `${r.fix_rounds} fix`, r.pr ?? r.reason?.split('\n')[0]?.slice(0, 60) ?? '',
  ]);
  const widths = rows[0]!.map((_, i) => Math.max(...rows.map((row) => row[i]!.length)));
  return rows.map((row) => row.map((cell, i) => cell.padEnd(widths[i]!)).join('  ').trimEnd()).join('\n');
}
