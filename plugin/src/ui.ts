// UI jobs: which target a job shows on, its design references, and the
// screenshots a script takes as evidence (`animus shots`, `animus ui up|down`).
// Screenshots live in the job's folder under Animus's home, never in the repo.
// Adapted from orbit's plugin/src/ui.ts.
import { spawn, spawnSync } from 'node:child_process';
import { createHash } from 'node:crypto';
import { closeSync, copyFileSync, existsSync, mkdirSync, openSync, readdirSync, readFileSync, rmSync, statSync, writeFileSync } from 'node:fs';
import { createServer } from 'node:net';
import { extname, join } from 'node:path';
import { git, AnimusError } from './proc.ts';
import type { Profile, UiPage, UiTarget } from './profile.ts';

/** What a UI job shows: from the spec's `ui` and `design` header fields. */
export type UiJob = { id: string; target?: string; pages: string[]; designs: string[] };

const IMAGES = ['.png', '.jpg', '.jpeg', '.webp', '.gif'];
/** What a reference may be: an image or PDF, read as is; an HTML or SVG design, rendered at the target's sizes. */
const REFERENCES = [...IMAGES, '.pdf', '.svg', '.html', '.htm'];
const READY_MS = 180_000;

/** The job's target: the one its spec names, else the profile's only one. */
export function uiTarget(profile: Pick<Profile, 'ui'>, job: Pick<UiJob, 'target'>): UiTarget | undefined {
  const targets = profile.ui.targets;
  if (job.target) return targets.find((t) => t.name === job.target);
  return targets.length === 1 ? targets[0] : undefined;
}

/** A page the spec gives as a path rather than by a name in the profile. */
export const isLiteralPage = (page: string) => page.startsWith('/');

/** The pages a job shows: those it names (a name from the profile, or a path, shown as named from the path), else all of the target's. */
export function pagesOf(target: UiTarget, job: Pick<UiJob, 'pages'>): UiPage[] {
  if (!job.pages.length) return target.pages;
  return job.pages.flatMap((p) => (isLiteralPage(p) ? [{ name: slug(p), path: p }] : target.pages.filter((x) => x.name === p)));
}

/** Why a UI job cannot be shown with this profile, if it cannot. */
export function uiProblem(profile: Pick<Profile, 'ui'>, job: UiJob): string | undefined {
  const names = profile.ui.targets.map((t) => t.name);
  const target = uiTarget(profile, job);
  if (!target) {
    if (!names.length) return 'a ui spec needs a ui target in .animus/animus.yaml (ui.targets), and the profile has none';
    return job.target ? `ui.target ${job.target} is not a ui target in .animus/animus.yaml (${names.join(', ')})` : `the profile has several ui targets (${names.join(', ')}): name one in the spec header, ui: { target: <name> }`;
  }
  const unknown = job.pages.filter((p) => !isLiteralPage(p) && !target.pages.some((x) => x.name === p));
  return unknown.length ? `${unknown.join(', ')} is not a page of ui target ${target.name} (${target.pages.map((p) => p.name).join(', ')})` : undefined;
}

export type Design = { status: 'given' | 'missing'; files: string[] };

/** A UI job's design references, repo-relative: the spec's own; else its pages' references; else the target's. Folders are listed. */
export function designOf(repo: string, profile: Pick<Profile, 'ui'>, job: UiJob): Design {
  const target = uiTarget(profile, job);
  const pages = target ? pagesOf(target, job) : [];
  const named = job.designs.length ? job.designs : pages.flatMap((p) => (p.reference ? [p.reference] : []));
  const paths = named.length ? named : target?.references ?? [];
  const files = paths.flatMap((p) => expand(repo, p));
  return { status: files.length ? 'given' : 'missing', files };
}

function expand(repo: string, path: string): string[] {
  const full = join(repo, path);
  if (!existsSync(full)) return [];
  if (!statSync(full).isDirectory()) return REFERENCES.includes(extname(full).toLowerCase()) ? [path] : [];
  return readdirSync(full, { recursive: true }).map(String).sort()
    .filter((f) => REFERENCES.includes(extname(f).toLowerCase()))
    .map((f) => join(path, f));
}

// ------------------------------------------------------------- serving

type Up = { pid: number; port: number; url?: string; log: string };

const UP_FILE = 'animus-ui.json';
const upFile = (cwd: string) => join(git(cwd, ['rev-parse', '--absolute-git-dir']), UP_FILE);
const fill = (s: string, port: number) => s.replaceAll('$PORT', String(port)).replaceAll('${PORT}', String(port));

function freePort(): Promise<number> {
  return new Promise((done, fail) => {
    const srv = createServer();
    srv.once('error', fail);
    srv.listen(0, '127.0.0.1', () => {
      const port = (srv.address() as { port: number }).port;
      srv.close(() => done(port));
    });
  });
}

