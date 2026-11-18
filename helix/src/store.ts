// Helix's record: the queue (one row per submitted job), the people who may
// submit and their Slack links, each job's Slack thread, the projects they may submit for, drafts from Slack, and open invites, all in one
// SQLite file. It is kept apart from the supervisor, so a supervisor that dies
// is started again and carries on from what the tables say, and the helix
// command changes it beside a running `helix serve`, which sees the change on
// its next read.
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

/**
 * A person who may submit. A person is known by the hash of a token; the
 * token itself is shown once, when they join or are added, and never kept.
 * env_file: KEY=VALUE lines set for that person's jobs only: their Claude
 * token and GitHub credential. github: the login their GitHub token signed in
 * as when they joined. joined: the day they joined (ISO), kept for those who
 * joined after it was kept.
 */
export type Person = { token_sha256: string; env_file?: string; github?: string; joined?: string };

/**
 * Something a person did on Helix, kept for good (a person who leaves keeps
 * theirs). detail: what the kind adds: the job and repo, an answer's text, a
 * project's name.
 */
export type ActivityKind = 'submitted' | 'answered' | 'cancelled' | 'joined' | 'left' | 'project-added' | 'project-removed' | 'drafted' | 'channel-project';
export type Activity = { id: number; who: string; at: string; kind: ActivityKind; detail?: Record<string, string | number> };

/**
 * A repository jobs may be submitted for, under the name submissions use.
 * Helix keeps a clone of it at dir. One added with `animus project add` is
 * checked first (projects.ts): checking until then, and failed with the
 * reason if the check did not pass. added_by: who added it, the one person
 * who may remove it over the API; none when it was added on the machine.
 */
export type Project = {
  name: string; url: string; dir: string; state: 'checking' | 'ready' | 'failed';
  added: string; added_by?: string; reason?: string;
};

/**
 * A one-time code given to someone to join with (`helix invite`). Only the
 * code's hash is kept. slack: the Slack user joining with it links to the person.
 */
export type Invite = { code_sha256: string; name: string; github?: string; slack?: string; expires: string };

/** One try at moving this machine to a release (`helix upgrade`): when, and whether it went on. */
export type Upgrade = { tag: string; at: string; ok: boolean; detail?: string };

/** A DM channel and the ts of the message that opened the thread in it. */
export type SlackThread = { channel: string; ts: string };

/**
 * A draft spec being written from a Slack message (drafts.ts), in the thread
 * at channel and ts. picking: its person has yet to choose the project;
 * queued and running: waiting for, then holding, one of draft_slots; ready:
 * its draft.md is posted; failed: why is in reason. folder: message.md,
 * references/ and draft.md (plugin/src/draft.ts).
 */
export type Draft = {
  id: number; state: 'picking' | 'queued' | 'running' | 'ready' | 'failed';
  person: string; channel: string; ts: string; project?: string; folder: string;
  created: string; touched: string; reason?: string;
};

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
  person(name: string): Person | undefined;
  /** Everyone, by name. */
  people(): Record<string, Person>;
  /** Who holds a token with this hash. */
  personByToken(tokenSha256: string): string | undefined;
  putPerson(name: string, person: Person): void;
  /** Removes a person and their Slack link; whether there was one. */
  dropPerson(name: string): boolean;
  /** Links a Slack user (U…) to a person, replacing either's earlier link. */
  linkSlack(name: string, slackUser: string): void;
  /** The person a Slack user is linked to. */
  personBySlack(slackUser: string): string | undefined;
  /** The Slack user a person is linked to. */
  slackOf(name: string): string | undefined;
  /** Whether a person's jobs post their progress to Slack: on unless they turned it off. */
  notifies(name: string): boolean;
  setNotify(name: string, on: boolean): void;
  /** The DM thread a job posts its progress to, once it has one. */
  slackThread(job: number): SlackThread | undefined;
  putSlackThread(job: number, thread: SlackThread): void;
  /** The job whose thread this is. */
  jobOfThread(channel: string, ts: string): number | undefined;
  project(name: string): Project | undefined;
  /** Every project, by name. */
  projects(): Project[];
  putProject(project: Project): void;
  /** Removes a project; whether there was one. */
  dropProject(name: string): boolean;
  /** The last try at this release on this machine, if any. */
  upgrade(tag: string): Upgrade | undefined;
  /** Keeps a try at a release, replacing any earlier one at the same tag. */
  putUpgrade(upgrade: Upgrade): void;
  addDraft(draft: Omit<Draft, 'id'>): Draft;
  draft(id: number): Draft | undefined;
  draftsIn(state: Draft['state']): Draft[];
  saveDraft(draft: Draft): void;
  /** The project a channel's drafts are for when their message links no issue: /helix project. */
  channelProject(channel: string): string | undefined;
  setChannelProject(channel: string, project: string): void;
  /** Keeps what a person did, as of now. */
  record(who: string, kind: ActivityKind, detail?: Activity['detail']): void;
  /** Everyone's activity, or one person's, newest first. */
  activity(who?: string, limit?: number): Activity[];
  close(): void;
};

