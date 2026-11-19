// The queue on this machine (docs/adr/0010): the same states and loop as Helix,
// kept in ANIMUS_HOME/queue.db. `animus start` adds a job and makes sure one
// loop runs (local-loop.ts); the loop is a process of its own, so closing the
// session that started a job stops nothing. The lock row says which loop it is.
import { spawn } from 'node:child_process';
import { closeSync, mkdirSync, openSync } from 'node:fs';
import { hostname, uptime } from 'node:os';
import { join } from 'node:path';
import { DatabaseSync } from 'node:sqlite';
import { alive, animusHome } from './log.ts';
import { PLUGIN_ROOT, type Tier } from './profiles.ts';
import { animusVersion } from './version.ts';
import type { QueueJob, QueueStore } from './queue.ts';
import { atLeast, parseVersion } from './semver.ts';

/** A job on this machine: what the queue needs, and what `animus run` is started with. */
export type LocalJob = QueueJob & {
  /** The checkout the job runs in. */
  repo: string;
  /** The spec file as given to `animus start`. */
  spec: string;
  title: string;
  /** The earlier spec files it runs after, as absolute paths; it waits until each one's pull request merges. */
  after?: string[];
  /** Options `animus run` is given as they were typed: --draft, --dry-run, --keep. */
  flags: string[];
  submitted: string;
  pr?: string;
  cost_usd?: number;
};

/**
 * The loop that holds the lock: its process, machine, release and when it took it.
 * drain: a newer `animus` asked it to start nothing more and exit once its running jobs end.
 * env: the names (never the values) of the variables it runs with, for `animus doctor`.
 */
export type LoopLock = { pid: number; host: string; version: string; started: string; drain: boolean; env: string[] };

/** Whether release `a` is newer than release `b`; false when either is not a version. */
export const newerThan = (a: string, b: string) => { const x = parseVersion(a), y = parseVersion(b); return Boolean(x && y) && !atLeast(b, a) && atLeast(a, b); };

export type LocalQueue = QueueStore<LocalJob> & {
  add(job: Omit<LocalJob, 'id'>): LocalJob;
  list(limit?: number): LocalJob[];
  /** Whether any job is queued, waiting or running: a loop is needed while this is true. */
  hasWork(): boolean;
  /** The loop that holds the lock, if its process is alive here. */
  loop(): LoopLock | undefined;
  /** Takes the lock for this process; false when another loop holds it. Two callers at once cannot both win. */
  claim(version: string, pid?: number, env?: string[]): boolean;
  /** Gives up the lock if no work is left, or if it is draining and no job is running, in one step with the check, so a job added just before is not left with no loop; whether it was given up. */
  releaseIfIdle(pid?: number): boolean;
  /** Asks the loop that holds the lock to start nothing more; true when this call asked, false when it had been asked or none holds it. */
  drain(): boolean;
  /** Whether the loop that holds the lock was asked to start nothing more. */
  draining(): boolean;
  /** When the person last looked at what needs them (`animus status`), if ever. */
  seen(): string | undefined;
  markSeen(at: string): void;
  close(): void;
};

export const queueFile = (home = animusHome()) => join(home, 'queue.db');

