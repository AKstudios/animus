// Drafts from Slack (docs/adr/0001, 0003): a message becomes a draft spec in a
// thread. Helix settles the draft's project, fetches what the message links to
// with the person's GitHub sign-in and the bot's token, then runs `animus
// draft` with neither, draft_slots at a time apart from jobs, and posts what
// it wrote with Submit and Discard.
import { spawn } from 'node:child_process';
import { existsSync, mkdirSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';
import { fetchReferences, findLinks, GITHUB_ITEM, GITHUB_VARS, type Fetch } from '../../plugin/src/draft.ts';
import { AnimusError } from '../../plugin/src/proc.ts';
import { loadFactory, resolvePlan } from '../../plugin/src/profiles.ts';
import { parseSpec } from '../../plugin/src/spec.ts';
import { credentialEnv, personEnv, type Config } from './config.ts';
import { commentAs, commentBody, draftComment, specBlock } from './github-comments.ts';
import { freshToken, GITHUB, githubRepo, liveTokenFile, reachableRepos, type GitHubUrls } from './github-app.ts';
import type { Transport } from './slack-api.ts';
import type { Draft, Store } from './store.ts';
import { PLUGIN, type Supervisor } from './supervisor.ts';

/**
 * What Submit asks of a draft until Helix admits it against the project's profile: labels that would run, and a `$ command` under every criterion.
 * shortcut: the profile is not read here; replace with admit once drafts know their project.
 */
function checkDraft(factory: ReturnType<typeof loadFactory>, text: string): void {
  const spec = parseSpec(text, 'draft.md');
  resolvePlan(factory, spec);
  const bare = spec.criteria.flatMap((c, i) => (c.commands.length ? [] : [i + 1]));
  if (bare.length) throw new AnimusError(`draft.md: criterion ${bare.join(', ')} has no check: put a \`$ command\` line under each criterion`);
}

/** The buttons a draft's thread carries: the project picked, and what to do with the draft. */
export const PICK = 'draft_project';
export const SUBMIT = 'submit_draft';
export const DISCARD = 'discard_draft';

/** How a draft session starts, on the project's clone at repoDir, with env: the person's Claude sign-in and nothing of GitHub. base: the commit the base branch is at on GitHub, which a container's clone is checked out at. */
export type DraftLaunch = (draft: Draft, repoDir: string, env: Record<string, string>, base: string) => { command: string; args: string[]; env?: Record<string, string>; cwd?: string };

/** `animus draft` on this machine, as Helix's account. */
const animusDraft: DraftLaunch = (draft, repoDir) => ({
  command: process.execPath,
  args: ['--disable-warning=ExperimentalWarning', join(PLUGIN, 'src', 'cli.ts'), 'draft', draft.folder, '--repo', repoDir],
});

export type Drafts = {
  /** Starts a draft from what a person wrote; what to tell them privately when it cannot start. */
  start(person: string, user: string, channel: string, text: string): Promise<string | undefined>;
  /** A person's `/animus <text>` on an issue of a project: a new draft, or a revision of their open draft on that issue; what to tell them on the issue when it cannot start. */
  github(person: string, on: { project: string; repo: string; number: number; url: string }, text: string): Promise<string | undefined>;
  /** A person's `/animus discard` on an issue: closes the draft there, theirs or, for the owner, anyone's; what to tell them on the issue. */
  githubDiscard(person: string, on: { repo: string; number: number }): Promise<string>;
  /** A person's `/animus submit` on an issue: queues the spec in the draft's latest comment, as it is on GitHub now, as its person's job; what to tell them on the issue. */
  githubSubmit(person: string, on: { repo: string; number: number }, jobs: Pick<Supervisor, 'submit'>): Promise<string>;
  /** The projects a person may submit to: the ones a draft offers them. */
  projects(person: string): Promise<string[]>;
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

/** A Helix without the Slack bot still drafts for GitHub comments; only a Slack draft needs this. */
const refuse = () => Promise.reject(new AnimusError('the Slack bot is not running on this Helix'));
const noSlack = { post: refuse, upload: refuse, update: refuse, deleteFile: refuse, dm: refuse };

export function draftRunner(slack: Pick<Transport, 'post' | 'upload' | 'update' | 'deleteFile' | 'dm'> | undefined, opts: {
  store: Store; config: Config; home: string; launch?: DraftLaunch; github?: GitHubUrls;
  /** Brings the project's clone up to date with its base branch on GitHub, with the person's credentials; the commit it is at. Throws why it cannot, which ends the draft. */
  fresh?: (repoDir: string, env: Record<string, string>) => string;
  /** The bot's token, which fetches Slack files a message links to. */
  slackToken?: string;
  fetch?: Fetch; say?: (line: string) => void;
}): Drafts {
  const { store, config, home } = opts;
  const transport = slack ?? noSlack;
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
  const session = (draft: Draft, repoDir: string, env: Record<string, string>, base: string): Promise<string> => {
    const launched = launch(draft, repoDir, env, base);
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

  /** Says something in a draft's thread, or as a comment on its issue as its person; a comment that cannot be posted is logged, not thrown. */
  const tell = async (draft: Draft, text: string): Promise<void> => {
    if (!draft.github) { await transport.post(draft.channel, text, draft.ts); return; }
    try {
      await commentAs(store, config, github, draft.person, draft.github.repo, draft.github.issue, text);
    } catch (err) { say(`draft ${draft.id}: could not comment on ${draft.github.repo}#${draft.github.issue}: ${(err as Error).message}`); }
  };

  /** Whether a draft is still the one a session started on: Discard or expiry may close it meanwhile. */
  const stillRunning = (draft: Draft) => store.draft(draft.id)?.state === 'running';

  async function run(draft: Draft): Promise<void> {
    const running: Draft = { ...draft, state: 'running' };
    store.saveDraft(running);
    // A revision keeps the draft it revises when its session fails.
    const revising = Boolean(draft.post ?? draft.github?.comment);
    let text: string;
    try {
      const project = store.project(draft.project ?? '');
      if (project?.state !== 'ready') throw new AnimusError(`Helix no longer has the project ${draft.project}`);
      const person = store.person(draft.person);
      if (!person) throw new AnimusError(`${draft.person} is no longer on Helix`);
      const token = await freshToken(store, config, draft.person, github);
      let base = 'HEAD';
      if (opts.fresh) {
        // Helix's own process fetches into the project's clone with the person's token (docs/adr/0003, 0008); the session gets the clone, never the token.
        const theirs = { ...personEnv(person), ...(existsSync(liveTokenFile(draft.person)) ? { ANIMUS_GH_TOKEN_FILE: liveTokenFile(draft.person) } : {}) };
        base = opts.fresh(project.dir, { ...theirs, ...credentialEnv(theirs) });
      }
      // shortcut: a revision reads the references the message's links gave; links in a reply are not fetched.
      if (!existsSync(join(draft.folder, 'sources.json'))) {
        await fetchReferences(readFileSync(join(draft.folder, 'message.md'), 'utf8'), draft.folder, {
          ...(token ? { github: { token, api: github.api } } : {}),
          ...(opts.slackToken ? { slack: { token: opts.slackToken } } : {}),
          ...(opts.fetch ? { fetch: opts.fetch } : {}),
        });
      }
      text = await session(draft, project.dir, { ...withoutGitHub(personEnv(person)), ANIMUS_USER: draft.person }, base);
    } catch (err) {
      if (!stillRunning(draft)) return;
      const reason = (err as Error).message;
      if (revising) {
        store.saveDraft({ ...running, state: 'ready', reason });
        await tell(draft, `The draft could not be revised: ${reason}. It is as it was: ${draft.github ? 'comment `/animus` again, `/animus submit` or `/animus discard`' : 'reply again, Submit or Discard'}.`);
        return;
      }
      store.saveDraft({ ...running, state: 'failed', reason });
      const said = `The draft could not be written: ${reason}`;
      if (draft.github) { await tell(draft, `${said}. Comment \`/animus discard\` to close it.`); return; }
      await transport.post(draft.channel, said, draft.ts, [
        { type: 'section', text: { type: 'mrkdwn', text: said } },
        { type: 'actions', elements: [button(DISCARD, String(draft.id), 'Discard')] },
      ]);
      return;
    }
    if (!stillRunning(draft)) return;
    if (draft.github) {
      // A revision is a new comment, so the issue shows how the draft changed; the latest one is what submit reads.
      let comment: number;
      try {
        comment = await commentAs(store, config, github, draft.person, draft.github.repo, draft.github.issue, draftComment(text));
      } catch (err) {
        // Left running, the draft would count toward the limit and refuse every reply as not posted yet.
        const reason = `the draft comment could not be posted: ${(err as Error).message}`;
        say(`draft ${draft.id}: ${reason}`);
        store.saveDraft({ ...running, state: revising ? 'ready' : 'failed', reason });
        return;
      }
      const { reason: _, ...rest } = running;
      store.saveDraft({ ...rest, state: 'ready', touched: now(), github: { ...draft.github, comment } });
      // The person may be away from GitHub: a person with a Slack link is told there too. A DM that fails is logged, not thrown.
      const user = store.slackOf(draft.person);
      if (slack && user) {
        const link = `https://github.com/${draft.github.repo}/issues/${draft.github.issue}#issuecomment-${comment}`;
        await slack.dm(user).then((channel) => slack.post(channel, `${revising ? 'Revised draft' : 'Draft'} for ${draft.project} is posted on GitHub: ${link}`))
          .catch((err: unknown) => say(`draft ${draft.id}: could not DM ${draft.person} the link: ${(err as Error).message}`));
      }
      return;
    }
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
    await tell(draft, `Waiting for a draft slot: ${ahead} draft${ahead === 1 ? ' is' : 's are'} ahead of this one.`);
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

  const openOf = (person: string) => OPEN.flatMap((s) => store.draftsIn(s)).filter((d) => d.person === person);

  const drafts: Drafts = {
    projects: choices,
    async github(person, on, text) {
      const open = openOf(person);
      // One open draft per person per issue: more text revises it.
      const mine = open.find((d) => d.github?.repo === on.repo && d.github.issue === on.number);
      if (mine) return drafts.reply(person, mine, text);
      if (open.length >= MAX_OPEN) return `You have ${open.length} open drafts: submit or discard one before you start another.`;
      const draft = store.addDraft({ state: 'queued', person, channel: '', ts: '', project: on.project, folder: '', created: now(), touched: now(), github: { repo: on.repo, issue: on.number } });
      draft.folder = join(home, 'drafts', String(draft.id));
      mkdirSync(draft.folder, { recursive: true });
      // The issue's link is a reference like any other: a script fetches it with the person's token before the session starts.
      writeFileSync(join(draft.folder, 'message.md'), `${text}\n\n${on.url}\n`);
      store.saveDraft(draft);
      store.record(person, 'drafted', { draft: draft.id, project: on.project });
      await enqueue(draft);
      return undefined;
    },
    async githubDiscard(person, on) {
      const here = OPEN.flatMap((st) => store.draftsIn(st)).filter((d) => d.github?.repo === on.repo && d.github.issue === on.number);
      const draft = here.find((d) => d.person === person) ?? here[0];
      if (!draft) return 'There is no open draft on this issue.';
      if (draft.person !== person && person !== config.owner) return `Only ${draft.person} or the owner may discard this draft.`;
      close(draft, 'discarded');
      store.record(draft.person, 'draft-discarded', { draft: draft.id });
      return 'Draft discarded.';
    },
    async githubSubmit(person, on, jobs) {
      const here = OPEN.flatMap((st) => store.draftsIn(st)).filter((d) => d.github?.repo === on.repo && d.github.issue === on.number);
      const draft = here.find((d) => d.person === person) ?? here[0];
      if (!draft?.github) return 'There is no open draft on this issue.';
      if (draft.person !== person && person !== config.owner) return `Only ${draft.person} or the owner may submit this draft.`;
      if (draft.state !== 'ready' || !draft.github.comment) return draft.state === 'failed' ? 'This draft could not be written, so there is nothing to submit: `/animus discard` it and start another.' : 'This draft is not posted yet: submit once it is.';
      // The comment as it is now: the person may have edited it by hand.
      const comment = await commentBody(store, config, github, draft.person, on.repo, draft.github.comment);
      const spec = comment === undefined ? undefined : specBlock(comment);
      if (!spec) return 'the latest draft comment has no spec block I can read';
      let job;
      try {
        checkDraft(loadFactory(), spec);
        job = jobs.submit(draft.person, { repo: draft.project!, spec, name: 'draft.md', github: { repo: on.repo, issue: on.number } });
      } catch (err) {
        if (!(err instanceof AnimusError)) throw err;
        return `Not submitted: ${err.message}. Edit the draft comment or comment \`/animus <what to change>\`.`;
      }
      close(draft, 'submitted', { job: job.id });
      return `Submitted as job ${job.id}: ${job.title} (${job.repo}).`;
    },
    async start(person, user, channel, text) {
      const open = openOf(person).length;
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
        await tell(draft, `This draft was discarded after ${EXPIRE_DAYS} days untouched.`);
      }
    },
  };
  return drafts;
}
