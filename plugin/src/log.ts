// Where Animus keeps what it knows about jobs: one folder per job, and the
// run log, one JSON line per run (docs/factory.md, "What to log"). Both live
// under Animus's home, outside every repository, so a job leaves nothing in
// the project but its branch.
import { appendFileSync, existsSync, mkdirSync, readFileSync, renameSync, writeFileSync } from 'node:fs';
import { homedir, hostname } from 'node:os';
import { join } from 'node:path';
import type { ToolCall, Tokens } from './agent.ts';
import type { Plan } from './profiles.ts';
import type { Finding, Review } from './review.ts';
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
  /** What the session's tool calls came to; the calls are in the job's tools.jsonl. */
  tools?: { calls: number; errors: number; by_tool: Record<string, number> };
};

/** One line of a job's tools.jsonl. */
export type ToolLine = ToolCall & { stage: string; role: string; session?: string };

export const toolsLog = (job: string) => join(jobDir(job), 'tools.jsonl');

export const readTools = (job: string): ToolLine[] => readToolsFile(toolsLog(job));

/** The tool lines of a tools.jsonl wherever it is (a Helix person's job folder is not under this home). */
export function readToolsFile(file: string): ToolLine[] {
  if (!existsSync(file)) return [];
  return readFileSync(file, 'utf8').split('\n').filter(Boolean).flatMap((line) => {
    try { return [JSON.parse(line) as ToolLine]; } catch { return []; }
  });
}

/** `animus tools`: each agent session of the job with its calls counted, then every call in order. */
export function describeTools(agents: readonly AgentRun[], lines: readonly ToolLine[]): string {
  const out: string[] = [];
  for (const a of agents) {
    const t = a.tools ?? { calls: 0, errors: 0, by_tool: {} };
    const by = Object.entries(t.by_tool).map(([name, n]) => `${name} ${n}`).join(', ');
    out.push(`${a.stage}  ${a.role}  ${a.tier}  ${a.model}  ${t.calls} calls, ${t.errors} failed${by ? `: ${by}` : ''}`);
  }
  if (lines.length) out.push('', ...lines.map((l) => `${l.at}  ${l.stage}  ${l.tool}  ${l.target.replace(/\s+/g, ' ')}${l.ok ? '' : '  FAILED'}`));
  return out.join('\n');
}

export type GateRun = { attempt: number; ok: boolean; ms: number; checks: { name: string; ok: boolean; skipped: boolean; ms: number; flaky?: boolean }[] };

export type Outcome = 'pr' | 'draft-pr' | 'dry-run' | 'needs-input' | 'failed';

/** Helix leaves this file beside a job's spec before it kills the job, so the job can tell a cancel from an interruption. */
export const CANCELLED_MARKER = 'cancelled';

/** Why a run that did not end as a pull request stopped, by where it stopped. Script-set, never by a model. */
export const CAUSES = ['setup', 'admit', 'plan', 'needs-input', 'gates', 'review', 'budget', 'context', 'agent-error', 'cancelled', 'interrupted'] as const;
export type Cause = (typeof CAUSES)[number];

/** A review finding and what became of it: sent back and fixed, a blocker still open, or left for the person. */
export type FindingLog = { round: number; severity: string; file?: string; line?: number; fate: 'fixed' | 'open' | 'not-acted-on' };

/** One line of the run log. */
export type Run = {
  job: string;
  repo: string;
  submitter: string;
  trigger: string;
  /** The job this one is a fix of: the one before it on the same pull request. */
  fix_of?: string;
  /** A fix that began from the pull request alone, because the earlier job's folder or worktree was gone: no earlier session carried on. */
  without_session?: true;
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
  /** Ids of the kept lessons (lessons.ts) the job's agents were given. */
  lessons?: number[];
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
  review: { rounds: number; findings: number; blockers: number; acted_on: number; open: number; log?: FindingLog[] } | null;
  outcome: Outcome;
  /** Set on every run that did not end as a pull request. */
  cause?: Cause;
  /** With cause `gates`: the checks still failing. */
  failing_checks?: string[];
  /** With cause `review`: the blockers left. */
  blockers_left?: number;
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
  /** Set on a fix: the job it continues, what was asked, and every fix on the pull request so far (this one last, once its body is built). */
  fix_of?: string;
  ask?: string;
  /** On a fix: the pull request it updates, as its URL. */
  pr?: string;
  fixes?: { ask: string; job: string; cost_usd: number }[];
  /** On a fix: the commit it started from (the branch as GitHub had it), so a fix picked up again can tell whether the implementer changed anything. */
  fix_start?: string;
  /** The issue the pull request closes, so a fix keeps the line. */
  closes?: number;
  /** The questions this job stopped to ask, each with the person's answer: the reviewer reads them beside the spec. */
  answers?: { question: string; answer: string }[];
  findings?: Finding[];
  /** Set when the catch-up stopped to ask: the reviewed work is done, so a resumed job starts at the catch-up with what the PR needs from before it. */
  catch_up?: { summary: string; notes?: string; review?: Review; review_rounds: number };
};

export const STAGES = ['setup', 'plan', 'implement', 'gates', 'review', 'evidence', 'pr'] as const;
export type Stage = (typeof STAGES)[number];

/** Where a running job is, for whoever watches it: the stage, and who or what is doing it. */
export type Progress = {
  stage: Stage; who: string; at: string;
  /** The `animus run` process and machine writing it: a job is running only where that process is alive. */
  pid?: number; host?: string;
};

export function writeJson(file: string, value: unknown): void {
  mkdirSync(join(file, '..'), { recursive: true });
  writeFileSync(`${file}.tmp`, `${JSON.stringify(value, null, 2)}\n`);
  renameSync(`${file}.tmp`, file);
}

export function saveState(state: JobState): void {
  writeJson(join(jobDir(state.job), 'state.json'), state);
}

/** A job's state; home is the Animus home it ran under, when not this process's (a Helix person's). */
export function loadState(job: string, home = animusHome()): JobState | undefined {
  const file = join(home, 'jobs', job, 'state.json');
  return existsSync(file) ? (JSON.parse(readFileSync(file, 'utf8')) as JobState) : undefined;
}

export function saveProgress(job: string, stage: Stage, who: string): void {
  writeJson(join(jobDir(job), 'progress.json'), { stage, who, at: new Date().toISOString(), pid: process.pid, host: hostname() } satisfies Progress);
}

/** True for a live process; EPERM means it exists under another user. */
export const alive = (pid: number): boolean => {
  try { process.kill(pid, 0); return true; } catch (e) { return (e as NodeJS.ErrnoException).code === 'EPERM'; }
};

/** A job's progress; home is the Animus home it ran under, when not this process's (a Helix job in a container). */
export function loadProgress(job: string, home = animusHome()): Progress | undefined {
  try { return JSON.parse(readFileSync(join(home, 'jobs', job, 'progress.json'), 'utf8')) as Progress; } catch { return undefined; }
}

export function appendRun(run: Run): void {
  mkdirSync(animusHome(), { recursive: true });
  appendFileSync(runLog(), `${JSON.stringify(run)}\n`);
}

/** The run log's lines; file is another Animus home's run log (a Helix person's). */
export function readRuns(file = runLog()): Run[] {
  if (!existsSync(file)) return [];
  return readFileSync(file, 'utf8').split('\n').filter(Boolean).flatMap((line) => {
    // Only objects: a line that is JSON but not a run (`null`, a number) is skipped like one that is not JSON.
    try { const r: unknown = JSON.parse(line); return r && typeof r === 'object' && !Array.isArray(r) ? [r as Run] : []; } catch { return []; }
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
