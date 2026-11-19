// What the display (plugin/display) shows: every job with where it is now,
// the slots, and each repository's base branch and gates. Read fresh on every
// request from the table, Animus's job files and each clone's profile, so
// Helix keeps nothing for it.
import { statSync } from 'node:fs';
import { hostname } from 'node:os';
import { join } from 'node:path';
import { listJobs, type JobFilter } from '../../plugin/display/job-list.ts';
import { PERSON_JOBS, type InsightsPage, type Display, type DisplayClosed, type DisplayPr, type JobListPage, type ListJob, type DisplayJob, type DisplayRepo, type JobPage, type PeoplePage, type PersonPage, type PersonRow } from '../../plugin/display/shape.ts';
import { folderParts, read, shotFile } from '../../plugin/src/job-folder.ts';
import { afterOf, fixRounds, insightsData, lessonsCiting } from '../../plugin/src/insights-data.ts';
import { animusHome, readRuns, STAGES } from '../../plugin/src/log.ts';
import { readOutcomes } from '../../plugin/src/outcomes.ts';
import { loadProfile, PROFILE_PATH } from '../../plugin/src/profile.ts';
import { readyRepos, type Config } from './config.ts';
import type { HelixJob, Person, Store } from './store.ts';
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

/** Each person's jobs' fix rounds from their run logs, by person and Animus job, for the jobs whose gates ran. */
function fixOf(opts: { store: Store; supervisor: Supervisor }): (j: HelixJob) => { fix_rounds?: number; fix_of_title?: string } {
  const rounds = new Map<string, number>();
  for (const person of Object.keys(opts.store.people())) {
    for (const [job, n] of fixRounds(readRuns(join(opts.supervisor.animusHome(person), 'runs.jsonl')))) rounds.set(`${person}\u0000${job}`, n);
  }
  return (j) => {
    const n = rounds.get(`${j.person}\u0000${j.animus_job}`);
    const title = j.fix_of === undefined ? undefined : opts.store.get(j.fix_of)?.title;
    return { ...(n === undefined ? {} : { fix_rounds: n }), ...(title ? { fix_of_title: title } : {}) };
  };
}

