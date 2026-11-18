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
import { animusHome, loadProgress, type Progress } from '../../plugin/src/log.ts';
import type { PersonalSkill } from '../../plugin/src/personal.ts';
import { loadFactory, resolvePlan, type Tier } from '../../plugin/src/profiles.ts';
import { parseSpec } from '../../plugin/src/spec.ts';
import { readMachine, waitReason, type Reading } from './room.ts';
import { credentialEnv, personEnv, readyRepos, type Config } from './config.ts';
import { liveTokenFile } from './github-app.ts';
import type { HelixJob, Store } from './store.ts';

export const PLUGIN = join(dirname(fileURLToPath(import.meta.url)), '..', '..', 'plugin');

/**
 * How a job's process is started. env is what the job runs with (the
 * person's credentials and Animus's variables); a launch may add to it, and
 * names the folder to start in.
 */
export type Launch = (job: HelixJob, repoDir: string, env: Record<string, string>) => { command: string; args: string[]; env?: Record<string, string>; cwd?: string };

/** What `animus` is asked to do for a job: run it, or resume one that ran before. */
export const animusArgs = (job: HelixJob, repoDir: string): string[] => (job.animus_job
  ? ['resume', job.animus_job, ...(job.answer ? ['--answer', job.answer] : [])]
  : ['run', job.spec, '--repo', repoDir, ...(job.draft ? ['--draft'] : []), ...(existsSync(skillsFile(job)) ? ['--skills', skillsFile(job)] : [])]);

/** Where Helix keeps the skills a person sent with a spec: beside it, so a job's container sees them where the spec is. */
export const skillsFile = (job: Pick<HelixJob, 'spec'>) => join(dirname(job.spec), 'skills.json');

/** The same command a person runs on a laptop, on this machine as Helix's account. */
const animus: Launch = (job, repoDir) => ({
  command: process.execPath,
  args: ['--disable-warning=ExperimentalWarning', join(PLUGIN, 'src', 'cli.ts'), ...animusArgs(job, repoDir)],
});

/** A job found running this many times when Helix came back is ended, not queued again: it may be what takes Helix down. */
export const MAX_INTERRUPTIONS = 3;

/** Looks at a person's credentials before their job starts: why the job cannot run, or variables to add to it (the person's git identity). */
export type Preflight = (person: string, env: Record<string, string>, repoDir: string, repo: string) => { why?: string; env?: Record<string, string> };

/** github: the issue it was submitted from, which its progress is told on. */
export type Submission = { repo: string; spec: string; name?: string; draft?: boolean; skills?: PersonalSkill[]; github?: { repo: string; issue: number } };

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
  /** The Animus home a person's jobs keep their folders and run log in. */
  animusHome(person: string): string;
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

