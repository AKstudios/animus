// Where Animus keeps what it knows about jobs: one folder per job, and the
// run log, one JSON line per run (docs/factory.md, "What to log"). Both live
// under Animus's home, outside every repository, so a job leaves nothing in
// the project but its branch.
import { appendFileSync, existsSync, mkdirSync, readdirSync, readFileSync, renameSync, writeFileSync } from 'node:fs';
import { homedir } from 'node:os';
import { join } from 'node:path';
import type { Tokens } from './agent.ts';
import type { Plan } from './profiles.ts';
import type { Finding } from './review.ts';
import type { Workspace } from './workspace.ts';

export const animusHome = () => process.env.ANIMUS_HOME ?? join(homedir(), '.animus');
export const jobDir = (job: string) => join(animusHome(), 'jobs', job);
export const runLog = () => join(animusHome(), 'runs.jsonl');

export type AgentRun = {
  stage: string; role: string; tier: string; effort: string; model: string;
  session?: string; ok: boolean; status: string; cost_usd: number; turns: number; tokens: Tokens; ms: number; transcript?: string;
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
  /** Wall time per stage, in ms. queue is 0 in local mode. */
  ms: { queue: number; setup: number; implement: number; gates: number; review: number; evidence: number; pr: number; total: number };
  agents: AgentRun[];
  cost_usd: number;
  turns: number;
  tokens: Tokens;
  gates: GateRun[];
  /** Times the gates sent the work back. */
  fix_rounds: number;
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
  workspace: Workspace;
  plan: Plan;
  session?: string;
  outcome?: Outcome;
  question?: string;
  findings?: Finding[];
};

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

/** Whether the detached process of a job still runs. */
export function running(job: string): boolean {
  try {
    process.kill(Number(readFileSync(join(jobDir(job), 'pid'), 'utf8')), 0);
    return true;
  } catch {
    return false;
  }
}

const lastLines = (file: string, n: number) => (existsSync(file) ? readFileSync(file, 'utf8').trimEnd().split('\n').slice(-n) : []);

/** `animus status <job>`: where one job is, from its files alone. */
export function describeJob(job: string): string {
  const state = loadState(job);
  const last = readRuns().filter((r) => r.job === job).at(-1);
  const log = join(jobDir(job), 'run.log');
  const lines = [job];
  if (running(job)) lines.push('  running');
  else if (last) lines.push(`  ${last.outcome}${last.pr ? `: ${last.pr}` : ''}${last.question ? `: ${last.question}` : ''}${last.reason ? `: ${last.reason.split('\n')[0]}` : ''}`);
  else if (state) lines.push(`  stopped without finishing; pick it up with: animus resume ${job} --detach`);
  else if (existsSync(log)) lines.push('  did not start');
  else return `no job ${job} under ${jobDir('')}`;
  if (last?.outcome === 'needs-input' && !running(job)) lines.push(`  answer with: animus resume ${job} --answer "<your answer>" --detach`);
  if (state) lines.push(`  branch ${state.workspace.branch} in ${state.repo}`);
  const tail = lastLines(log, 12);
  if (tail.length) lines.push(`  the end of ${log}:`, ...tail.map((l) => `    ${l}`));
  return lines.join('\n');
}

/** `animus status`: the jobs running now, then the latest results. */
export function describeStatus(): string {
  const root = join(animusHome(), 'jobs');
  const jobs = existsSync(root) ? readdirSync(root) : [];
  const live = jobs.filter(running).map((job) => `running  ${job}  ${lastLines(join(jobDir(job), 'run.log'), 1)[0]?.trim() ?? ''}`);
  const runs = readRuns();
  const ended = new Set(runs.map((r) => r.job));
  const lost = jobs.filter((job) => !running(job) && !ended.has(job) && existsSync(join(jobDir(job), 'state.json'))).map((job) => `stopped  ${job}  did not finish; animus resume ${job} --detach`);
  return [...live, ...lost, describeRuns(runs.slice(-8))].join('\n');
}
