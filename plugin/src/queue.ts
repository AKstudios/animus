// The queue and its loop (docs/adr/0010): start queued jobs while slots are
// free and the room check says they fit, notice jobs that were running when
// the supervisor died and queue them again (to resume, up to a cap), answer,
// cancel and stop. It holds no state of its own beyond which jobs hold a slot:
// the store says what is queued and running. What a job is (a process, a
// container, whose credentials) is the supervisor's, passed in as `start`;
// the machine reading is passed in too, so tests give fixed ones. The plugin
// never imports Helix.
import { uptime } from 'node:os';
import type { Tier } from './profiles.ts';
import { readMachine, waitReason, type Reading, type Room } from './room.ts';

/** What the queue needs to know of a job; a supervisor's jobs have more. */
export type QueueJob = {
  id: number;
  state: 'queued' | 'running' | 'ended' | 'cancelled';
  tier?: Tier;
  /** Why a queued job is held for room; cleared when it starts. */
  waiting?: string;
  pid?: number;
  /** Times the supervisor came back and found the job running with no supervisor. */
  interrupted?: number;
  queued?: string;
  started?: string;
  ended?: string;
  animus_job?: string;
  answer?: string;
  outcome?: string;
  question?: string;
  reason?: string;
};

/** Where jobs are kept: Helix's table, or any other that reads and saves them as they are. */
export type QueueStore<J extends QueueJob> = {
  get(id: number): J | undefined;
  inState(state: J['state']): J[];
  save(job: J): void;
};

/** A job found running this many times when the supervisor came back is ended, not queued again: it may be what takes it down. */
export const MAX_INTERRUPTIONS = 3;

export type QueueOptions<J extends QueueJob> = {
  store: QueueStore<J>;
  /** slots: jobs that run at once; the rest is the room check's settings. */
  config: Room & { slots: number };
  /** The memory a job needs, when it is not config.job_memory (a container's own limit). */
  jobMemory?: string;
  /** Starts a job that fits; false when it ended at once (refused, failed to launch) and holds no slot. After it runs, the supervisor calls `release`. */
  start: (job: J) => boolean;
  /** Runs before a job starts, while it holds its slot; rejects with why the job cannot run. */
  prepare?: (job: J) => Promise<void>;
  /** Ends the job's process. */
  kill: (job: J) => void;
  /** Ends what a job leaves running outside its process tree (its container). */
  reap?: (id: number) => void;
  /** Saves a job that ended and says so. */
  end: (job: J) => void;
  /** While this is true no job starts; submissions still queue. */
  paused?: () => boolean;
  /** Reads the machine's free memory and load before each start; the machine's own by default. */
  machine?: () => Reading;
  say?: (line: string) => void;
  /** What the supervisor is called in what the queue says. */
  name?: string;
};

export type Queue<J extends QueueJob> = {
  /** Puts back in the queue what was running with no supervisor, then starts what fits. */
  begin(): void;
  /** Starts what the queue holds while slots are free. */
  tick(): void;
  /** A started job's process ended: its slot is free. */
  release(id: number): void;
  /** Cancels a job: ends it as cancelled (with fields added), ends its process, and frees nothing until `release`. */
  cancel(job: J, fields?: Partial<J>): J;
  /** Queues a job that asked a question again, with the answer. */
  answer(job: J, text: string): J;
  /** Stops starting jobs, puts the running ones back in the queue and ends their processes. */
  stop(): void;
  stopped(): boolean;
};

/** The job without these fields, and with these added: jobs are kept whole, so a field that no longer holds is dropped. */
const next = <J extends QueueJob>(job: J, set: Partial<QueueJob>, ...drop: (keyof QueueJob)[]): J => {
  const copy: Record<string, unknown> = { ...job, ...set };
  for (const key of drop) delete copy[key];
  return copy as unknown as J;
};

