// The supervisor: starts queued jobs while slots are free, each as its own
// `animus run` process with the submitter's credentials in its environment
// and nobody else's. It holds no state of its own: the table says what is
// queued and running, and Animus's job files say how far a job got, so after
// a crash it puts what was running back in the queue and resumes it.
import { spawn, type ChildProcess } from 'node:child_process';
import { appendFileSync, existsSync, mkdirSync, readFileSync, writeFileSync } from 'node:fs';
import { uptime } from 'node:os';
import { basename, dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { AnimusError } from '../../plugin/src/proc.ts';
import { loadProgress, type Progress } from '../../plugin/src/log.ts';
import { parseSpec } from '../../plugin/src/spec.ts';
import { credentialEnv, personEnv, type Config } from './config.ts';
import type { HelixJob, Store } from './store.ts';

const PLUGIN = join(dirname(fileURLToPath(import.meta.url)), '..', '..', 'plugin');

/**
 * How a job's process is started. env is what the job runs with (the
 * person's credentials and Animus's variables); a launch may add to it, and
 * names the folder to start in.
 */
export type Launch = (job: HelixJob, repoDir: string, env: Record<string, string>) => { command: string; args: string[]; env?: Record<string, string>; cwd?: string };

/** What `animus` is asked to do for a job: run it, or resume one that ran before. */
export const animusArgs = (job: HelixJob, repoDir: string): string[] => (job.animus_job
  ? ['resume', job.animus_job, ...(job.answer ? ['--answer', job.answer] : [])]
  : ['run', job.spec, '--repo', repoDir, ...(job.draft ? ['--draft'] : [])]);

/** The same command a person runs on a laptop, on this machine as Helix's account. */
const animus: Launch = (job, repoDir) => ({
  command: process.execPath,
  args: ['--disable-warning=ExperimentalWarning', join(PLUGIN, 'src', 'cli.ts'), ...animusArgs(job, repoDir)],
});

/** A job found running this many times when Helix came back is ended, not queued again: it may be what takes Helix down. */
export const MAX_INTERRUPTIONS = 3;

/** Looks at a person's credentials before their job starts: why the job cannot run, or variables to add to it (the person's git identity). */
export type Preflight = (person: string, env: Record<string, string>, repoDir: string) => { why?: string; env?: Record<string, string> };

export type Submission = { repo: string; spec: string; name?: string; draft?: boolean };

/** While this file is in Helix's home, no job starts; submissions still queue. `helix upgrade` sets it to drain the machine. */
export const pauseFile = (home: string) => join(home, 'paused');
/** What `helix upgrade` writes in the pause file: the next `helix serve` takes the pause off. */
export const UNTIL_RESTART = 'until restart';

export type Supervisor = {
  submit(person: string, s: Submission): HelixJob;
  cancel(person: string, id: number): HelixJob;
  answer(person: string, id: number, text: string): HelixJob;
  log(id: number, lines?: number): string;
  /** Where a running job says it is, from the Animus state it writes. */
  progress(job: HelixJob): Progress | undefined;
  /** Starts what the queue holds while slots are free: after the config changed, or a pause ended. */
  wake(): void;
  /** Stops starting jobs and ends the ones running. */
  stop(): void;
};

export class Refused extends AnimusError {
  status: number;
  constructor(status: number, message: string) { super(message); this.status = status; }
}

/** Ends a job's process. A job is a tree (animus, the agent, the project's checks): the whole group goes where there is one. */
function kill(pid: number, child?: ChildProcess): void {
  try {
    if (process.platform !== 'win32') process.kill(-pid, 'SIGTERM');
    else if (child) child.kill();
    else process.kill(pid);
  } catch { /* already gone */ }
}

/**
 * Cancels a person's queued and running jobs, from any process: `helix
 * remove-person` runs beside `helix serve`, which sees the job's process end
 * and leaves the table as this says. Jobs that already ended are kept.
 */
export function cancelJobsOf(store: Store, person: string, reap: (id: number) => void = () => {}): HelixJob[] {
  const now = new Date().toISOString();
  const theirs = [...store.inState('queued'), ...store.inState('running')].filter((j) => j.person === person);
  for (const job of theirs) {
    const { pid, ...rest } = job;
    store.save({ ...rest, state: 'cancelled', ended: now, reason: `${person} was removed from Helix` });
    if (pid) kill(pid);
    reap(job.id);
  }
  return theirs;
}

export function supervise(opts: {
  store: Store; config: Config; home: string; launch?: Launch; preflight?: Preflight; say?: (line: string) => void;
  /** Ends what a job leaves running outside its process tree (its container). */
  reap?: (id: number) => void;
  /** The Animus home a person's jobs write their state to, when it is not Helix's own. */
  animusHomeOf?: (person: string) => string;
}): Supervisor {
  const { store, config, home } = opts;
  const launch = opts.launch ?? animus;
  const say = opts.say ?? (() => {});
  const reap = opts.reap ?? (() => {});
  const children = new Map<number, ChildProcess>();
  const now = () => new Date().toISOString();
  const logFile = (id: number) => join(home, 'jobs', String(id), 'log.txt');
  let stopped = false;


  const mine = (person: string, id: number): HelixJob => {
    const job = store.get(id);
    if (!job) throw new Refused(404, `no job ${id}`);
    if (job.person !== person) throw new Refused(403, `job ${id} is ${job.person}'s`);
    return job;
  };

  function start(job: HelixJob): void {
    const repoDir = config.repos[job.repo] ?? '';
    mkdirSync(dirname(logFile(job.id)), { recursive: true });
    let env: NodeJS.ProcessEnv;
    let launched: ReturnType<Launch>;
    try {
      // Taken off since the job was queued: it never runs, and never with the machine's own logins in place of theirs.
      if (!config.people[job.person]) throw new AnimusError(`${job.person} is no longer on Helix`);
      if (!repoDir) throw new AnimusError(`Helix no longer has the repository ${job.repo}`);
      const theirs = personEnv(config.people[job.person]);
      const looked = opts.preflight?.(job.person, theirs, repoDir) ?? {};
      if (looked.why) throw new AnimusError(looked.why);
      // What the person set themselves wins over what was looked up.
      const jobEnv = { ...looked.env, ...theirs, ...credentialEnv(theirs), ANIMUS_USER: job.person, ANIMUS_TRIGGER: 'helix', ANIMUS_BIN: join(PLUGIN, 'bin', 'animus') };
      launched = launch(job, repoDir, jobEnv);
      env = { ...process.env, ...jobEnv, ...launched.env };
    } catch (err) {
      store.save({ ...job, state: 'ended', ended: now(), outcome: 'failed', reason: (err as Error).message });
      say(`job ${job.id} did not start: ${(err as Error).message}`);
      return;
    }
    const child = spawn(launched.command, launched.args, { cwd: launched.cwd ?? repoDir, env, detached: process.platform !== 'win32', stdio: ['ignore', 'pipe', 'pipe'] });
    children.set(job.id, child);
    const { answer: _used, ...rest } = job;
    let running: HelixJob = { ...rest, state: 'running', started: now(), ...(child.pid ? { pid: child.pid } : {}) };
    store.save(running);
    say(`job ${job.id} started for ${job.person}: ${job.title}`);

    let out = '';
    child.stdout!.on('data', (chunk: Buffer) => { out += chunk.toString(); });
    child.stderr!.on('data', (chunk: Buffer) => {
      const text = chunk.toString();
      appendFileSync(logFile(job.id), text);
      const id = /^job (\S+): /m.exec(text)?.[1];
      if (id && !running.animus_job && !stopped) { running = { ...running, animus_job: id }; store.save(running); }
    });
    const end = (fallback: string) => {
      if (!children.delete(job.id) || stopped) return;
      const current = store.get(job.id);
      // Cancelled, or put back in the queue by stop(): what the table says stands.
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
      tick();
    };
    child.on('error', (err) => end(`could not start: ${err.message}`));
    child.on('close', (code, signal) => {
      // Animus says why on its last line when it refuses to start a job.
      const last = existsSync(logFile(job.id)) ? readFileSync(logFile(job.id), 'utf8').trimEnd().split('\n').pop() : undefined;
      end(`animus ended with ${signal ?? `exit ${code}`} and no result${last ? `: ${last.replace(/^animus: /, '')}` : ''}`);
    });
  }

  function tick(): void {
    if (stopped || existsSync(pauseFile(home))) return;
    const queued = store.inState('queued');
    while (children.size < config.slots && queued.length) start(queued.shift()!);
  }

  // What the table calls running has no supervisor: end what is left of it and queue it again.
  // A pid from before the machine last started names nothing of ours now, and may name something else.
  const booted = Date.now() - uptime() * 1000;
  for (const job of store.inState('running')) {
    if (job.pid && job.started && Date.parse(job.started) > booted) kill(job.pid);
    reap(job.id);
    const { pid: _pid, ...rest } = job;
    const interrupted = (job.interrupted ?? 0) + 1;
    if (interrupted >= MAX_INTERRUPTIONS) {
      store.save({ ...rest, interrupted, state: 'ended', ended: now(), outcome: 'failed', reason: `Helix stopped ${interrupted} times while this job ran, so it was not started again` });
      say(`job ${job.id} was running when Helix stopped, for the ${interrupted}th time: ended`);
      continue;
    }
    store.save({ ...rest, interrupted, state: 'queued', queued: now() });
    say(`job ${job.id} was running when Helix stopped: queued again${job.animus_job ? ', to resume' : ''}`);
  }
  tick();

  return {
    submit(person, s) {
      const repoDir = config.repos[s.repo];
      if (!repoDir) throw new Refused(400, `Helix has no repository named ${s.repo}; it has ${Object.keys(config.repos).join(', ') || 'none'}`);
      let title: string;
      try { title = parseSpec(s.spec, s.name ?? 'spec.md').title; } catch (err) { throw new Refused(400, (err as Error).message); }
      const job = store.add({ state: 'queued', person, repo: s.repo, spec: '', title, draft: Boolean(s.draft), submitted: now() });
      job.spec = join(home, 'jobs', String(job.id), basename(s.name ?? 'spec.md'));
      mkdirSync(dirname(job.spec), { recursive: true });
      writeFileSync(job.spec, s.spec);
      store.save(job);
      tick();
      return store.get(job.id)!;
    },
    cancel(person, id) {
      const job = mine(person, id);
      if (job.state !== 'queued' && job.state !== 'running') throw new Refused(409, `job ${id} has already ${job.state === 'cancelled' ? 'been cancelled' : 'ended'}`);
      const { pid, ...rest } = job;
      store.save({ ...rest, state: 'cancelled', ended: now() });
      if (pid) kill(pid, children.get(id));
      reap(id);
      return store.get(id)!;
    },
    answer(person, id, text) {
      const job = mine(person, id);
      if (job.state !== 'ended' || job.outcome !== 'needs-input') throw new Refused(409, `job ${id} is not waiting for an answer`);
      const { outcome: _o, question: _q, reason: _r, ended: _e, ...rest } = job;
      store.save({ ...rest, state: 'queued', queued: now(), answer: text });
      tick();
      return store.get(id)!;
    },
    log(id, lines = 200) {
      if (!existsSync(logFile(id))) return '';
      return readFileSync(logFile(id), 'utf8').trimEnd().split('\n').slice(-lines).join('\n');
    },
    wake: () => tick(),
    progress: (job) => (job.animus_job ? loadProgress(job.animus_job, opts.animusHomeOf?.(job.person)) : undefined),
    stop() {
      stopped = true;
      for (const [id, child] of children) {
        const job = store.get(id);
        if (job?.state === 'running') { const { pid: _pid, ...rest } = job; store.save({ ...rest, state: 'queued', queued: now() }); }
        if (child.pid) kill(child.pid, child);
        reap(id);
      }
    },
  };
}
