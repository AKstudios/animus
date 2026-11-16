// The supervisor: starts queued jobs while slots are free, each as its own
// `animus run` process with the submitter's credentials in its environment
// and nobody else's. It holds no state of its own: the table says what is
// queued and running, and Animus's job files say how far a job got, so after
// a crash it puts what was running back in the queue and resumes it.
import { spawn, type ChildProcess } from 'node:child_process';
import { appendFileSync, existsSync, mkdirSync, readFileSync, writeFileSync } from 'node:fs';
import { basename, dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { AnimusError } from '../../plugin/src/proc.ts';
import { parseSpec } from '../../plugin/src/spec.ts';
import { personEnv, type Config } from './config.ts';
import type { HelixJob, Store } from './store.ts';

const PLUGIN = join(dirname(fileURLToPath(import.meta.url)), '..', '..', 'plugin');

export type Launch = (job: HelixJob, repoDir: string) => { command: string; args: string[] };

/** The same command a person runs on a laptop; a job that ran before is resumed. */
const animus: Launch = (job, repoDir) => ({
  command: process.execPath,
  args: ['--disable-warning=ExperimentalWarning', join(PLUGIN, 'src', 'cli.ts'), ...(job.animus_job
    ? ['resume', job.animus_job, ...(job.answer ? ['--answer', job.answer] : [])]
    : ['run', job.spec, '--repo', repoDir, ...(job.draft ? ['--draft'] : [])])],
});

export type Submission = { repo: string; spec: string; name?: string; draft?: boolean };

export type Supervisor = {
  submit(person: string, s: Submission): HelixJob;
  cancel(person: string, id: number): HelixJob;
  answer(person: string, id: number, text: string): HelixJob;
  log(id: number, lines?: number): string;
  /** Stops starting jobs and ends the ones running. */
  stop(): void;
};

export class Refused extends AnimusError {
  status: number;
  constructor(status: number, message: string) { super(message); this.status = status; }
}

export function supervise(opts: { store: Store; config: Config; home: string; launch?: Launch; say?: (line: string) => void }): Supervisor {
  const { store, config, home } = opts;
  const launch = opts.launch ?? animus;
  const say = opts.say ?? (() => {});
  const children = new Map<number, ChildProcess>();
  const now = () => new Date().toISOString();
  const logFile = (id: number) => join(home, 'jobs', String(id), 'log.txt');
  let stopped = false;

  const kill = (pid: number, child?: ChildProcess) => {
    // A job is a tree (animus, the agent, the project's checks): end the whole group where there is one.
    try { if (process.platform === 'win32') child?.kill(); else process.kill(-pid, 'SIGTERM'); } catch { /* already gone */ }
  };

  const mine = (person: string, id: number): HelixJob => {
    const job = store.get(id);
    if (!job) throw new Refused(404, `no job ${id}`);
    if (job.person !== person) throw new Refused(403, `job ${id} is ${job.person}'s`);
    return job;
  };

  function start(job: HelixJob): void {
    const repoDir = config.repos[job.repo]!;
    const { command, args } = launch(job, repoDir);
    mkdirSync(dirname(logFile(job.id)), { recursive: true });
    let env: NodeJS.ProcessEnv;
    try {
      env = { ...process.env, ...personEnv(config.people[job.person]), ANIMUS_USER: job.person, ANIMUS_TRIGGER: 'helix', ANIMUS_BIN: join(PLUGIN, 'bin', 'animus') };
    } catch (err) {
      store.save({ ...job, state: 'ended', ended: now(), outcome: 'failed', reason: (err as Error).message });
      return;
    }
    const child = spawn(command, args, { cwd: repoDir, env, detached: process.platform !== 'win32', stdio: ['ignore', 'pipe', 'pipe'] });
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
    if (stopped) return;
    const queued = store.inState('queued');
    while (children.size < config.slots && queued.length) start(queued.shift()!);
  }

  // What the table calls running has no supervisor: end what is left of it and queue it again.
  for (const job of store.inState('running')) {
    if (job.pid) kill(job.pid);
    const { pid: _pid, ...rest } = job;
    store.save({ ...rest, state: 'queued' });
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
      return store.get(id)!;
    },
    answer(person, id, text) {
      const job = mine(person, id);
      if (job.state !== 'ended' || job.outcome !== 'needs-input') throw new Refused(409, `job ${id} is not waiting for an answer`);
      const { outcome: _o, question: _q, reason: _r, ended: _e, ...rest } = job;
      store.save({ ...rest, state: 'queued', answer: text });
      tick();
      return store.get(id)!;
    },
    log(id, lines = 200) {
      if (!existsSync(logFile(id))) return '';
      return readFileSync(logFile(id), 'utf8').trimEnd().split('\n').slice(-lines).join('\n');
    },
    stop() {
      stopped = true;
      for (const [id, child] of children) {
        const job = store.get(id);
        if (job?.state === 'running') { const { pid: _pid, ...rest } = job; store.save({ ...rest, state: 'queued' }); }
        if (child.pid) kill(child.pid, child);
      }
    },
  };
}
