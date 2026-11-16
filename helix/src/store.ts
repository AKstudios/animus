// The queue: one SQLite table, one row per submitted job. It is the durable
// record, kept apart from the supervisor, so a supervisor that dies is
// started again and carries on from what the table says.
import { mkdirSync } from 'node:fs';
import { dirname } from 'node:path';
import { DatabaseSync } from 'node:sqlite';

export type State = 'queued' | 'running' | 'ended' | 'cancelled';

export type HelixJob = {
  id: number;
  state: State;
  person: string;
  /** The repository's name in Helix's config. */
  repo: string;
  /** Helix's copy of the submitted spec. */
  spec: string;
  title: string;
  draft: boolean;
  submitted: string;
  started?: string;
  ended?: string;
  pid?: number;
  /** Times Helix came back and found the job running with no supervisor. */
  interrupted?: number;
  /** Animus's own id for the job, once its run has said it: what a restart or an answer resumes. */
  animus_job?: string;
  /** The person's answer to the job's question, for the next start. */
  answer?: string;
  /** How the run ended: Animus's outcome (pr, draft-pr, needs-input, failed). */
  outcome?: string;
  pr?: string;
  reason?: string;
  question?: string;
  cost_usd?: number;
};

export type Store = {
  add(job: Omit<HelixJob, 'id'>): HelixJob;
  get(id: number): HelixJob | undefined;
  list(limit?: number): HelixJob[];
  inState(state: State): HelixJob[];
  save(job: HelixJob): void;
  close(): void;
};

export function openStore(file: string): Store {
  mkdirSync(dirname(file), { recursive: true });
  const db = new DatabaseSync(file);
  db.exec('create table if not exists jobs (id integer primary key autoincrement, state text not null, data text not null)');
  const row = (r: unknown): HelixJob => {
    const { id, state, data } = r as { id: number; state: State; data: string };
    return { ...(JSON.parse(data) as HelixJob), id, state };
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
    close: () => db.close(),
  };
}
