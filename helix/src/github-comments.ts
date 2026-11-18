// /animus comments on GitHub (docs/adr/0001, 0006): Helix reads each project's
// new issue and pull request comments about once a minute with a person's
// token, as it lists open PRs, and opens no port. A comment is a command only
// from a person on this Helix; Animus answers as that person, with their user
// token, and marks everything it posts so it never acts on its own comments.
import { AnimusError } from '../../plugin/src/proc.ts';
import { personEnv, type Config } from './config.ts';
import { freshToken, GITHUB, githubRepo, type GitHubUrls } from './github-app.ts';
import type { Drafts } from './drafts.ts';
import type { Project, Store } from './store.ts';
import type { Supervisor } from './supervisor.ts';

/** Hidden in every comment Animus posts: a comment that carries it is never read as a command. */
export const MARKER = '<!-- animus -->';

/** A comment more than this old when Helix first sees it is answered, not acted on. */
const TOO_OLD_MS = 24 * 60 * 60 * 1000;

/** The part of a GitHub issue comment this needs; html_url says issue or pull request. */
export type IssueComment = { id: number; body: string; user: { login: string }; created_at: string; html_url: string };

async function gh(method: string, path: string, token: string, urls: GitHubUrls, body?: unknown): Promise<unknown> {
  let res: Response;
  try {
    res = await fetch(`${urls.api}${path}`, {
      method,
      headers: { accept: 'application/vnd.github+json', authorization: `Bearer ${token}`, 'x-github-api-version': '2022-11-28', 'user-agent': 'animus-helix', ...(body ? { 'content-type': 'application/json' } : {}) },
      ...(body ? { body: JSON.stringify(body) } : {}),
      signal: AbortSignal.timeout(15_000),
    });
  } catch (err) { throw new AnimusError(`GitHub could not be reached: ${(err as Error).message}`); }
  if (!res.ok) throw Object.assign(new AnimusError(`GitHub refused ${method} ${path}: HTTP ${res.status}`), { status: res.status });
  return res.json().catch(() => ({}));
}

/** A comment's body as it is on GitHub now, hand edits included; undefined when it is gone. */
export async function commentBody(store: Store, config: Pick<Config, 'github'>, urls: GitHubUrls, person: string, repo: string, id: number): Promise<string | undefined> {
  const token = await tokenOf(store, config, person, urls);
  if (!token) throw new AnimusError(`${person} has no GitHub token to read comments with`);
  try {
    return ((await gh('GET', `/repos/${repo}/issues/comments/${id}`, token, urls)) as { body?: string }).body ?? '';
  } catch (err) {
    if ((err as { status?: number }).status === 404) return undefined;
    throw err;
  }
}