export function openStore(file: string): Store {
  mkdirSync(dirname(file), { recursive: true });
  const db = new DatabaseSync(file);
  // helix remove-person and helix upgrade open the table while helix serve has it: wait for each other's writes.
  db.exec('pragma busy_timeout = 5000');
  db.exec('create table if not exists jobs (id integer primary key autoincrement, state text not null, data text not null)');
  db.exec('create table if not exists invites (code_sha256 text primary key, name text not null unique, data text not null)');
  db.exec('create table if not exists people (name text primary key, token_sha256 text not null, data text not null)');
  db.exec('create table if not exists projects (name text primary key, data text not null)');
  db.exec('create table if not exists upgrades (tag text primary key, data text not null)');
  // One Slack user per person and one person per Slack user: the Slack link.
  db.exec('create table if not exists slack_links (slack text primary key, name text not null unique)');
  // The people who turned job notifications off: everyone else gets them.
  db.exec('create table if not exists slack_quiet (name text primary key)');
  // At most one thread per job: every notification for it goes there.
  db.exec('create table if not exists slack_threads (job integer primary key, channel text not null, ts text not null)');
  // Append-only: no one's activity is changed or removed, not even when they leave.
  db.exec('create table if not exists activity (id integer primary key autoincrement, who text not null, at text not null, kind text not null, detail text)');
  db.exec('create index if not exists activity_who on activity (who, id)');
  db.exec('create table if not exists drafts (id integer primary key autoincrement, state text not null, data text not null)');
  db.exec('create table if not exists channel_projects (channel text primary key, project text not null)');
  const data = <T>(r: unknown): T => JSON.parse((r as { data: string }).data) as T;
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
    person: (name) => { const r = db.prepare('select data from people where name = ?').get(name); return r ? data<Person>(r) : undefined; },
    people: () => Object.fromEntries(db.prepare('select name, data from people order by name').all().map((r) => [(r as { name: string }).name, data<Person>(r)])),
    personByToken: (hash) => (db.prepare('select name from people where token_sha256 = ?').get(hash) as { name: string } | undefined)?.name,
    putPerson(name, p) { db.prepare('insert into people (name, token_sha256, data) values (?, ?, ?) on conflict (name) do update set token_sha256 = excluded.token_sha256, data = excluded.data').run(name, p.token_sha256, JSON.stringify(p)); },
    dropPerson(name) {
      db.prepare('delete from slack_links where name = ?').run(name);
      db.prepare('delete from slack_quiet where name = ?').run(name);
      return Number(db.prepare('delete from people where name = ?').run(name).changes) > 0;
    },
    linkSlack(name, slack) {
      db.prepare('delete from slack_links where name = ? or slack = ?').run(name, slack);
      db.prepare('insert into slack_links (slack, name) values (?, ?)').run(slack, name);
    },
    personBySlack: (slack) => (db.prepare('select name from slack_links where slack = ?').get(slack) as { name: string } | undefined)?.name,
    slackOf: (name) => (db.prepare('select slack from slack_links where name = ?').get(name) as { slack: string } | undefined)?.slack,
    notifies: (name) => !db.prepare('select 1 from slack_quiet where name = ?').get(name),
    setNotify(name, on) { db.prepare(on ? 'delete from slack_quiet where name = ?' : 'insert or ignore into slack_quiet (name) values (?)').run(name); },
    slackThread: (job) => db.prepare('select channel, ts from slack_threads where job = ?').get(job) as SlackThread | undefined,
    putSlackThread(job, t) { db.prepare('insert or replace into slack_threads (job, channel, ts) values (?, ?, ?)').run(job, t.channel, t.ts); },
    jobOfThread: (channel, ts) => (db.prepare('select job from slack_threads where channel = ? and ts = ?').get(channel, ts) as { job: number } | undefined)?.job,
    project: (name) => { const r = db.prepare('select data from projects where name = ?').get(name); return r ? data<Project>(r) : undefined; },
    projects: () => db.prepare('select data from projects order by name').all().map((r) => data<Project>(r)),
    putProject(p) { db.prepare('insert into projects (name, data) values (?, ?) on conflict (name) do update set data = excluded.data').run(p.name, JSON.stringify(p)); },
    dropProject: (name) => Number(db.prepare('delete from projects where name = ?').run(name).changes) > 0,
    upgrade: (tag) => { const r = db.prepare('select data from upgrades where tag = ?').get(tag); return r ? data<Upgrade>(r) : undefined; },
    putUpgrade(u) { db.prepare('insert into upgrades (tag, data) values (?, ?) on conflict (tag) do update set data = excluded.data').run(u.tag, JSON.stringify(u)); },
    addDraft(d) {
      const r = db.prepare('insert into drafts (state, data) values (?, ?) returning id').get(d.state, JSON.stringify(d)) as { id: number };
      return { ...d, id: r.id };
    },
    draft: (id) => { const r = db.prepare('select * from drafts where id = ?').get(id) as { id: number; data: string } | undefined; return r ? { ...data<Draft>(r), id: r.id } : undefined; },
    draftsIn: (state) => db.prepare('select * from drafts where state = ? order by id').all(state).map((r) => ({ ...data<Draft>(r), id: (r as { id: number }).id })),
    saveDraft(d) { db.prepare('update drafts set state = ?, data = ? where id = ?').run(d.state, JSON.stringify(d), d.id); },
    channelProject: (channel) => (db.prepare('select project from channel_projects where channel = ?').get(channel) as { project: string } | undefined)?.project,
    setChannelProject(channel, project) { db.prepare('insert or replace into channel_projects (channel, project) values (?, ?)').run(channel, project); },
    record(who, kind, detail) { db.prepare('insert into activity (who, at, kind, detail) values (?, ?, ?, ?)').run(who, new Date().toISOString(), kind, detail ? JSON.stringify(detail) : null); },
    activity: (who, limit = -1) => db.prepare(`select * from activity ${who === undefined ? '' : 'where who = ?'} order by id desc limit ?`).all(...(who === undefined ? [limit] : [who, limit]))
      .map((r) => { const { id, who: w, at, kind, detail } = r as { id: number; who: string; at: string; kind: ActivityKind; detail: string | null }; return { id, who: w, at, kind, ...(detail ? { detail: JSON.parse(detail) as Activity['detail'] } : {}) }; }),
    close: () => db.close(),
  };
}