const sleep = (ms: number) => new Promise((r) => setTimeout(r, ms));

async function answers(url: string): Promise<boolean> {
  try {
    const res = await fetch(url, { signal: AbortSignal.timeout(5_000) });
    return res.status < 500;
  } catch {
    return false;
  }
}

function running(pid: number): boolean {
  try {
    process.kill(pid, 0);
    return true;
  } catch {
    return false;
  }
}

/** The target as `animus ui up` left it in this worktree, if it still runs. */
export function upState(cwd: string): Up | undefined {
  const file = upFile(cwd);
  if (!existsSync(file)) return undefined;
  const up = JSON.parse(readFileSync(file, 'utf8')) as Up;
  return running(up.pid) ? up : undefined;
}

/**
 * Starts the target's serve command in this worktree on a free port, waits
 * until it is ready, and leaves it running. Returns where it is. A target
 * already up is reused.
 */
export async function uiUp(cwd: string, target: UiTarget): Promise<Up> {
  const already = upState(cwd);
  if (already) return already;
  const port = await freePort();
  const url = target.url ? fill(target.url, port) : undefined;
  const log = join(git(cwd, ['rev-parse', '--absolute-git-dir']), 'animus-ui.log');
  let pid = 0;
  if (target.serve) {
    const fd = openSync(log, 'w');
    const child = spawn('/bin/sh', ['-c', target.serve], { cwd, detached: true, stdio: ['ignore', fd, fd], env: { ...process.env, PORT: String(port) } });
    closeSync(fd);
    child.unref();
    pid = child.pid ?? 0;
    if (pid) watchJob(pid, upFile(cwd));
  }
  const up: Up = { pid, port, log, ...(url ? { url } : {}) };
  writeFileSync(upFile(cwd), JSON.stringify(up));
  const deadline = Date.now() + READY_MS;
  for (;;) {
    const ready = target.ready
      ? spawnSync('/bin/sh', ['-c', target.ready], { cwd, env: { ...process.env, PORT: String(port), ANIMUS_URL: url ?? '' }, timeout: 30_000 }).status === 0
      : url ? await answers(url) : true;
    if (ready) return up;
    if (pid && !running(pid)) {
      uiDown(cwd);
      throw new AnimusError(`${target.name}'s serve command exited before it was ready:\n${tail(log)}`);
    }
    if (Date.now() > deadline) {
      uiDown(cwd);
      throw new AnimusError(`${target.name} was not ready within ${READY_MS / 1000}s${url ? ` at ${url}` : ''}:\n${tail(log)}`);
    }
    await sleep(1_000);
  }
}

/** The process a job runs in: set by the pipeline, so what a job's sessions start knows whose it is. */
export const JOB_PID = 'ANIMUS_JOB_PID';
const WATCH_MS = 2_000;

/**
 * The serve command runs in a process group of its own, so killing the job's
 * (Helix cancelling it, Ctrl-C, a crash) leaves it running. While a job's
 * process is named, a small watcher outlives this one and stops the target
 * once the job's process is gone; it ends by itself when the target does.
 * Outside a job (a person's own `animus ui up`) nothing watches.
 */
function watchJob(serverPid: number, file: string): void {
  const job = Number(process.env[JOB_PID]);
  if (!Number.isInteger(job) || job <= 0) return;
  const script = `
    const [job, server, file] = [Number(process.argv[1]), Number(process.argv[2]), process.argv[3]];
    const alive = (pid) => { try { process.kill(pid, 0); return true; } catch (e) { return e.code === 'EPERM'; } };
    const tick = () => {
      if (!alive(server)) process.exit(0);
      if (alive(job)) return;
      try { process.kill(-server, 'SIGTERM'); } catch { try { process.kill(server, 'SIGTERM'); } catch {} }
      try { if (JSON.parse(require('node:fs').readFileSync(file, 'utf8')).pid === server) require('node:fs').rmSync(file); } catch {}
      process.exit(0);
    };
    setInterval(tick, ${WATCH_MS});`;
  try {
    spawn(process.execPath, ['-e', script, String(job), String(serverPid), file], { detached: true, stdio: 'ignore' }).on('error', () => {}).unref();
  } catch { /* the job's own ending stops the target as before */ }
}

/** Stops what `animus ui up` started in this worktree. */
export function uiDown(cwd: string): boolean {
  const file = upFile(cwd);
  if (!existsSync(file)) return false;
  const up = JSON.parse(readFileSync(file, 'utf8')) as Up;
  rmSync(file, { force: true });
  if (!up.pid || !running(up.pid)) return false;
  try { process.kill(-up.pid, 'SIGTERM'); } catch { try { process.kill(up.pid, 'SIGTERM'); } catch { /* gone */ } }
  return true;
}

