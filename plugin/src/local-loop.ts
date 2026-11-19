// The loop on this machine: the plugin's queue (queue.ts) with this machine's
// jobs. It starts each job the queue says fits as its own `animus run` process,
// resumes what was running when a loop before it stopped, and exits once
// nothing is queued, waiting or running. What it spawns, how long it sleeps and
// what the machine reads are passed in, so tests drive it with fakes.
import { spawn, type ChildProcess } from 'node:child_process';
import { appendFileSync, existsSync, mkdirSync, readFileSync } from 'node:fs';
import { dirname, join } from 'node:path';
import { animusHome } from './log.ts';
import { PLUGIN_ROOT } from './profiles.ts';
import { earlierOf } from './after.ts';
import { findPrByTitle, prState } from './pr.ts';
import { createQueue, type Earlier, type Queue } from './queue.ts';
import { newerThan, type LocalJob, type LocalQueue } from './local-queue.ts';
import type { Reading, Room } from './room.ts';

/** What `animus` is asked to do for a job: run it, or resume one that ran before. */
export const animusArgs = (job: LocalJob): string[] => {
  if (job.animus_job) return ['resume', job.animus_job, ...(job.answer ? ['--answer', job.answer] : [])];
  // Its earlier pull requests merged before it was queued: animus run does not look for them again.
  return ['run', job.spec, '--repo', job.repo, ...(job.after?.length ? ['--after-merged'] : []), ...job.flags];
};

/** Where a job's output goes: the queue's own folder for it, since Animus's job folder is only made once the run says its id. */
export const logFile = (id: number, home = animusHome()) => join(home, 'queue', String(id), 'log.txt');

/** Ends a job's process tree: the whole group where there is one. */
export function kill(pid: number, child?: ChildProcess): void {
  try {
    if (process.platform !== 'win32') process.kill(-pid, 'SIGTERM');
    else if (child) child.kill();
    else process.kill(pid);
  } catch { /* already gone */ }
}

type Launch = (command: string, args: string[], opts: { cwd: string }) => ChildProcess;

const launchAnimus: Launch = (command, args, { cwd }) => spawn(command, args, { cwd, env: process.env, detached: process.platform !== 'win32', windowsHide: true, stdio: ['ignore', 'pipe', 'pipe'] });

export type LoopOptions = {
  queue: LocalQueue;
  /** The release this loop is, kept in the lock. */
  version: string;
  /** What runs a job's process; `spawn` by default. */
  launch?: Launch;
  /** Slots and the room check's settings. */
  config?: Room & { slots: number };
  /** Where a waiting job's earlier pull requests stand; GitHub's, through gh, by default. */
  earlier?: (job: LocalJob) => Promise<Earlier>;
  /** Looks at waiting jobs every this many looks at the queue: about each minute by default. */
  pollEvery?: number;
  machine?: () => Reading;
  /** Waits between looks at the queue; a timer by default. */
  sleep?: (ms: number) => Promise<void>;
  say?: (line: string) => void;
  home?: string;
  /** The process this loop is, kept in the lock; this process by default. */
  pid?: number;
};

const LOOK_MS = 2000;
const POLL_LOOKS = 30;

/**
 * Runs the loop until nothing is left, and returns `done`; `held` when another loop has the lock and this one did nothing.
 */
