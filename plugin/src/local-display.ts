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
import { hostname } from 'node:os';
import { basename, join } from 'node:path';
import type { Display, DisplayJob, JobPage } from '../display/shape.ts';
import { asset, CSP } from './assets.ts';
import { folderParts, read, shotFile } from './job-folder.ts';
import { animusHome, jobDir, loadProgress, loadState, readRuns, STAGES, type Run } from './log.ts';

/** True for a live process; EPERM means it exists under another user. */
const alive = (pid: number): boolean => {
  try { process.kill(pid, 0); return true; } catch (e) { return (e as NodeJS.ErrnoException).code === 'EPERM'; }
};

/** Job folders are named by Animus; only a plain name is taken as one. */
const PLAIN = /^[A-Za-z0-9][\w.-]*$/;

/** The project of a job that has no state and no run row: it never got far enough to name one. */
const NO_PROJECT = 'unknown project';

function jobOf(id: string, runs: readonly Run[]): DisplayJob | undefined {
  const state = loadState(id);
  const progress = loadProgress(id);
  if (!state && !progress) return undefined;
  const mine = runs.filter((r) => r.job === id);
  const last = mine.at(-1);
  let title = last?.title;
  if (!title && state) { try { title = /^# (.+)$/m.exec(readFileSync(state.spec, 'utf8'))?.[1]; } catch { /* the job's copy is gone */ } }
  const running = !state?.outcome && progress?.host === hostname() && progress.pid !== undefined && alive(progress.pid);
  const submitted = mine[0]?.started ?? progress?.at ?? statSync(jobDir(id)).mtime.toISOString();
  return {
    id, person: last?.submitter ?? '', repo: state ? basename(state.repo) : last ? basename(last.repo) : NO_PROJECT, title: title ?? id, submitted,
    state: state?.outcome ? 'ended' : running ? 'running' : 'stopped',
    ...(last?.started ? { started: last.started } : {}), ...(last?.ended ? { ended: last.ended } : {}),
    ...(state?.outcome ? { outcome: state.outcome } : {}), ...(last?.pr ? { pr: last.pr } : {}),
    ...(last?.reason ? { reason: last.reason } : {}), ...(state?.question ? { question: state.question } : {}),
    ...(last ? { cost_usd: last.cost_usd } : {}),
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
  return {
    name: hostname(), at: new Date().toISOString(), local: true,
    // Nothing is queued on a laptop and nothing limits how many jobs run: the display shows no slots.
    slots: jobs.filter((j) => j.state === 'running').length, stages: STAGES,
    repos: [...new Set(jobs.map((j) => j.repo))].map((name) => ({ name })),
    jobs,
  };
}

/** One job's page, or nothing when this machine has no such job. Its log is empty: `animus run` prints to its own terminal and keeps none. */
export function localJobPage(id: string): JobPage | undefined {
  const runs = readRuns();
  const job = PLAIN.test(id) ? jobOf(id, runs) : undefined;
  if (!job) return undefined;
  const spec = read(loadState(id)?.spec ?? join(jobDir(id), 'spec.md'));
  return { at: new Date().toISOString(), stages: STAGES, job, ...(spec !== undefined ? { spec } : {}), log: '', ...folderParts(jobDir(id), runs.filter((r) => r.job === id)) };
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
    // /people/… is Helix's: the page is not served for it here.
    if (file && !url.pathname.startsWith('/people')) {
      res.writeHead(200, { 'content-type': file.type, 'cache-control': file.cache, 'content-security-policy': CSP, 'x-content-type-options': 'nosniff', vary: 'accept' });
      return res.end(file.body);
    }
    if (url.pathname === '/display') return send(200, localDisplay());
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
