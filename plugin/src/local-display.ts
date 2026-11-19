// The local display (`animus ui`): the display page (plugin/display) fed from
// this machine's Animus home instead of Helix (ADR 0004). It reads every job
// folder and the run log and answers the shapes Helix's display does. A job
// has an outcome once its state says so; without one it is running only if
// the process that wrote its progress is alive on this machine, and stopped
// otherwise. Served on 127.0.0.1 only, with no sign-in: whoever reaches this
// machine's loopback is the person whose jobs these are, and there are no
// people pages.
import { createServer, type Server } from 'node:http';
import { readdirSync, readFileSync, statSync } from 'node:fs';
import type { AddressInfo } from 'node:net';
import { hostname, userInfo } from 'node:os';
import { basename, join } from 'node:path';
import { listJobs, RESULTS, type JobFilter, type Result } from '../display/job-list.ts';
import type { Display, DisplayJob, JobListPage, JobPage, ListJob, PrState } from '../display/shape.ts';
import { asset, CSP } from './assets.ts';
import { afterOf, fixRounds, insightsData, lessonsCiting } from './insights-data.ts';
import { folderParts, read, shotFile } from './job-folder.ts';
import { readOutcomes, type Outcomes } from './outcomes.ts';
import { tryGit } from './proc.ts';
import { alive, animusHome, jobDir, loadProgress, loadState, readRuns, STAGES, type Run } from './log.ts';

/** Job folders are named by Animus; only a plain name is taken as one. */
const PLAIN = /^[A-Za-z0-9][\w.-]*$/;

/** The project of a job that has no state and no run row: it never got far enough to name one. */
const NO_PROJECT = 'unknown project';

/** A person's name from their address: what is before the @. */
const nameOf = (submitter: string): string => submitter.split('@')[0]!;

/** Who runs a job here, by name: the repository's git user, else the user's login. */
const runnerOf = (repo: string): string => tryGit(repo, ['config', 'user.name']) ?? nameOf(tryGit(repo, ['config', 'user.email']) ?? userInfo().username);

