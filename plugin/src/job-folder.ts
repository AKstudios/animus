// What a job's Animus folder and the run log say about it, in the pieces of a
// job page (plugin/display/shape.ts). Helix reads a person's folder with it,
// and the local display reads this machine's: both answer the same page.
import { readdirSync, readFileSync, realpathSync, statSync } from 'node:fs';
import { extname, join, sep } from 'node:path';
import type { JobCheck, JobPage, JobRun } from '../display/shape.ts';
import { describeTools, readToolsFile, STAGES, type JobState, type Run } from './log.ts';
import type { Review } from './review.ts';
import { readShots } from './ui.ts';

export const read = (file: string) => { try { return readFileSync(file, 'utf8'); } catch { return undefined; } };
const readJson = <T>(file: string): T | undefined => { try { return JSON.parse(readFileSync(file, 'utf8')) as T; } catch { return undefined; } };

/** The files in a folder whose names match, oldest written first: a resumed job numbers its gate runs from 1 again. */
function written(dir: string, name: RegExp): string[] {
  try {
    return readdirSync(dir).filter((f) => name.test(f)).map((f) => join(dir, f))
      .map((file) => ({ file, mtime: statSync(file).mtimeMs })).sort((a, b) => a.mtime - b.mtime).map((f) => f.file);
  } catch { return []; }
}

/** The checks of a gate run as the job's folder keeps it (gateReport): a line each, then what each that ran printed, of which a failed one's is kept. */
function parseGates(text: string): JobCheck[] {
  const checks: JobCheck[] = [];
  for (const line of text.split('\n')) {
    const m = /^(ok {2}|FAIL|skip) ([^:]+): (.*) \((.*)\)$/.exec(line);
    if (!m) break;
    checks.push({ name: m[2]!, command: m[3]!, status: m[1] === 'FAIL' ? 'fail' : m[1] === 'skip' ? 'skip' : 'ok', detail: m[4]! });
  }
  // Each check that ran has its section, in order: `=== name: command` and its output, up to the next one.
  let from = 0;
  const sections = checks.filter((c) => c.status !== 'skip').map((c) => {
    const mark = `=== ${c.name}: ${c.command}\n`;
    const at = text.indexOf(mark, from);
    if (at >= 0) from = at + mark.length;
    return { c, at, body: at + mark.length };
  }).filter((s) => s.at >= 0);
  sections.forEach((s, i) => {
    const out = text.slice(s.body, sections[i + 1] ? sections[i + 1]!.at - 1 : undefined);
    if (out.trim() || s.c.status === 'fail') s.c.output = out;
  });
  return checks;
}

/** The screenshots a job's shots folder lists, as its manifest names them under that folder, and when they were taken. */
export function shotsOf(dir: string): { at: string; files: string[] } {
  const s = readShots(join(dir, 'shots'));
  const build: unknown = s?.build;
  return { at: String(s?.at ?? ''), files: Array.isArray(build) ? build.filter((f): f is string => typeof f === 'string') : [] };
}

const IMAGE: Record<string, string> = { '.png': 'image/png', '.jpg': 'image/jpeg', '.jpeg': 'image/jpeg', '.webp': 'image/webp', '.gif': 'image/gif' };

/**
 * One of a job's screenshots, or nothing: only a name its shots folder's
 * manifest lists, and only a file that is truly inside that folder, so no
 * name or link a job left there leads anywhere else.
 */
export function shotFile(dir: string, name: string): { type: string; body: Buffer } | undefined {
  const type = IMAGE[extname(name).toLowerCase()];
  if (!type || !shotsOf(dir).files.includes(name)) return undefined;
  try {
    const root = realpathSync(join(dir, 'shots'));
    const file = realpathSync(join(root, name));
    if (!file.startsWith(root + sep)) return undefined;
    return { type, body: readFileSync(file) };
  } catch { return undefined; }
}

/** A job's runs put together (a resumed job has more than one); the tool calls are read from the job folder, wherever its Animus home is. */
function jobRun(dir: string, runs: readonly Run[]): JobRun {
  const agents = runs.flatMap((r) => r.agents ?? []);
  const lines = readToolsFile(join(dir, 'tools.jsonl'));
  return {
    fix_rounds: runs.reduce((n, r) => n + (r.fix_rounds ?? 0), 0),
    gates: runs.flatMap((r) => r.gates ?? []).map((g) => ({ flaky: g.checks.filter((c) => c.flaky).map((c) => c.name) })),
    agents: agents.map((a) => ({ role: a.role, tier: a.tier, cost_usd: a.cost_usd, calls: a.tools?.calls ?? 0, errors: a.tools?.errors ?? 0 })),
    findings: runs.flatMap((r) => r.review?.log ?? []).map(({ round, severity, fate }) => ({ round, severity, fate })),
    tools: { calls: agents.reduce((n, a) => n + (a.tools?.calls ?? 0), 0), errors: agents.reduce((n, a) => n + (a.tools?.errors ?? 0), 0), text: describeTools(agents, lines) },
  };
}

/** The parts of a job page that its folder and the run log hold. `answer` is an answer to the question it stopped on that has not been read by a run yet. */
export function folderParts(dir: string, runs: readonly Run[], answer?: string): Partial<JobPage> {
  const page: Partial<JobPage> = {};
  if (runs.length) {
    page.ms = Object.fromEntries(STAGES.map((s) => [s, runs.reduce((sum, r) => sum + (r.ms?.[s] ?? 0), 0)]));
    page.run = jobRun(dir, runs);
  }
  const state = readJson<JobState>(join(dir, 'state.json'));
  const cut = state?.slicing?.slices ?? [];
  if (cut.length > 1) page.slices = cut.map((s, i) => ({ title: s.title, delivers: s.delivers, done: i < (state?.slices_done?.length ?? 0) }));
  const gateFiles = written(join(dir, 'gates'), /^run-\d+\.txt$/);
  const gates = gateFiles.at(-1);
  if (gateFiles.length) page.gate_runs = gateFiles.length;
  const checks = gates ? parseGates(read(gates) ?? '') : [];
  if (checks.length) page.checks = checks;
  const reviews = written(dir, /^review-\d+\.json$/).flatMap((f) => readJson<Review>(f) ?? []).filter((r) => Array.isArray(r.findings));
  if (reviews.length) page.reviews = reviews.map((r) => ({ summary: r.summary, findings: r.findings }));
  // The question it stopped on is in its state until a run reads the answer.
  const open = state?.outcome === 'needs-input' && state.question ? [{ question: state.question, ...(answer ? { answer } : {}) }] : [];
  const questions = [...(state?.answers ?? []), ...open];
  if (questions.length) page.questions = questions;
  const shots = shotsOf(dir);
  if (shots.files.length) page.shots = shots;
  return page;
}