function tail(file: string): string {
  try { return readFileSync(file, 'utf8').trimEnd().split('\n').slice(-15).map((l) => l.slice(0, 300)).join('\n'); } catch { return ''; }
}

// ------------------------------------------------------------- screenshots

export type Shots = {
  job: string;
  target: string;
  /** The worktree's content when they were taken: the stop hook compares it with what is committed. */
  tree: string;
  at: string;
  /** Paths under the shots folder. */
  build: string[];
  reference: string[];
  design: Design['status'];
};

export function readShots(dir: string): Shots | undefined {
  try { return JSON.parse(readFileSync(join(dir, 'manifest.json'), 'utf8')) as Shots; } catch { return undefined; }
}

/**
 * The tree the worktree would commit now, tracked and untracked files alike
 * (ignored ones left out), through a scratch index: nothing of the agent's
 * changes.
 */
export function workTree(cwd: string): string {
  const index = join(git(cwd, ['rev-parse', '--absolute-git-dir']), 'animus-shots-index');
  const env = { ...process.env, GIT_INDEX_FILE: index };
  const run = (args: string[]) => {
    const r = spawnSync('git', args, { cwd, env, encoding: 'utf8' });
    if (r.status !== 0) throw new AnimusError(`git ${args.join(' ')}: ${r.stderr.trim()}`);
    return r.stdout.trim();
  };
  try {
    run(['read-tree', 'HEAD']);
    run(['add', '-A']);
    return run(['write-tree']);
  } finally {
    rmSync(index, { force: true });
  }
}

/** agent-browser, as the person's rules ask; ANIMUS_BROWSER replaces it (tests). */
function browser(session: string, args: string[], cwd: string): string {
  const cmd = process.env.ANIMUS_BROWSER ?? 'npx agent-browser';
  const r = spawnSync('/bin/sh', ['-c', `${cmd} --session ${session} ${args.map(quote).join(' ')}`], { cwd, encoding: 'utf8', timeout: 120_000 });
  if (r.status !== 0) throw new AnimusError(`agent-browser ${args[0]} failed: ${`${r.stdout}${r.stderr}`.trim().split('\n').slice(-5).join('\n')}`);
  return r.stdout;
}

const quote = (s: string) => `'${s.replaceAll("'", "'\\''")}'`;
const slug = (s: string) => s.replace(/[^\w.-]+/g, '-').replace(/^-|-$/g, '') || 'page';

/** A page taller than this many windows is shot only that far down. */
const MAX_PARTS = 8;

/**
 * Screenshots of a web page at each viewport, one window high each: a page
 * taller than the window comes in parts from the top (`@390x844-2`), since a
 * full-height image is too tall to read in detail and agents cut it up with
 * whatever image tools they find.
 */
function webShots(session: string, url: string, sizes: UiTarget['viewports'], out: (size: string) => string, cwd: string): void {
  browser(session, ['open', url], cwd);
  for (const v of sizes) {
    browser(session, ['set', 'viewport', String(v.w), String(v.h)], cwd);
    browser(session, ['wait', '800'], cwd);
    const height = Number.parseInt(browser(session, ['eval', 'document.documentElement.scrollHeight'], cwd).trim().split('\n').at(-1) ?? '', 10);
    const parts = Number.isFinite(height) ? Math.min(MAX_PARTS, Math.max(1, Math.ceil(height / v.h))) : 1;
    for (let i = 0; i < parts; i++) {
      if (i) {
        browser(session, ['eval', `window.scrollTo(0, ${i * v.h})`], cwd);
        browser(session, ['wait', '200'], cwd);
      }
      browser(session, ['screenshot', out(`${v.w}x${v.h}${parts > 1 ? `-${i + 1}` : ''}`)], cwd);
    }
  }
}

/**
 * `animus shots`: serves the job's target (unless `animus ui up` already
 * did), screenshots each of its pages at each size, puts the design
 * references beside them (HTML and SVG designs rendered at the same sizes),
 * and records which worktree content they show. Reuses the last set when the
 * worktree has not changed since, unless again.
 */
