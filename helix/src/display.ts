// What the display (plugin/display) shows: every job with where it is now,
// the slots, and each repository's base branch and gates. Read fresh on every
// request from the table, Animus's job files and each clone's profile, so
// Helix keeps nothing for it.
import { readdirSync, readFileSync, realpathSync, statSync } from 'node:fs';
import { hostname } from 'node:os';
import { extname, join, sep } from 'node:path';
import type { Display, DisplayJob, DisplayRepo, JobCheck, JobPage } from '../../plugin/display/shape.ts';
import { readRuns, STAGES, type JobState } from '../../plugin/src/log.ts';
import type { Review } from '../../plugin/src/review.ts';
import { loadProfile, PROFILE_PATH } from '../../plugin/src/profile.ts';
import { readShots } from '../../plugin/src/ui.ts';
import { readyRepos, type Config } from './config.ts';
import type { HelixJob, Store } from './store.ts';
import type { Supervisor } from './supervisor.ts';

export type { Display, DisplayJob, DisplayRepo };

/** The most jobs the display is sent, newest kept. */
const SHOWN = 200;

const profiles = new Map<string, { mtime: number; repo: DisplayRepo }>();

/** A repository's base and gate names from its profile, read again only when the file changes. */
function repoOf(name: string, dir: string): DisplayRepo {
  let mtime = 0;
  try { mtime = statSync(join(dir, PROFILE_PATH)).mtimeMs; } catch { /* no profile: the defaults */ }
  const known = profiles.get(dir);
  if (known && known.mtime === mtime && known.repo.name === name) return known.repo;
  let repo: DisplayRepo = { name };
  try {
    const p = loadProfile(dir);
    repo = { name, base: p.base, gates: Object.keys(p.commands) };
  } catch { /* a profile that does not parse fails its jobs, not the display */ }
  profiles.set(dir, { mtime, repo });
  return repo;
}

function jobOf(job: HelixJob, supervisor: Supervisor): DisplayJob {
  const { spec: _spec, pid: _pid, answer, draft: _draft, interrupted: _interrupted, ...shown } = job;
  if (job.state === 'queued' && job.animus_job) return { ...shown, resumed: answer ? 'answer' : 'restart' };
  if (job.state !== 'running') return shown;
  const progress = supervisor.progress(job);
  const now = supervisor.log(job.id, 1).trim();
  return {
    ...shown,
    // What a resumed job said before it stopped is not where it is now.
    ...(progress && job.started && progress.at >= job.started ? { progress } : {}),
    ...(now ? { now } : {}),
  };
}

const read = (file: string) => { try { return readFileSync(file, 'utf8'); } catch { return undefined; } };
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
    if (s.c.status === 'fail') s.c.output = text.slice(s.body, sections[i + 1] ? sections[i + 1]!.at - 1 : undefined);
  });
  return checks;
}

/**
 * What a job's page shows, or nothing when Helix has no such job: its row,
 * the spec Helix was sent, and what its Animus folder and run log say, read
 * fresh. It needs a token: the server sees to that.
 */
export function jobPage(opts: { store: Store; supervisor: Supervisor }, id: number): JobPage | undefined {
  const job = opts.store.get(id);
  if (!job) return undefined;
  const spec = read(job.spec);
  const page: JobPage = { at: new Date().toISOString(), stages: STAGES, job: jobOf(job, opts.supervisor), ...(spec !== undefined ? { spec } : {}), log: opts.supervisor.log(id, Infinity) };
  const home = opts.supervisor.animusHome(job.person);
  const dir = folderOf(opts.supervisor, job);
  if (!job.animus_job || !dir) return page;
  const runs = readRuns(join(home, 'runs.jsonl')).filter((r) => r.job === job.animus_job);
  if (runs.length) page.ms = Object.fromEntries(STAGES.map((s) => [s, runs.reduce((sum, r) => sum + (r.ms?.[s] ?? 0), 0)]));
  const state = readJson<JobState>(join(dir, 'state.json'));
  const cut = state?.slicing?.slices ?? [];
  if (cut.length > 1) page.slices = cut.map((s, i) => ({ title: s.title, delivers: s.delivers, done: i < (state?.slices_done?.length ?? 0) }));
  const gates = written(join(dir, 'gates'), /^run-\d+\.txt$/).at(-1);
  const checks = gates ? parseGates(read(gates) ?? '') : [];
  if (checks.length) page.checks = checks;
  const reviews = written(dir, /^review-\d+\.json$/).flatMap((f) => readJson<Review>(f) ?? []).filter((r) => Array.isArray(r.findings));
  if (reviews.length) page.reviews = reviews.map((r) => ({ summary: r.summary, findings: r.findings }));
  // The question it stopped on is in its state until a run reads the answer, which Helix holds till then.
  const open = state?.outcome === 'needs-input' && state.question ? [{ question: state.question, ...(job.answer ? { answer: job.answer } : {}) }] : [];
  const questions = [...(state?.answers ?? []), ...open];
  if (questions.length) page.questions = questions;
  const shots = shotsOf(dir);
  if (shots.files.length) page.shots = shots;
  return page;
}

/** The screenshots a job's shots folder lists, as its manifest names them under that folder, and when they were taken. */
function shotsOf(dir: string): { at: string; files: string[] } {
  const s = readShots(join(dir, 'shots'));
  const build: unknown = s?.build;
  return { at: String(s?.at ?? ''), files: Array.isArray(build) ? build.filter((f): f is string => typeof f === 'string') : [] };
}

/** The job's Animus folder. Its Animus id comes from what the job printed: only a plain name is taken as a folder. */
function folderOf(supervisor: Supervisor, job: HelixJob): string | undefined {
  if (!job.animus_job || !/^[A-Za-z0-9][\w.-]*$/.test(job.animus_job)) return undefined;
  return join(supervisor.animusHome(job.person), 'jobs', job.animus_job);
}

const IMAGE: Record<string, string> = { '.png': 'image/png', '.jpg': 'image/jpeg', '.jpeg': 'image/jpeg', '.webp': 'image/webp', '.gif': 'image/gif' };

/**
 * One of a job's screenshots, or nothing: only a name its shots folder's
 * manifest lists, and only a file that is truly inside that folder, so no
 * name or link a job left there leads anywhere else. It needs a token: the
 * server sees to that.
 */
export function jobShot(opts: { store: Store; supervisor: Supervisor }, id: number, name: string): { type: string; body: Buffer } | undefined {
  const job = opts.store.get(id);
  const dir = job && folderOf(opts.supervisor, job);
  const type = IMAGE[extname(name).toLowerCase()];
  if (!dir || !type || !shotsOf(dir).files.includes(name)) return undefined;
  try {
    const root = realpathSync(join(dir, 'shots'));
    const file = realpathSync(join(root, name));
    if (!file.startsWith(root + sep)) return undefined;
    return { type, body: readFileSync(file) };
  } catch { return undefined; }
}

export function display(opts: { config: Config; store: Store; supervisor: Supervisor }): Display {
  const { config, store, supervisor } = opts;
  return {
    name: config.name ?? hostname(),
    at: new Date().toISOString(),
    slots: config.slots,
    stages: STAGES,
    repos: Object.entries(readyRepos(store)).map(([name, dir]) => repoOf(name, dir)),
    jobs: store.list(SHOWN).map((j) => jobOf(j, supervisor)),
  };
}