export async function runLoop(opts: LoopOptions): Promise<'done' | 'held'> {
  const { queue: store } = opts;
  const launch = opts.launch ?? launchAnimus;
  const say = opts.say ?? (() => {});
  const sleep = opts.sleep ?? ((ms: number) => new Promise<void>((done) => { setTimeout(done, ms); }));
  const home = opts.home ?? animusHome();
  const children = new Map<number, ChildProcess>();
  const now = () => new Date().toISOString();
  const pid = opts.pid ?? process.pid;
  // Names only: the lock says what this loop runs with, so `animus doctor` can say what a later shell has that it lacks.
  const env = Object.keys(process.env);
  while (!store.claim(opts.version, pid, env)) {
    const holder = store.loop();
    // A loop of the same or a newer release has the lock: this one has nothing to do.
    if (holder && !newerThan(opts.version, holder.version)) return 'held';
    // An older one: it starts nothing more and leaves once its running jobs end (as `helix upgrade` waits for Helix's); then this one takes over.
    if (holder && store.drain()) say(`waiting for the loop of ${holder.version} to finish its running jobs`);
    await sleep(LOOK_MS);
  }

  /** Starts a job's process; false when the job ended without one. */
  function start(job: LocalJob): boolean {
    const log = logFile(job.id, home);
    mkdirSync(dirname(log), { recursive: true });
    let child: ChildProcess;
    try {
      child = launch(process.execPath, ['--disable-warning=ExperimentalWarning', join(PLUGIN_ROOT, 'src', 'cli.ts'), ...animusArgs(job)], { cwd: job.repo });
    } catch (err) {
      store.save({ ...job, state: 'ended', ended: now(), outcome: 'failed', reason: `could not start: ${(err as Error).message}` });
      return false;
    }
    children.set(job.id, child);
    const { answer: _used, ...rest } = job;
    let running: LocalJob = { ...rest, state: 'running', started: now(), ...(child.pid ? { pid: child.pid } : {}) };
    store.save(running);
    say(`job ${job.id} started: ${job.title}`);

    let out = '';
    child.stdout!.on('data', (chunk: Buffer) => { out += chunk.toString(); });
    child.stderr!.on('data', (chunk: Buffer) => {
      const text = chunk.toString();
      appendFileSync(log, text);
      const id = /^job (\S+): /m.exec(text)?.[1];
      if (id && !running.animus_job) {
        running = { ...running, animus_job: id };
        // Saved onto what the table says now: a job cancelled before this line came stays cancelled.
        const current = store.get(job.id);
        if (current?.state === 'running') store.save({ ...current, animus_job: id });
      }
    });
    const end = (fallback: string) => {
      if (!children.delete(job.id)) return;
      const current = store.get(job.id);
      // Cancelled meanwhile: what the table says stands.
      if (current?.state === 'running') {
        let result: { outcome?: string; pr?: string; reason?: string; question?: string; cost_usd?: number } = {};
        try { result = JSON.parse(out) as typeof result; } catch { /* it died before it could say */ }
        const { pid: _pid, ...kept } = current;
        store.save({
          ...kept, state: 'ended', ended: now(), outcome: result.outcome ?? 'failed',
          ...(result.pr ? { pr: result.pr } : {}), ...(result.question ? { question: result.question } : {}), ...(result.cost_usd !== undefined ? { cost_usd: result.cost_usd } : {}),
          ...(result.reason ?? (result.outcome ? undefined : fallback) ? { reason: result.reason ?? fallback } : {}),
        });
        say(`job ${job.id} ended: ${result.outcome ?? 'failed'}${result.pr ? ` ${result.pr}` : ''}`);
      }
      queue.release(job.id);
    };
    child.on('error', (err) => end(`could not start: ${err.message}`));
    child.on('close', (code, signal) => {
      // Animus says why on its last line when it refuses to start a job.
      const last = existsSync(log) ? readFileSync(log, 'utf8').trimEnd().split('\n').pop() : undefined;
      end(`animus ended with ${signal ?? `exit ${code}`} and no result${last ? `: ${last.replace(/^animus: /, '')}` : ''}`);
    });
    return true;
  }

  const queue: Queue<LocalJob> = createQueue<LocalJob>({
    store, config: { slots: 2, ...opts.config }, name: 'the loop', say, start, paused: store.draining,
    earlier: opts.earlier ?? (async (job) => earlierOf({ repo: job.repo, files: job.after ?? [], lookup: prState, find: findPrByTitle })),
    end: (job) => store.save(job),
    ...(opts.machine ? { machine: opts.machine } : {}),
    kill(job) {
      const child = children.get(job.id);
      const pid = child?.pid ?? job.pid;
      if (pid) kill(pid, child);
    },
  });
  // What the table calls running has no loop: queue it again, to resume.
  queue.begin();
  for (let looks = 0; ; looks += 1) {
    if (looks % (opts.pollEvery ?? POLL_LOOKS) === 0) await queue.poll();
    queue.tick();
    if (store.releaseIfIdle(pid)) return 'done';
    await sleep(LOOK_MS);
  }
}
