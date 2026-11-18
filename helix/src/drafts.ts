// Drafts from Slack (docs/adr/0001, 0003): a message becomes a draft spec in a
// thread. Helix settles the draft's project, fetches what the message links to
// with the person's GitHub sign-in and the bot's token, then runs `animus
// draft` with neither, draft_slots at a time apart from jobs, and posts what
// it wrote with Submit and Discard.
import { spawn } from 'node:child_process';
import { existsSync, mkdirSync, readFileSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';
import { fetchReferences, findLinks, GITHUB_ITEM, GITHUB_VARS, type Fetch } from '../../plugin/src/draft.ts';
import { AnimusError } from '../../plugin/src/proc.ts';
import { personEnv, type Config } from './config.ts';
import { freshToken, GITHUB, githubRepo, reachableRepos, type GitHubUrls } from './github-app.ts';
import type { Transport } from './slack-api.ts';
import type { Draft, Store } from './store.ts';
import { PLUGIN } from './supervisor.ts';

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
};

const button = (action_id: string, value: string, text: string) => ({ type: 'button', action_id, value, text: { type: 'plain_text', text } });

/** Slack shows at most 3,000 characters of a section; the .md file holds all of it. */
const SECTION = 3000;
const draftBlocks = (id: number, text: string) => [
  { type: 'section', text: { type: 'mrkdwn', text: text.length > SECTION ? `${text.slice(0, SECTION - 40)}\n… the rest is in draft.md` : text } },
  { type: 'actions', elements: [button(SUBMIT, String(id), 'Submit'), button(DISCARD, String(id), 'Discard')] },
];

const withoutGitHub = (env: Record<string, string | undefined>): Record<string, string> =>
  Object.fromEntries(Object.entries(env).filter((e): e is [string, string] => e[1] !== undefined && !(GITHUB_VARS as readonly string[]).includes(e[0])));

export function draftRunner(transport: Pick<Transport, 'post' | 'upload'>, opts: {
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

  async function run(draft: Draft): Promise<void> {
    const running: Draft = { ...draft, state: 'running' };
    store.saveDraft(running);
    let text: string;
    try {
      const project = store.project(draft.project ?? '');
      if (project?.state !== 'ready') throw new AnimusError(`Helix no longer has the project ${draft.project}`);
      const person = store.person(draft.person);
      if (!person) throw new AnimusError(`${draft.person} is no longer on Helix`);
      const token = await freshToken(store, config, draft.person, github);
      await fetchReferences(readFileSync(join(draft.folder, 'message.md'), 'utf8'), draft.folder, {
        ...(token ? { github: { token, api: github.api } } : {}),
        ...(opts.slackToken ? { slack: { token: opts.slackToken } } : {}),
        ...(opts.fetch ? { fetch: opts.fetch } : {}),
      });
      text = await session(draft, project.dir, { ...withoutGitHub(personEnv(person)), ANIMUS_USER: draft.person });
    } catch (err) {
      const reason = (err as Error).message;
      store.saveDraft({ ...running, state: 'failed', reason });
      await transport.post(draft.channel, `The draft could not be written: ${reason}`, draft.ts);
      return;
    }
    store.saveDraft({ ...running, state: 'ready', touched: now() });
    await transport.post(draft.channel, text, draft.ts, draftBlocks(draft.id, text));
    await transport.upload(draft.channel, draft.ts, 'draft.md', text);
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

  // Running when Helix stopped: started again from its message.
  for (const draft of store.draftsIn('running')) store.saveDraft({ ...draft, state: 'queued' });
  tick();

  return {
    async start(person, user, channel, text) {
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
      if (project) { tick(); return undefined; }
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
      tick();
      return undefined;
    },
  };
}