export async function takeShots(cwd: string, job: UiJob, profile: Profile, dir: string, opts: { again?: boolean } = {}): Promise<{ shots: Shots; dir: string; reused: boolean }> {
  const target = uiTarget(profile, job);
  if (!target) throw new AnimusError(uiProblem(profile, job) ?? `${job.id} has no ui target`);
  const tree = workTree(cwd);
  const last = readShots(dir);
  if (!opts.again && last && last.tree === tree && last.build.every((f) => existsSync(join(dir, f)))) return { shots: last, dir, reused: true };

  const design = designOf(cwd, profile, job);
  const buildDir = join(dir, 'build');
  rmSync(buildDir, { recursive: true, force: true });
  mkdirSync(buildDir, { recursive: true });
  const pages = pagesOf(target, job);
  const session = `animus-${slug(job.id)}-${process.pid}`;
  const wasUp = upState(cwd);
  const up = await uiUp(cwd, target);
  try {
    if (target.kind === 'web') {
      for (const p of pages) webShots(session, new URL(p.path, up.url).toString(), target.viewports, (size) => join(buildDir, `${slug(p.name)}@${size}.png`), cwd);
    } else {
      const r = spawnSync('/bin/sh', ['-c', target.capture!], {
        cwd, encoding: 'utf8', timeout: 600_000,
        env: { ...process.env, PORT: String(up.port), ANIMUS_URL: up.url ?? '', ANIMUS_SHOTS: buildDir, ANIMUS_JOB: job.id, ANIMUS_PAGES: pages.map((p) => p.name).join(',') },
      });
      if (r.status !== 0) throw new AnimusError(`${target.name}'s capture command failed:\n${`${r.stdout}${r.stderr}`.trim().split('\n').slice(-15).join('\n')}`);
    }
  } finally {
    if (target.kind === 'web') try { browser(session, ['close'], cwd); } catch { /* already closed */ }
    if (!wasUp) uiDown(cwd);
  }
  const build = images(buildDir).map((f) => `build/${f}`);
  if (!build.length) throw new AnimusError(`no screenshots came out for ${target.name}${target.kind === 'app' ? ' (the capture command must write PNGs into $ANIMUS_SHOTS)' : ''}`);
  const reference = references(cwd, dir, design.files, target, session);
  const shots: Shots = { job: job.id, target: target.name, tree, at: new Date().toISOString(), build, reference, design: design.status };
  writeFileSync(join(dir, 'manifest.json'), `${JSON.stringify(shots, null, 2)}\n`);
  return { shots, dir, reused: false };
}

function images(dir: string): string[] {
  return existsSync(dir) ? readdirSync(dir).filter((f) => IMAGES.includes(extname(f).toLowerCase())).sort() : [];
}

/** Copies the references beside the build, rendering HTML and SVG ones; skips what has not changed. */
function references(cwd: string, dir: string, files: readonly string[], target: UiTarget, session: string): string[] {
  const out = join(dir, 'reference');
  mkdirSync(out, { recursive: true });
  const stampFile = join(out, '.sources.json');
  let stamps: Record<string, string> = {};
  try { stamps = JSON.parse(readFileSync(stampFile, 'utf8')) as Record<string, string>; } catch { /* first time */ }
  const kept: string[] = [];
  const next: Record<string, string> = {};
  const sizes = target.viewports.length ? target.viewports : [{ w: 1280, h: 800 }, { w: 390, h: 844 }];
  let opened = false;
  try {
    for (const f of files) {
      const hash = createHash('sha1').update(readFileSync(join(cwd, f))).digest('hex');
      const name = slug(f.replace(/\.[^.]+$/, ''));
      const ext = extname(f).toLowerCase();
      const made = ['.html', '.htm', '.svg'].includes(ext)
        ? sizes.map((v) => `${name}@${v.w}x${v.h}.png`)
        : [`${name}${ext}`];
      next[f] = hash;
      if (stamps[f] !== hash || !made.every((m) => existsSync(join(out, m)))) {
        if (made.length === 1 && !['.html', '.htm', '.svg'].includes(ext)) copyFileSync(join(cwd, f), join(out, made[0]!));
        else {
          opened = true;
          webShots(`${session}-ref`, `file://${join(cwd, f)}`, sizes, (size) => join(out, `${name}@${size}.png`), cwd);
        }
      }
      kept.push(...made.map((m) => `reference/${m}`));
    }
  } finally {
    if (opened) try { browser(`${session}-ref`, ['close'], cwd); } catch { /* already closed */ }
  }
  writeFileSync(stampFile, JSON.stringify(next));
  for (const f of readdirSync(out)) if (f !== '.sources.json' && !kept.includes(`reference/${f}`)) rmSync(join(out, f), { force: true });
  return kept;
}

/** What `animus shots` prints: each screenshot beside its references, as paths to Read. */
export function describeShots(dir: string, shots: Shots, reused: boolean): string {
  const lines = [`${reused ? 'Your work has not changed since these screenshots' : 'Screenshots of your work'} (${shots.target}), one window high; a taller page comes in numbered parts from the top. Read each image:`];
  for (const f of shots.build) lines.push(`  ${join(dir, f)}`);
  if (shots.reference.length) {
    lines.push('', 'The design to match. Read each and compare it with the screenshot of the same page and size; every visible difference is work left:');
    for (const f of shots.reference) lines.push(`  ${join(dir, f)}`);
  } else {
    lines.push('', 'No design reference was given. Judge the screenshots yourself: consistent with the rest of the app, readable at every size, nothing cut off, overlapping or misaligned, every state the spec names.');
  }
  return lines.join('\n');
}