export function openLocalQueue(home = animusHome()): LocalQueue {
  mkdirSync(home, { recursive: true });
  const db = new DatabaseSync(queueFile(home));
  // Every `animus` command opens the queue beside the loop: wait for each other's writes.
  db.exec('pragma busy_timeout = 5000');
  db.exec('create table if not exists jobs (id integer primary key autoincrement, state text not null, data text not null)');
  db.exec("create table if not exists loop (id integer primary key check (id = 1), pid integer not null, host text not null, version text not null, started text not null, drain integer not null default 0, env text not null default '[]')");
  // A queue.db made before the loop recorded these has neither column.
  const columns = (db.prepare('pragma table_info(loop)').all() as { name: string }[]).map((c) => c.name);
  if (!columns.includes('drain')) db.exec('alter table loop add column drain integer not null default 0');
  if (!columns.includes('env')) db.exec("alter table loop add column env text not null default '[]'");
  db.exec('create table if not exists seen (id integer primary key check (id = 1), at text not null)');
  const row = (r: unknown): LocalJob => {
    const { id, state, data } = r as { id: number; state: LocalJob['state']; data: string };
    return { ...(JSON.parse(data) as LocalJob), id, state };
  };
  const lock = (): LoopLock | undefined => {
    const l = db.prepare('select pid, host, version, started, drain, env from loop where id = 1').get() as (Omit<LoopLock, 'drain' | 'env'> & { drain: number; env: string }) | undefined;
    return l && { ...l, drain: l.drain === 1, env: JSON.parse(l.env) as string[] };
  };
  // A pid from before the machine last started names nothing of ours now, and may name something else.
  const holds = (l: LoopLock) => l.host === hostname() && Date.parse(l.started) > Date.now() - uptime() * 1000 && alive(l.pid);
  const hasWork = () => db.prepare("select 1 from jobs where state in ('queued', 'waiting', 'running') limit 1").get() !== undefined;
  /** Runs fn holding the database's write lock, so another process's check and write wait for it. */
  const exclusive = <T>(fn: () => T): T => {
    db.exec('begin immediate');
    try { const out = fn(); db.exec('commit'); return out; } catch (err) { db.exec('rollback'); throw err; }
  };
  return {
    add(job) {
      const r = db.prepare('insert into jobs (state, data) values (?, ?) returning id').get(job.state, JSON.stringify(job)) as { id: number };
      return { ...job, id: r.id };
    },
    get: (id) => { const r = db.prepare('select * from jobs where id = ?').get(id); return r ? row(r) : undefined; },
    list: (limit = 50) => db.prepare('select * from jobs order by id desc limit ?').all(limit).map(row).reverse(),
    inState: (state) => db.prepare('select * from jobs where state = ? order by id').all(state).map(row),
    save(job) { db.prepare('update jobs set state = ?, data = ? where id = ?').run(job.state, JSON.stringify(job), job.id); },
    hasWork,
    loop: () => { const l = lock(); return l && holds(l) ? l : undefined; },
    claim: (version, pid = process.pid, env = []) => exclusive(() => {
      const l = lock();
      if (l && l.pid !== pid && holds(l)) return false;
      db.prepare('insert or replace into loop (id, pid, host, version, started, drain, env) values (1, ?, ?, ?, ?, 0, ?)').run(pid, hostname(), version, new Date().toISOString(), JSON.stringify(env));
      return true;
    }),
    releaseIfIdle: (pid = process.pid) => exclusive(() => {
      const l = lock();
      const handOver = l?.pid === pid && l.drain && db.prepare("select 1 from jobs where state = 'running' limit 1").get() === undefined;
      if (hasWork() && !handOver) return false;
      db.prepare('delete from loop where id = 1 and pid = ?').run(pid);
      return true;
    }),
    drain: () => exclusive(() => {
      const l = lock();
      if (!l || !holds(l) || l.drain) return false;
      db.prepare('update loop set drain = 1 where id = 1').run();
      return true;
    }),
    draining: () => lock()?.drain === true,
    seen: () => (db.prepare('select at from seen where id = 1').get() as { at: string } | undefined)?.at,
    markSeen(at) { db.prepare('insert or replace into seen (id, at) values (1, ?)').run(at); },
    close: () => db.close(),
  };
}

/** Puts a job in the queue, to start as soon as the loop has room for it; one with earlier specs waits for their pull requests to merge first. */
export function enqueue(queue: LocalQueue, job: { repo: string; spec: string; title: string; tier?: Tier; flags?: string[]; after?: string[] }): LocalJob {
  const now = new Date().toISOString();
  const after = job.after?.length ? job.after : undefined;
  return queue.add({ state: after ? 'waiting' : 'queued', repo: job.repo, spec: job.spec, title: job.title, ...(after ? { after } : {}), ...(job.tier ? { tier: job.tier } : {}), flags: job.flags ?? [], submitted: now, queued: now });
}

/** Starts the loop as a process of its own, on every OS: no session, terminal or service manager keeps it. It runs with this process's environment and keeps no token. */
function spawnLoop(): void {
  mkdirSync(animusHome(), { recursive: true });
  const log = openSync(join(animusHome(), 'loop.log'), 'a');
  try {
    spawn(process.execPath, ['--disable-warning=ExperimentalWarning', join(PLUGIN_ROOT, 'src', 'cli.ts'), 'loop'], { detached: true, stdio: ['ignore', log, log], windowsHide: true }).unref();
  } finally { closeSync(log); }
}

/**
 * Makes sure a loop runs while work is left: `idle` when there is none, `running` when one holds the lock, `started` when it started one.
 * Two callers at once may both start a process; the lock lets one loop run, and the other exits at once.
 * A loop of an older release is asked to start nothing more (as `helix upgrade` drains Helix) and a loop of this release is started: it waits for the old one's running jobs (runLoop), so no command here blocks on them.
 * `version` is this release.
 */
export function ensureLoop(queue: LocalQueue, start: () => void = spawnLoop, version = animusVersion()): 'idle' | 'running' | 'started' {
  if (!queue.hasWork()) return 'idle';
  const loop = queue.loop();
  if (!loop) { start(); return 'started'; }
  // Only the caller that sets the flag starts the successor; the others find it on its way.
  if (newerThan(version, loop.version) && queue.drain()) { start(); return 'started'; }
  return 'running';
}