function jobOf(job: HelixJob, supervisor: Supervisor, fix: (j: HelixJob) => { fix_rounds?: number; fix_of_title?: string } = () => ({})): DisplayJob {
  const { spec: _spec, pid: _pid, answer, draft: _draft, interrupted: _interrupted, ...rest } = job;
  const shown = { ...rest, ...fix(job) };
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

/** The people list: each person on this Helix with their numbers, from the tables, read fresh. */
export function peoplePage(opts: { store: Store }): PeoplePage {
  const jobs = opts.store.list(-1);
  return { at: new Date().toISOString(), people: Object.entries(opts.store.people()).map(([name, p]) => rowOf(opts.store, jobs, name, p)) };
}

/** One person's numbers; `p` is missing for someone who has left. */
function rowOf(store: Store, jobs: HelixJob[], name: string, p?: Person): PersonRow {
  const mine = jobs.filter((j) => j.person === name);
  const last = store.activity(name, 1)[0];
  return {
    name, ...(p?.github ? { github: p.github } : {}), ...(p?.joined ? { joined: p.joined } : {}),
    jobs: mine.length, prs: mine.filter((j) => j.pr).length, spent: mine.reduce((sum, j) => sum + (j.cost_usd ?? 0), 0),
    ...(last ? { last: { at: last.at, kind: last.kind } } : {}),
  };
}

/**
 * One person's page, or nothing when Helix has never heard of them: their
 * numbers, their jobs from the table (so those from before activity was kept
 * show) newest first, the PERSON_JOBS before job `before`, and their activity.
 * Someone who left is still known by their jobs and activity.
 */
export function personPage(opts: { store: Store }, name: string, before = Infinity): PersonPage | undefined {
  const { store } = opts;
  const p = store.people()[name];
  const jobs = store.list(-1).reverse();
  const mine = jobs.filter((j) => j.person === name);
  const activity = store.activity(name);
  if (!p && !mine.length && !activity.length) return undefined;
  const older = mine.filter((j) => j.id < before);
  const gone = activity.find((a) => a.kind === 'left');
  const left = !p ? { ...(gone ? { at: gone.at } : {}) } : undefined;
  return {
    at: new Date().toISOString(), ...rowOf(store, jobs, name, p), ...(left ? { left } : {}),
    jobList: older.slice(0, PERSON_JOBS).map(({ id, title, repo, state, submitted, outcome, pr, cost_usd }) => ({ id, title, repo, state, submitted, ...(outcome ? { outcome } : {}), ...(pr ? { pr } : {}), ...(cost_usd !== undefined ? { cost_usd } : {}) })),
    more: older.length > PERSON_JOBS,
    activity: activity.map(({ at, kind, detail }) => ({ at, kind, ...(detail ? { detail } : {}) })),
  };
}

/**
 * What a job's page shows, or nothing when Helix has no such job: its row,
 * the spec Helix was sent, and what its Animus folder and run log say, read
 * fresh. It needs a token: the server sees to that.
 */
export function jobPage(opts: { store: Store; supervisor: Supervisor }, id: number, github: { prs: DisplayPr[]; closed: DisplayClosed[] } = { prs: [], closed: [] }): JobPage | undefined {
  const job = opts.store.get(id);
  if (!job) return undefined;
  const spec = read(job.spec);
  const open = github.prs.find((p) => p.job === id);
  const closed = github.closed.find((c) => c.job === id);
  const pr: Partial<JobPage> = open ? { pr_state: 'open', pr_opened: open.created } : closed ? { pr_state: closed.merged ? 'merged' : 'closed', ...(closed.merged ? { pr_merged: closed.at } : {}) } : {};
  const page: JobPage = { at: new Date().toISOString(), stages: STAGES, job: jobOf(job, opts.supervisor), ...pr, ...(spec !== undefined ? { spec } : {}), log: opts.supervisor.log(id, Infinity) };
  const dir = folderOf(opts.supervisor, job);
  if (!job.animus_job || !dir) return page;
  const home = opts.supervisor.animusHome(job.person);
  const runs = readRuns(join(home, 'runs.jsonl')).filter((r) => r.job === job.animus_job);
  let o;
  try { o = job.pr ? readOutcomes(join(home, 'outcomes.json'))[job.pr] : undefined; } catch { /* unreadable: no PR is known */ }
  const lessons = lessonsCiting(job.animus_job);
  return Object.assign(page, folderParts(dir, runs, job.answer), o ? { after: afterOf(o) } : {}, lessons.length ? { lessons } : {});
}

/** The job's Animus folder. Its Animus id comes from what the job printed: only a plain name is taken as a folder. */
function folderOf(supervisor: Supervisor, job: HelixJob): string | undefined {
  if (!job.animus_job || !/^[A-Za-z0-9][\w.-]*$/.test(job.animus_job)) return undefined;
  return join(supervisor.animusHome(job.person), 'jobs', job.animus_job);
}

/** One of a job's screenshots, or nothing (shotFile). It needs a token: the server sees to that. */
export function jobShot(opts: { store: Store; supervisor: Supervisor }, id: number, name: string): { type: string; body: Buffer } | undefined {
  const job = opts.store.get(id);
  const dir = job && folderOf(opts.supervisor, job);
  return dir ? shotFile(dir, name) : undefined;
}

/** The Insights page's data: the run logs and outcomes of Helix's own Animus home and of each person's, and Helix's lessons. */
export function insights(opts: { store: Store; supervisor: Supervisor }, scope: string): InsightsPage {
  return insightsData(scope, [animusHome(), ...Object.keys(opts.store.people()).map((p) => opts.supervisor.animusHome(p))], Date.now());
}

export function display(opts: { config: Config; store: Store; supervisor: Supervisor }): Display {
  const { config, store, supervisor } = opts;
  const fix = fixOf(opts);
  return {
    name: config.name ?? hostname(),
    at: new Date().toISOString(),
    slots: config.slots,
    stages: STAGES,
    repos: Object.entries(readyRepos(store)).map(([name, dir]) => repoOf(name, dir)),
    jobs: store.list(SHOWN).map((j) => jobOf(j, supervisor, fix)),
  };
}

/**
 * One page of the Jobs page: the whole table, filtered, thirty at a time. A
 * job's PR is open or merged or closed as GitHub last said (`prs`, `closed`);
 * one it has not answered about carries no state.
 */
export function jobList(opts: { store: Store; supervisor: Supervisor }, f: Partial<JobFilter>, before: string | undefined, github: { prs: DisplayPr[]; closed: DisplayClosed[] }): JobListPage {
  const open = new Set(github.prs.map((p) => p.job));
  const closed = new Map(github.closed.map((c) => [c.job, c]));
  const fix = fixOf(opts);
  const jobs = opts.store.list(-1).map((j): ListJob => {
    const c = closed.get(j.id);
    const state = open.has(j.id) ? 'open' as const : c ? c.merged ? 'merged' as const : 'closed' as const : undefined;
    return { ...jobOf(j, opts.supervisor, fix), ...(state ? { pr_state: state } : {}), ...(c?.merged && !open.has(j.id) ? { pr_merged: c.at } : {}) };
  });
  return { at: new Date().toISOString(), ...listJobs(jobs, f, before) };
}
