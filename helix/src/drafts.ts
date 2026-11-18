// Drafts from Slack (docs/adr/0001, 0003): a message becomes a draft spec in a
// thread. Helix settles the draft's project, fetches what the message links to
// with the person's GitHub sign-in and the bot's token, then runs `animus
// draft` with neither, draft_slots at a time apart from jobs, and posts what
// it wrote with Submit and Discard.
import { spawn } from 'node:child_process';
import { existsSync, mkdirSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';
import { checkDraft, fetchReferences, findLinks, GITHUB_ITEM, GITHUB_VARS, type Fetch } from '../../plugin/src/draft.ts';
import { AnimusError } from '../../plugin/src/proc.ts';
import { loadFactory } from '../../plugin/src/profiles.ts';
import { personEnv, type Config } from './config.ts';
import { freshToken, GITHUB, githubRepo, reachableRepos, type GitHubUrls } from './github-app.ts';
import type { Transport } from './slack-api.ts';
import type { Draft, Store } from './store.ts';
import { PLUGIN, type Supervisor } from './supervisor.ts';

/** The buttons a draft's thread carries: the project picked, and what to do with the draft. */
export const PICK = 'draft_project';
export const SUBMIT = 'submit_draft';
export const DISCARD = 'discard_draft';

/** How a draft session starts, on the project's clone at repoDir, with env: the person's Claude sign-in and nothing of GitHub. */
export type DraftLaunch = (draft: Draft, repoDir: string, env: Record<string, string>) => { command: string; args: string[]; env?: Record<string, string>; cwd?: string };

/** `animus draft` on this machine, as Helix's account. */
const animusDraft: DraftLaunch = (draft, repoDir) => ({
  command: process.execPath,
  args: ['--disable-warning=ExperimentalWarning', join(PLUGIN, 'src', 'cli.ts'), 'draft', draft.folder, '--repo', repoDir],
});

export type Drafts = {
  /** Starts a draft from what a person wrote; what to tell them privately when it cannot start. */
  start(person: string, user: string, channel: string, text: string): Promise<string | undefined>;
  /** A press of a project in a draft's list (PICK); what to tell the presser privately, if anything. */
  pick(person: string, value: string): Promise<string | undefined>;
  /** A reply in an open draft's thread, to revise it with; what to tell the replier privately, if anything. */
  reply(person: string, draft: Draft, text: string): Promise<string | undefined>;
  /** A press of SUBMIT: the draft queued through jobs as its person's job, or why not in its thread. */
  submit(person: string, value: string, jobs: Pick<Supervisor, 'submit'>): Promise<string | undefined>;
  /** A press of DISCARD by the Slack user. */
  discard(person: string, user: string, value: string): Promise<string | undefined>;
  /** Discards each draft untouched for 7 days as of at, saying so in its thread. */
  expire(at?: Date): Promise<void>;
};

/** A draft's states before it is closed, which count toward a person's MAX_OPEN. */
export const OPEN: readonly Draft['state'][] = ['picking', 'queued', 'running', 'ready', 'failed'];
const MAX_OPEN = 3;
const EXPIRE_DAYS = 7;

const button = (action_id: string, value: string, text: string) => ({ type: 'button', action_id, value, text: { type: 'plain_text', text } });

/** Slack shows at most 3,000 characters of a section; the .md file holds all of it. */
const SECTION = 3000;
const draftBlocks = (id: number, text: string) => [
  { type: 'section', text: { type: 'mrkdwn', text: text.length > SECTION ? `${text.slice(0, SECTION - 40)}\n… the rest is in draft.md` : text } },
  { type: 'actions', elements: [button(SUBMIT, String(id), 'Submit'), button(DISCARD, String(id), 'Discard')] },
];

const withoutGitHub = (env: Record<string, string | undefined>): Record<string, string> =>
  Object.fromEntries(Object.entries(env).filter((e): e is [string, string] => e[1] !== undefined && !(GITHUB_VARS as readonly string[]).includes(e[0])));

export function draftRunner(transport: Pick<Transport, 'post' | 'upload' | 'update' | 'deleteFile'>, opts: {
  store: Store; config: Config; home: string; launch?: DraftLaunch; github?: GitHubUrls;
  /** The bot's token, which fetches Slack files a message links to. */
  slackToken?: string;
  fetch?: Fetch; say?: (line: string) => void;
}): Drafts {
  const { store, config, home } = opts;
  const launch = opts.launch ?? animusDraft;
  const github = opts.github ?? GITHUB;
  const say = opts.say ?? (() => {});
  const now = () => new Date().toISOString();
  const ready = () => store.projects().filter((p) => p.state === 'ready');

  /** The project of the first GitHub issue or pull request the message links that Helix has, else the channel's default. */
  const projectFor = (text: string, channel: string): string | undefined => {
    for (const url of findLinks(text)) {
      const m = GITHUB_ITEM.exec(url);
      const linked = m && ready().find((p) => githubRepo(p.url)?.toLowerCase() === `${m[1]}/${m[2]}`.toLowerCase());
      if (linked) return linked.name;
    }
    const preset = store.channelProject(channel);
    return ready().some((p) => p.name === preset) ? preset : undefined;
  };

  /** The projects a person may pick: on a Helix with the GitHub App, those it lets them push to; else every one. */
  const choices = async (person: string): Promise<string[]> => {
    const token = await freshToken(store, config, person, github);
    if (!token) return ready().map((p) => p.name);
    const reach = await reachableRepos(token, github);
    const may = new Set(reach.repos.filter((r) => !reach.missing[r.toLowerCase()]).map((r) => r.toLowerCase()));
    return ready().filter((p) => may.has(githubRepo(p.url)?.toLowerCase() ?? '')).map((p) => p.name);
  };

  /** Runs the draft session; draft.md as it wrote it, or why there is none. */
  const session = (draft: Draft, repoDir: string, env: Record<string, string>): Promise<string> => {
    const launched = launch(draft, repoDir, env);
    // Helix's own GitHub token, if its account has one, stays out too.
    const child = spawn(launched.command, launched.args, { cwd: launched.cwd ?? repoDir, env: { ...withoutGitHub(process.env), ...env, ...launched.env }, stdio: ['ignore', 'ignore', 'pipe'] });
    let err = '';
    child.stderr.on('data', (c: Buffer) => { err += c.toString(); });
    return new Promise((resolve, reject) => {
      child.on('error', (e) => reject(new AnimusError(`animus draft did not start: ${e.message}`)));
      child.on('close', (code) => {
        const file = join(draft.folder, 'draft.md');
        if (code === 0 && existsSync(file)) return resolve(readFileSync(file, 'utf8'));
        reject(new AnimusError(err.trim().split('\n').pop()?.replace(/^animus: /, '') || `animus draft ended with exit ${code}`));
      });
    });
  };

  /** Whether a draft is still the one a session started on: Discard or expiry may close it meanwhile. */
  const stillRunning = (draft: Draft) => store.draft(draft.id)?.state === 'running';

  async function run(draft: Draft): Promise<void> {
    const running: Draft = { ...draft, state: 'running' };
    store.saveDraft(running);
    // A revision keeps the draft it revises when its session fails.
    const revising = Boolean(draft.post);
    let text: string;
    try {
      const project = store.project(draft.project ?? '');
      if (project?.state !== 'ready') throw new AnimusError(`Helix no longer has the project ${draft.project}`);
      const person = store.person(draft.person);
      if (!person) throw new AnimusError(`${draft.person} is no longer on Helix`);
      // shortcut: a revision reads the references the message's links gave; links in a reply are not fetched.
      if (!existsSync(join(draft.folder, 'sources.json'))) {
        const token = await freshToken(store, config, draft.person, github);
        await fetchReferences(readFileSync(join(draft.folder, 'message.md'), 'utf8'), draft.folder, {
          ...(token ? { github: { token, api: github.api } } : {}),
          ...(opts.slackToken ? { slack: { token: opts.slackToken } } : {}),
          ...(opts.fetch ? { fetch: opts.fetch } : {}),
        });
      }
      text = await session(draft, project.dir, { ...withoutGitHub(personEnv(person)), ANIMUS_USER: draft.person });
    } catch (err) {
      if (!stillRunning(draft)) return;
      const reason = (err as Error).message;
      if (revising) {
        store.saveDraft({ ...running, state: 'ready', reason });
        await transport.post(draft.channel, `The draft could not be revised: ${reason}. It is as it was: reply again, Submit or Discard.`, draft.ts);
        return;
      }
      store.saveDraft({ ...running, state: 'failed', reason });
      const said = `The draft could not be written: ${reason}`;
      await transport.post(draft.channel, said, draft.ts, [
        { type: 'section', text: { type: 'mrkdwn', text: said } },
        { type: 'actions', elements: [button(DISCARD, String(draft.id), 'Discard')] },
      ]);
      return;
    }
    if (!stillRunning(draft)) return;
    const blocks = draftBlocks(draft.id, text);
    // A revision replaces the draft's post and its file, so the thread holds one draft.
    const post = draft.post ?? await transport.post(draft.channel, text, draft.ts, blocks);
    if (draft.post) await transport.update(draft.channel, post, text, blocks);
    const { reason: _, ...rest } = running;
    store.saveDraft({ ...rest, state: 'ready', touched: now(), post });
    const file = await transport.upload(draft.channel, draft.ts, 'draft.md', text);
    if (draft.file) await transport.deleteFile(draft.file);
    const saved = store.draft(draft.id);
    if (saved) store.saveDraft({ ...saved, file });
  }

  const running = new Set<number>();
  function tick(): void {
    const queued = store.draftsIn('queued');
    while (running.size < (config.draft_slots ?? 1) && queued.length) {
      const draft = queued.shift()!;
      running.add(draft.id);
      run(draft).catch((err: unknown) => say(`draft ${draft.id}: ${(err as Error).message}`)).finally(() => { running.delete(draft.id); tick(); });
    }
  }

  /** Starts a queued draft if a slot is free, or says in its thread how many are ahead of it. */
  async function enqueue(draft: Draft): Promise<void> {
    tick();
    if (store.draft(draft.id)?.state !== 'queued') return;
    const ahead = running.size + store.draftsIn('queued').filter((d) => d.id < draft.id).length;
    await transport.post(draft.channel, `Waiting for a draft slot: ${ahead} draft${ahead === 1 ? ' is' : 's are'} ahead of this one.`, draft.ts);
  }

  /** Closes a draft as submitted or discarded: nothing of it stays but its row. */
  function close(draft: Draft, state: 'submitted' | 'discarded', more: Partial<Draft> = {}): void {
    store.saveDraft({ ...draft, ...more, state, touched: now() });
    rmSync(draft.folder, { recursive: true, force: true });
  }

  /** The draft a button names, if this person may press it; else what to tell them. */
  const pressed = (person: string, value: string, verb: string): Draft | string => {
    const draft = store.draft(Number(value));
    if (!draft) return `There is no draft ${value}.`;
    if (draft.person !== person) return `Only ${draft.person} ${verb} this draft.`;
    return draft;
  };

  // Running when Helix stopped: started again from its message.
  for (const draft of store.draftsIn('running')) store.saveDraft({ ...draft, state: 'queued' });
  tick();

  return {
    async start(person, user, channel, text) {
      const open = OPEN.flatMap((s) => store.draftsIn(s)).filter((d) => d.person === person).length;
      if (open >= MAX_OPEN) return `You have ${open} open drafts: submit or discard one before you start another.`;
      const project = projectFor(text, channel);
      const names = project ? [] : await choices(person);
      if (!project && !names.length) return 'Helix has no project you may push to, so there is nothing to draft for: add one with animus project add, or ask its owner to install the GitHub App on yours.';
      let ts: string;
      try {
        ts = await transport.post(channel, `Drafting a spec${project ? ` for ${project}` : ''} from <@${user}>'s message: ${text}`);
      } catch (err) {
        return `The draft's thread could not be posted here (${(err as Error).message}): add me to this channel, or draft in our DM.`;
      }
      const draft = store.addDraft({ state: project ? 'queued' : 'picking', person, channel, ts, ...(project ? { project } : {}), folder: '', created: now(), touched: now() });
      draft.folder = join(home, 'drafts', String(draft.id));
      mkdirSync(draft.folder, { recursive: true });
      writeFileSync(join(draft.folder, 'message.md'), `${text}\n`);
      store.saveDraft(draft);
      store.record(person, 'drafted', { draft: draft.id, ...(project ? { project } : {}) });
      if (project) { await enqueue(draft); return undefined; }
      // shortcut: Slack takes 25 buttons in a row; a picker menu when a person has more projects than that.
      await transport.post(channel, 'Which project is this for?', ts, [
        { type: 'section', text: { type: 'mrkdwn', text: 'Which project is this for?' } },
        { type: 'actions', elements: names.slice(0, 25).map((name) => button(PICK, `${draft.id} ${name}`, name)) },
      ]);
      return undefined;
    },
    async pick(person, value) {
      const [id, name = ''] = value.split(' ');
      const draft = store.draft(Number(id));
      if (!draft) return `There is no draft ${id}.`;
      if (draft.person !== person) return `Only ${draft.person} picks this draft's project.`;
      if (draft.state !== 'picking') return `This draft is for ${draft.project ?? 'no project'} already.`;
      if (store.project(name)?.state !== 'ready') return `Helix no longer has the project ${name}.`;
      store.saveDraft({ ...draft, state: 'queued', project: name, touched: now() });
      await transport.post(draft.channel, `Drafting for ${name}.`, draft.ts);
      await enqueue(draft);
      return undefined;
    },
    async reply(person, draft, text) {
      if (draft.person !== person) return `Only ${draft.person} revises this draft.`;
      if (draft.state === 'failed') return 'This draft could not be written, so there is nothing to revise: discard it and start another.';
      if (draft.state !== 'ready') return 'This draft is not posted yet: reply once it is.';
      if (!text) return 'Reply with what to change in the draft.';
      writeFileSync(join(draft.folder, 'reply.md'), `${text}\n`);
      store.saveDraft({ ...draft, state: 'queued', touched: now() });
      store.record(person, 'draft-revised', { draft: draft.id });
      await enqueue(draft);
      return undefined;
    },
    async submit(person, value, jobs) {
      const draft = pressed(person, value, 'submits');
      if (typeof draft === 'string') return draft;
      if (draft.state !== 'ready') return draft.state === 'submitted' ? `This draft is job ${draft.job} already.` : `This draft is ${draft.state}: only a posted draft is submitted.`;
      let job;
      try {
        const text = readFileSync(join(draft.folder, 'draft.md'), 'utf8');
        checkDraft(loadFactory(), text);
        job = jobs.submit(person, { repo: draft.project!, spec: text, name: 'draft.md' });
      } catch (err) {
        if (!(err instanceof AnimusError)) throw err;
        await transport.post(draft.channel, `Not submitted: ${err.message}. Reply with what to change.`, draft.ts);
        return undefined;
      }
      // The job's progress posts here, where the draft was.
      store.putSlackThread(job.id, { channel: draft.channel, ts: draft.ts });
      close(draft, 'submitted', { job: job.id });
      await transport.post(draft.channel, `Submitted as job ${job.id}: ${job.title} (${job.repo}). Its progress posts in this thread.`, draft.ts);
      return undefined;
    },
    async discard(person, user, value) {
      const draft = pressed(person, value, 'discards');
      if (typeof draft === 'string') return draft;
      if (!OPEN.includes(draft.state)) return `This draft is ${draft.state} already.`;
      close(draft, 'discarded');
      store.record(person, 'draft-discarded', { draft: draft.id });
      await transport.post(draft.channel, `Draft discarded by <@${user}>.`, draft.ts);
      return undefined;
    },
    async expire(at = new Date()) {
      const before = at.getTime() - EXPIRE_DAYS * 24 * 60 * 60 * 1000;
      // A queued or running draft is Helix's to finish, so its clock starts again when it is posted.
      for (const draft of (['picking', 'ready', 'failed'] as const).flatMap((s) => store.draftsIn(s))) {
        if (Date.parse(draft.touched) > before) continue;
        close(draft, 'discarded');
        await transport.post(draft.channel, `This draft was discarded after ${EXPIRE_DAYS} days untouched.`, draft.ts);
      }
    },
  };
}