export function createQueue<J extends QueueJob>(opts: QueueOptions<J>): Queue<J> {
  const { store, config } = opts;
  const say = opts.say ?? (() => {});
  const reap = opts.reap ?? (() => {});
  const name = opts.name ?? 'Animus';
  const now = () => new Date().toISOString();
  let stopped = false;
  /** Jobs that hold a slot: running, or having their prepare run (they stay queued until it ends). */
  const held = new Set<number>();
  const preparing = new Set<number>();

  /** Starts a job that holds its slot; one that ended at once gives the slot back. */
  const launch = (job: J): void => { if (!opts.start(job)) held.delete(job.id); };

  function prepareThenStart(job: J, prepare: NonNullable<typeof opts.prepare>): void {
    preparing.add(job.id);
    void prepare(job).then(() => undefined, (err: unknown) => (err as Error).message).then((why) => {
      preparing.delete(job.id);
      if (stopped) return;
      const current = store.get(job.id);
      // Cancelled meanwhile: what the table says stands.
      if (current?.state === 'queued') {
        if (why === undefined) launch(current);
        else {
          held.delete(job.id);
          opts.end(next(current, { state: 'ended', ended: now(), outcome: 'failed', reason: why }));
          say(`job ${job.id} did not start: ${why}`);
        }
      } else held.delete(job.id);
      tick();
    });
  }

  function tick(): void {
    if (stopped || opts.paused?.()) return;
    const machine = (opts.machine ?? readMachine)();
    for (let job of store.inState('queued').filter((j) => !held.has(j.id))) {
      if (held.size >= config.slots) break;
      // With nothing running the first job starts whatever the machine reports, so the queue never sits empty.
      const why = held.size === 0 ? undefined : waitReason(config, [...held].map((id) => store.get(id)?.tier), job.tier, machine, opts.jobMemory);
      if (why !== undefined) {
        if (job.waiting !== why) store.save({ ...job, waiting: why });
        continue;
      }
      if (job.waiting !== undefined) { job = next(job, {}, 'waiting'); store.save(job); }
      held.add(job.id);
      if (opts.prepare) prepareThenStart(job, opts.prepare);
      else launch(job);
    }
  }

  return {
    begin() {
      // What the table calls running has no supervisor: end what is left of it and queue it again.
      // A pid from before the machine last started names nothing of ours now, and may name something else.
      const booted = Date.now() - uptime() * 1000;
      for (const job of store.inState('running')) {
        if (job.pid && job.started && Date.parse(job.started) > booted) opts.kill(job);
        reap(job.id);
        const interrupted = (job.interrupted ?? 0) + 1;
        if (interrupted >= MAX_INTERRUPTIONS) {
          opts.end(next(job, { interrupted, state: 'ended', ended: now(), outcome: 'failed', reason: `${name} stopped ${interrupted} times while this job ran, so it was not started again` }, 'pid'));
          say(`job ${job.id} was running when ${name} stopped, for the ${interrupted}th time: ended`);
          continue;
        }
        store.save(next(job, { interrupted, state: 'queued', queued: now() }, 'pid'));
        say(`job ${job.id} was running when ${name} stopped: queued again${job.animus_job ? ', to resume' : ''}`);
      }
      tick();
    },
    tick,
    release(id) {
      held.delete(id);
      tick();
    },
    cancel(job, fields) {
      opts.end(next(job, { ...fields, state: 'cancelled', ended: now() }, 'pid'));
      opts.kill(job);
      reap(job.id);
      return store.get(job.id)!;
    },
    answer(job, text) {
      store.save(next(job, { state: 'queued', queued: now(), answer: text }, 'outcome', 'question', 'reason', 'ended'));
      tick();
      return store.get(job.id)!;
    },
    stop() {
      stopped = true;
      for (const id of held) {
        if (preparing.has(id)) continue;
        const job = store.get(id);
        if (job?.state === 'running') store.save(next(job, { state: 'queued', queued: now() }, 'pid'));
        if (job) opts.kill(job);
        reap(id);
      }
    },
    stopped: () => stopped,
  };
}