/** The spec in a draft comment: the first closed `markdown` fence, or undefined when there is none or it is empty. GitHub may save line breaks as CRLF. */
export function specBlock(comment: string): string | undefined {
  const lines = comment.split(/\r?\n/);
  const open = lines.findIndex((l) => /^ {0,3}`{3,}markdown\s*$/.test(l));
  if (open < 0) return undefined;
  const ticks = /`+/.exec(lines[open]!)![0].length;
  const close = lines.findIndex((l, i) => i > open && new RegExp(`^ {0,3}\`{${ticks},}\\s*$`).test(l));
  const spec = close < 0 ? '' : lines.slice(open + 1, close).join('\n').trim();
  return spec ? `${spec}\n` : undefined;
}

/** The person's GitHub token, renewed when due: their sign-in through the app, else the one they pasted. */
export async function tokenOf(store: Store, config: Pick<Config, 'github'>, person: string, urls: GitHubUrls = GITHUB): Promise<string | undefined> {
  const env = personEnv(store.person(person));
  return (await freshToken(store, config, person, urls)) ?? env.GH_TOKEN ?? env.GITHUB_TOKEN;
}

/** Comments on an issue or pull request as the person, marked as Animus's; the comment's id. */
export async function commentAs(store: Store, config: Pick<Config, 'github'>, urls: GitHubUrls, person: string, repo: string, issue: number, text: string): Promise<number> {
  const token = await tokenOf(store, config, person, urls);
  if (!token) throw new AnimusError(`${person} has no GitHub token to comment with`);
  const made = await gh('POST', `/repos/${repo}/issues/${issue}/comments`, token, urls, { body: `${text}\n\n${MARKER}` }) as { id: number };
  return made.id;
}

/** Every comment on the repository updated since, oldest created first. */
async function listComments(repo: string, since: string, token: string, urls: GitHubUrls): Promise<IssueComment[]> {
  const all: IssueComment[] = [];
  for (let page = 1; ; page++) {
    const got = await gh('GET', `/repos/${repo}/issues/comments?since=${encodeURIComponent(since)}&sort=created&direction=asc&per_page=100&page=${page}`, token, urls) as IssueComment[];
    all.push(...got);
    if (got.length < 100) return all;
  }
}

/** A draft as a comment: a line saying Animus drafted it, the spec in a `markdown` fence (longer than any run of backticks in it), and the replies Animus understands. */
export function draftComment(spec: string): string {
  const fence = '`'.repeat(Math.max(3, ...(spec.match(/`+/g) ?? []).map((r) => r.length + 1)));
  return [
    'Animus drafted this spec from the issue and your comment. Edit this comment to change it by hand.',
    '', `${fence}markdown`, spec.trimEnd(), fence, '',
    'Reply with a comment:',
    '- `/animus <what to change>` to revise it',
    '- `/animus submit` to queue it as a job',
    '- `/animus discard` to drop it',
  ].join('\n');
}

const USAGE ='Say what you want after `/animus`, as in `/animus add a login page`.';
// shortcut: answer, cancel and fix are read but not acted on until their commands exist; they are not draft text.
const WORDS = ['submit', 'discard', 'answer', 'cancel', 'fix'];

/**
 * Reads the new comments of every ready project on GitHub. The first read of
 * a project starts its position at now, so nothing said before Helix watched
 * is acted on; `since` goes by update time, so a comment counts only when it
 * was created at or after the position and is not among those handled.
 */
export function commentWatcher(opts: {
  store: Store; config: Pick<Config, 'github'>; drafts: Pick<Drafts, 'github' | 'githubDiscard' | 'githubSubmit'>; jobs: Pick<Supervisor, 'submit'>;
  github?: GitHubUrls; say?: (line: string) => void; now?: () => number;
}): { poll(): Promise<void> } {
  const { store, config, drafts, jobs } = opts;
  const urls = opts.github ?? GITHUB;
  const say = opts.say ?? (() => {});
  const now = opts.now ?? Date.now;

  /** The comments updated since, read with the token of whoever added the project, else of another person; a failed read is logged and the next person tried. */
  async function read(project: Project, repo: string, since: string): Promise<IssueComment[] | undefined> {
    const people = [...new Set([...(project.added_by ? [project.added_by] : []), ...Object.keys(store.people())])].filter((n) => store.person(n));
    for (const person of people) {
      try {
        const token = await tokenOf(store, config, person, urls);
        if (token) return await listComments(repo, since, token, urls);
      } catch (err) { say(`comments on ${repo}: ${person}'s token could not read them: ${(err as Error).message}`); }
    }
    return undefined;
  }

  async function handle(project: Project, repo: string, c: IssueComment): Promise<void> {
    const login = c.user.login.toLowerCase();
    const person = Object.entries(store.people()).find(([, p]) => p.github?.toLowerCase() === login)?.[0];
    const body = c.body.trimStart();
    if (!person || c.body.includes(MARKER) || !/^\/animus(\s|$)/.test(body)) return;
    const m = /\/(issues|pull)\/(\d+)#/.exec(c.html_url);
    if (!m) return;
    const number = Number(m[2]);
    const reply = (text: string) => commentAs(store, config, urls, person, repo, number, text);
    if (now() - Date.parse(c.created_at) > TOO_OLD_MS) { await reply('This `/animus` comment is too old to act on: Helix saw it more than a day after it was written. Comment again if you still want it.'); return; }
    if (m[1] === 'pull') { await reply('`fix` on pull requests is not available yet: comment `/animus` on the issue to draft a spec.'); return; }
    const text = body.slice('/animus'.length).trim();
    const word = text.split(/\s/)[0]!.toLowerCase();
    if (word === 'discard') { await reply(await drafts.githubDiscard(person, { repo, number })); return; }
    if (word === 'submit') { await reply(await drafts.githubSubmit(person, { repo, number }, jobs)); return; }
    if (WORDS.includes(word)) return;
    const token = await tokenOf(store, config, person, urls);
    // The reaction says "seen"; a refusal of it does not stop the draft.
    if (token) await gh('POST', `/repos/${repo}/issues/comments/${c.id}/reactions`, token, urls, { content: 'eyes' }).catch((err: unknown) => say(`comment ${c.id} on ${repo}: ${(err as Error).message}`));
    const said = text ? await drafts.github(person, { project: project.name, repo, number, url: `https://github.com/${repo}/issues/${number}` }, text) : USAGE;
    if (said) await reply(said);
  }

  let polling = false;
  return {
    async poll() {
      if (polling) return;
      polling = true;
      try {
        for (const project of store.projects().filter((p) => p.state === 'ready')) {
          const repo = githubRepo(project.url);
          if (!repo) continue;
          let watch = store.commentWatch(project.name);
          if (!watch) { watch = { position: new Date(now()).toISOString(), handled: [] }; store.setCommentWatch(project.name, watch); }
          const comments = await read(project, repo, watch.position);
          if (!comments) continue;
          const at = (c: IssueComment) => Date.parse(c.created_at);
          const fresh = comments.filter((c) => at(c) >= Date.parse(watch!.position) && !watch!.handled.includes(c.id)).sort((a, b) => at(a) - at(b) || a.id - b.id);
          for (const c of fresh) {
            watch = at(c) > Date.parse(watch.position) ? { position: c.created_at, handled: [c.id] } : { ...watch, handled: [...watch.handled, c.id] };
            // Kept before it is acted on, so a comment that fails is not tried again every minute.
            store.setCommentWatch(project.name, watch);
            await handle(project, repo, c).catch((err: unknown) => say(`comment ${c.id} on ${repo}: ${(err as Error).message}`));
          }
        }
      } finally { polling = false; }
    },
  };
}