function jobOf(id: string, runs: readonly Run[]): DisplayJob | undefined {
  const state = loadState(id);
  const progress = loadProgress(id);
  if (!state && !progress) return undefined;
  const mine = runs.filter((r) => r.job === id);
  const last = mine.at(-1);
  const fix = fixRounds(mine);
  const fixOf = last?.fix_of ?? state?.fix_of;
  const fixTitle = fixOf ? runs.findLast((r) => r.job === fixOf)?.title : undefined;
  let title = last?.title;
  if (!title && state) { try { title = /^# (.+)$/m.exec(readFileSync(state.spec, 'utf8'))?.[1]; } catch { /* the job's copy is gone */ } }
  const running = !state?.outcome && progress?.host === hostname() && progress.pid !== undefined && alive(progress.pid);
  const submitted = mine[0]?.started ?? progress?.at ?? statSync(jobDir(id)).mtime.toISOString();
  // A running job has no run row yet: its person is the repo's git user, and it started when its first run did, else when its folder was made.
  const person = last ? (last.submitter_name ?? nameOf(last.submitter)) : running && state ? runnerOf(state.repo) : '';
  const started = last?.started ?? (running ? mine[0]?.started ?? statSync(jobDir(id)).birthtime.toISOString() : undefined);
  return {
    id, person, repo: state ? basename(state.repo) : last ? basename(last.repo) : NO_PROJECT, title: title ?? id, submitted,
    state: state?.outcome ? 'ended' : running ? 'running' : 'stopped',
    ...(started ? { started } : {}), ...(last?.ended ? { ended: last.ended } : {}),
    ...(state?.outcome ? { outcome: state.outcome } : {}), ...(last?.pr ? { pr: last.pr } : {}),
    ...(last?.reason ? { reason: last.reason } : {}), ...(state?.question ? { question: state.question } : {}),
    ...(last ? { cost_usd: last.cost_usd } : {}),
    ...(fixOf ? { fix_of: fixOf, ...(fixTitle ? { fix_of_title: fixTitle } : {}) } : {}),
    ...(fix.has(id) ? { fix_rounds: fix.get(id)! } : {}),
    ...(running && progress ? { progress } : {}),
    // `animus resume` needs state.json, which is saved only after the worktree is made.
    ...(!state?.outcome && !running ? state ? { resume: `animus resume ${id}` } : { reason: 'It stopped during setup, before it had a worktree, so there is nothing to resume. Run its spec again.' } : {}),
  };
}

/** Every job this machine's Animus has a folder for, newest first. */
export function localJobs(): DisplayJob[] {
  let names: string[] = [];
  try { names = readdirSync(join(animusHome(), 'jobs')); } catch { /* no jobs yet */ }
  const runs = readRuns();
  return names.filter((n) => PLAIN.test(n)).flatMap((id) => jobOf(id, runs) ?? []).sort((a, b) => (a.submitted < b.submitted ? 1 : -1));
}

/** What the overview shows: the jobs, and a project for each repository they ran in. */
export function localDisplay(): Display {
  const jobs = localJobs();
  let outcomes: Outcomes = {};
  try { outcomes = readOutcomes(); } catch { /* unreadable: no PR is known */ }
  // A PR outcomes.json saw merge or close, in the shape Helix sends from GitHub.
  const closed = jobs.flatMap((j) => {
    const o = j.pr ? outcomes[j.pr] : undefined;
    const n = Number(/(\d+)\/?$/.exec(j.pr ?? '')?.[1]);
    return o && o.state !== 'OPEN' && n ? [{ job: j.id, number: n, merged: o.state === 'MERGED', at: o.closed ?? o.checked }] : [];
  });
  // A delivered PR is open unless outcomes.json lists it closed.
  const prs = jobs.flatMap((j) => {
    const n = Number(/(\d+)\/?$/.exec(j.pr ?? '')?.[1]);
    const state = j.pr ? outcomes[j.pr]?.state : undefined;
    return j.state === 'ended' && j.pr && n && (j.outcome === 'pr' || j.outcome === 'draft-pr') && (!state || state === 'OPEN')
      ? [{ job: j.id, repo: j.repo, person: j.person, number: n, title: j.title, url: j.pr, draft: j.outcome === 'draft-pr', created: j.ended ?? j.submitted }] : [];
  });
  return {
    name: hostname(), at: new Date().toISOString(), local: true,
    // Nothing is queued on a laptop and nothing limits how many jobs run: the display shows no slots.
    slots: jobs.filter((j) => j.state === 'running').length, stages: STAGES,
    repos: [...new Set(jobs.map((j) => j.repo))].map((name) => ({ name })),
    jobs, ...(prs.length ? { prs } : {}), ...(closed.length ? { closed } : {}),
  };
}

/** The Jobs page's data: this machine's jobs, filtered; a PR is merged or closed where `outcomes.json` knows it, and open only when it says so. */
export function localJobList(f: Partial<JobFilter>, before?: string): JobListPage {
  let outcomes: Outcomes = {};
  try { outcomes = readOutcomes(); } catch { /* unreadable: no PR is known */ }
  const jobs = localJobs().map((j): ListJob => {
    const o = j.pr ? outcomes[j.pr] : undefined;
    return o ? { ...j, pr_state: o.state.toLowerCase() as PrState, ...(o.state === 'MERGED' ? { pr_merged: o.closed ?? o.checked } : {}) } : j;
  });
  return { at: new Date().toISOString(), ...listJobs(jobs, { ...f, person: '' }, before) };
}

/** One job's page, or nothing when this machine has no such job. Its log is empty: `animus run` prints to its own terminal and keeps none. */
export function localJobPage(id: string): JobPage | undefined {
  const runs = readRuns();
  const job = PLAIN.test(id) ? jobOf(id, runs) : undefined;
  if (!job) return undefined;
  const spec = read(loadState(id)?.spec ?? join(jobDir(id), 'spec.md'));
  let outcomes: Outcomes = {};
  try { outcomes = readOutcomes(); } catch { /* unreadable: no PR is known */ }
  const o = job.pr ? outcomes[job.pr] : undefined;
  const pr: Partial<JobPage> = o ? { pr_state: o.state.toLowerCase() as PrState, pr_opened: o.opened, ...(o.state === 'MERGED' ? { pr_merged: o.closed ?? o.checked } : {}) } : {};
  const lessons = lessonsCiting(id);
  return { at: new Date().toISOString(), stages: STAGES, job, ...pr, ...(o ? { after: afterOf(o) } : {}), ...(lessons.length ? { lessons } : {}), ...(spec !== undefined ? { spec } : {}), log: '', ...folderParts(jobDir(id), runs.filter((r) => r.job === id)) };
}

/** Listens on the first free port from `port` up, on 127.0.0.1 only. */
export function listenLocal(server: Server, port: number): Promise<number> {
  return new Promise((resolve, reject) => {
    const attempt = (p: number) => {
      server.once('error', (err: NodeJS.ErrnoException) => (err.code === 'EADDRINUSE' && p < 65535 ? attempt(p + 1) : reject(err)));
      server.listen(p, '127.0.0.1', () => { server.removeAllListeners('error'); resolve((server.address() as AddressInfo).port); });
    };
    attempt(port);
  });
}

/** The local display's server, not yet listening. */
export function localServer(): Server {
  return createServer((req, res) => {
    const send = (status: number, value: unknown) => { res.writeHead(status, { 'content-type': 'application/json' }); res.end(`${JSON.stringify(value)}\n`); };
    // A page on another site could point its own name at 127.0.0.1 and read these jobs: only this machine's own names are answered.
    if (!/^(127\.0\.0\.1|localhost)(:\d+)?$/.test(req.headers.host ?? '') || req.method !== 'GET') return send(403, { error: 'this display answers GET requests for 127.0.0.1 only' });
    const url = new URL(req.url ?? '/', 'http://localhost');
    const file = asset(url.pathname, req.headers.accept);
    if (file) {
      res.writeHead(200, { 'content-type': file.type, 'cache-control': file.cache, 'content-security-policy': CSP, 'x-content-type-options': 'nosniff', vary: 'accept' });
      return res.end(file.body);
    }
    if (url.pathname === '/display') return send(200, localDisplay());
    if (url.pathname === '/insights-data') return send(200, insightsData(url.searchParams.get('scope') || 'factory', [animusHome()], Date.now()));
    if (url.pathname === '/job-list') {
      const result = url.searchParams.get('result') ?? 'all';
      if (!RESULTS.includes(result as Result)) return send(400, { error: `result is one of ${RESULTS.join(', ')}` });
      return send(200, localJobList({ result: result as Result, project: url.searchParams.get('project') ?? '' }, url.searchParams.get('before') ?? undefined));
    }
    const [, root, id, action, ...rest] = url.pathname.split('/');
    let name = '';
    try { name = decodeURIComponent(id ?? ''); } catch { /* does not decode: no such job */ }
    if (root === 'jobs' && action === 'page-data' && !rest.length) {
      const page = localJobPage(name);
      return page ? send(200, page) : send(404, { error: `no job ${name}` });
    }
    if (root === 'jobs' && action === 'shots' && rest.length && PLAIN.test(name)) {
      let shot: string | undefined;
      try { shot = decodeURIComponent(rest.join('/')); } catch { /* does not decode: no such screenshot */ }
      const image = shot === undefined ? undefined : shotFile(jobDir(name), shot);
      if (image) { res.writeHead(200, { 'content-type': image.type, 'cache-control': 'private, no-cache', 'x-content-type-options': 'nosniff' }); return res.end(image.body); }
    }
    return send(404, { error: `nothing at ${url.pathname}` });
  });
}