/** Whether a job can no longer be cancelled: it ended, failed or was cancelled already. */
export const jobIsOver = (job: HelixJob): boolean => job.state !== 'queued' && job.state !== 'running';

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
  /** Runs before each job, ahead of preflight, while the job holds its slot: a fresh GitHub token (github-app.ts beforeJob). Throws why the job cannot run. */
  prepare?: (person: string, repo: string) => Promise<void>;
  /** Ends what a job leaves running outside its process tree (its container). */
  reap?: (id: number) => void;
  /** The Animus home a person's jobs write their state to, when it is not Helix's own. */
  animusHomeOf?: (person: string) => string;
  /** Told each job as it starts and as it ends, however it was submitted: the Slack bot posts it. */
  notify?: (job: HelixJob) => void;
  /** Reads the machine's free memory and load before each start; the machine's own by default, fixed ones in tests. */
  machine?: () => Reading;
}): Supervisor {
  const { store, config, home } = opts;
  const launch = opts.launch ?? animus;
  const say = opts.say ?? (() => {});
  const reap = opts.reap ?? (() => {});
  const notify = opts.notify ?? (() => {});
  /** Saves a job that started or ended, and says so to notify. */
  const saveAndTell = (job: HelixJob) => { store.save(job); notify(job); };
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
    const project = store.project(job.repo);
    const repoDir = project?.state === 'ready' ? project.dir : '';
    const person = store.person(job.person);
    mkdirSync(dirname(logFile(job.id)), { recursive: true });
    let env: NodeJS.ProcessEnv;
    let launched: ReturnType<Launch>;
    try {
      // Taken off since the job was queued: it never runs, and never with the machine's own logins in place of theirs.
      if (!person) throw new AnimusError(`${job.person} is no longer on Helix`);
      if (!repoDir) throw new AnimusError(`Helix no longer has the project ${job.repo}`);
      const live = liveTokenFile(job.person);
      // Signed in with the GitHub App: git and Animus's gh read the token as it is when they use it (github-app.ts liveTokenDir).
      const theirs = { ...personEnv(person), ...(existsSync(live) ? { ANIMUS_GH_TOKEN_FILE: live } : {}) };
      const looked = opts.preflight?.(job.person, theirs, repoDir, job.repo) ?? {};
      if (looked.why) throw new AnimusError(looked.why);
      // What the person set themselves wins over what was looked up.
      const jobEnv = { ...looked.env, ...theirs, ...credentialEnv(theirs), ANIMUS_USER: job.person, ANIMUS_TRIGGER: 'helix', ANIMUS_BIN: join(PLUGIN, 'bin', 'animus') };
      launched = launch(job, repoDir, jobEnv);
      env = { ...process.env, ...jobEnv, ...launched.env };
    } catch (err) {
      saveAndTell({ ...job, state: 'ended', ended: now(), outcome: 'failed', reason: (err as Error).message });
      say(`job ${job.id} did not start: ${(err as Error).message}`);
      return;
    }
    const child = spawn(launched.command, launched.args, { cwd: launched.cwd ?? repoDir, env, detached: process.platform !== 'win32', stdio: ['ignore', 'pipe', 'pipe'] });
    children.set(job.id, child);
    const { answer: _used, ...rest } = job;
    let running: HelixJob = { ...rest, state: 'running', started: now(), ...(child.pid ? { pid: child.pid } : {}) };
    saveAndTell(running);
    say(`job ${job.id} started for ${job.person}: ${job.title}`);

    let out = '';
    child.stdout!.on('data', (chunk: Buffer) => { out += chunk.toString(); });
    child.stderr!.on('data', (chunk: Buffer) => {
      const text = chunk.toString();
      appendFileSync(logFile(job.id), text);
      const id = /^job (\S+): /m.exec(text)?.[1];
      if (id && !running.animus_job && !stopped) {
        running = { ...running, animus_job: id };
        // Saved onto what the table says now: a job cancelled before this line came stays cancelled.
        const current = store.get(job.id);
        if (current?.state === 'running') store.save({ ...current, animus_job: id });
      }
    });
    const end = (fallback: string) => {
      if (!children.delete(job.id) || stopped) return;
      const current = store.get(job.id);
      // Cancelled, or put back in the queue by stop(): what the table says stands.
      if (current?.state === 'running') {
        let result: { outcome?: string; pr?: string; reason?: string; question?: string; cost_usd?: number } = {};
        try { result = JSON.parse(out) as typeof result; } catch { /* it died before it could say */ }
        const { pid: _pid, ...kept } = current;
        saveAndTell({
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

  /** Jobs whose prepare is running: they hold a slot, and stay queued until it ends. */
  const preparing = new Set<number>();

  function prepareThenStart(job: HelixJob, prepare: NonNullable<typeof opts.prepare>): void {
    preparing.add(job.id);
    void prepare(job.person, job.repo).then(() => undefined, (err: unknown) => (err as Error).message).then((why) => {
      preparing.delete(job.id);
      if (stopped) return;
      const current = store.get(job.id);
      // Cancelled meanwhile: what the table says stands.
      if (current?.state === 'queued') {
        if (why === undefined) start(current);
        else {
          saveAndTell({ ...current, state: 'ended', ended: now(), outcome: 'failed', reason: why });
          say(`job ${job.id} did not start: ${why}`);
        }
      }
      tick();
    });
  }

  function tick(): void {
    if (stopped || existsSync(pauseFile(home))) return;
    const machine = (opts.machine ?? readMachine)();
    for (let job of store.inState('queued').filter((j) => !preparing.has(j.id))) {
      const used = children.size + preparing.size;
      if (used >= config.slots) break;
      // With nothing running the first job starts whatever the machine reports, so the queue never sits empty.
      const why = used === 0 ? undefined : waitReason(config, [...children.keys(), ...preparing].map((id) => store.get(id)?.tier), job.tier, machine, config.container?.memory);
      if (why !== undefined) {
        if (job.waiting !== why) store.save({ ...job, waiting: why });
        continue;
      }
      if (job.waiting !== undefined) { const { waiting: _w, ...rest } = job; job = rest; store.save(job); }
      if (opts.prepare) prepareThenStart(job, opts.prepare);
      else start(job);
    }
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
      saveAndTell({ ...rest, interrupted, state: 'ended', ended: now(), outcome: 'failed', reason: `Helix stopped ${interrupted} times while this job ran, so it was not started again` });
      say(`job ${job.id} was running when Helix stopped, for the ${interrupted}th time: ended`);
      continue;
    }
    store.save({ ...rest, interrupted, state: 'queued', queued: now() });
    say(`job ${job.id} was running when Helix stopped: queued again${job.animus_job ? ', to resume' : ''}`);
  }
  tick();

  return {
    submit(person, s) {
      const project = store.project(s.repo);
      if (project?.state === 'checking') throw new Refused(409, `Helix is still checking the project ${s.repo}: animus project list says when it is ready`);
      if (project?.state !== 'ready') throw new Refused(400, `Helix has no project named ${s.repo}; it has ${Object.keys(readyRepos(store)).join(', ') || 'none'}. Add it from a checkout of it: animus project add`);
      let title: string;
      let tier: Tier | undefined;
      try {
        const spec = parseSpec(s.spec, s.name ?? 'spec.md');
        title = spec.title;
        // A spec the factory will not run fails in its own time; here it only goes uncounted.
        try { tier = resolvePlan(loadFactory(), spec).implement.tier; } catch { /* no tier */ }
      } catch (err) { throw new Refused(400, (err as Error).message); }
      const job = store.add({ state: 'queued', person, repo: s.repo, spec: '', title, ...(tier ? { tier } : {}), draft: Boolean(s.draft), ...(s.github ? { github: s.github } : {}), submitted: now() });
      job.spec = join(home, 'jobs', String(job.id), basename(s.name ?? 'spec.md'));
      mkdirSync(dirname(job.spec), { recursive: true });
      writeFileSync(job.spec, s.spec);
      if (s.skills?.length) writeFileSync(skillsFile(job), `${JSON.stringify(s.skills, null, 2)}\n`);
      store.save(job);
      store.record(person, 'submitted', { job: job.id, repo: s.repo });
      tick();
      return store.get(job.id)!;
    },
    cancel(person, id) {
      const job = mine(person, id);
      if (jobIsOver(job)) throw new Refused(409, `job ${id} has already ${job.state === 'cancelled' ? 'been cancelled' : 'ended'}`);
      const { pid, ...rest } = job;
      saveAndTell({ ...rest, state: 'cancelled', ended: now() });
      store.record(person, 'cancelled', { job: id });
      if (pid) kill(pid, children.get(id));
      reap(id);
      return store.get(id)!;
    },
    answer(person, id, text) {
      const job = mine(person, id);
      if (job.state !== 'ended' || job.outcome !== 'needs-input') throw new Refused(409, `job ${id} is not waiting for an answer`);
      const { outcome: _o, question: _q, reason: _r, ended: _e, ...rest } = job;
      store.save({ ...rest, state: 'queued', queued: now(), answer: text });
      store.record(person, 'answered', { job: id, answer: text });
      tick();
      return store.get(id)!;
    },
    log(id, lines = 200) {
      if (!existsSync(logFile(id))) return '';
      return readFileSync(logFile(id), 'utf8').trimEnd().split('\n').slice(-lines).join('\n');
    },
    wake: () => tick(),
    progress: (job) => (job.animus_job ? loadProgress(job.animus_job, opts.animusHomeOf?.(job.person)) : undefined),
    animusHome: (person) => opts.animusHomeOf?.(person) ?? animusHome(),
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
