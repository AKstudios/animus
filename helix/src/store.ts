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
  /** When it last went back into the queue: after an answer, or when Helix stopped while it ran. */
  queued?: string;
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

/** A one-time code given to someone to join with (`helix invite`). Only the code's hash is kept. */
export type Invite = { code_sha256: string; name: string; github?: string; expires: string };

export type Store = {
  add(job: Omit<HelixJob, 'id'>): HelixJob;
  get(id: number): HelixJob | undefined;
  list(limit?: number): HelixJob[];
  inState(state: State): HelixJob[];
  save(job: HelixJob): void;
  /** Keeps an invite, replacing any earlier one for the same name. */
  invite(invite: Invite): void;
  /** The invite with this code's hash, if it has not expired; it stays. */
  findInvite(codeSha256: string, at?: Date): Invite | undefined;
  /** Removes and returns the invite with this code's hash: only one caller can take it. */
  takeInvite(codeSha256: string, at?: Date): Invite | undefined;
  close(): void;
};

export function openStore(file: string): Store {
  mkdirSync(dirname(file), { recursive: true });
  const db = new DatabaseSync(file);
  // helix remove-person and helix upgrade open the table while helix serve has it: wait for each other's writes.
  db.exec('pragma busy_timeout = 5000');
  db.exec('create table if not exists jobs (id integer primary key autoincrement, state text not null, data text not null)');
  db.exec('create table if not exists invites (code_sha256 text primary key, name text not null unique, data text not null)');
  const asInvite = (r: unknown): Invite => JSON.parse((r as { data: string }).data) as Invite;
  const live = (i: Invite, at: Date) => Date.parse(i.expires) > at.getTime();
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
    invite(i) {
      db.prepare('delete from invites where name = ?').run(i.name);
      db.prepare('insert into invites (code_sha256, name, data) values (?, ?, ?)').run(i.code_sha256, i.name, JSON.stringify(i));
    },
    findInvite(hash, at = new Date()) {
      const r = db.prepare('select data from invites where code_sha256 = ?').get(hash);
      return r && live(asInvite(r), at) ? asInvite(r) : undefined;
    },
    takeInvite(hash, at = new Date()) {
      const r = db.prepare('delete from invites where code_sha256 = ? returning data').get(hash);
      return r && live(asInvite(r), at) ? asInvite(r) : undefined;
    },
    close: () => db.close(),
  };
}
