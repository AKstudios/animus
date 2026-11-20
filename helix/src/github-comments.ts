// /animus comments on GitHub (docs/adr/0001, 0006): Helix reads each project's
// new issue and pull request comments about once a minute with a person's
// token, as it lists open PRs, and opens no port. A comment is a command only
// from a person on this Helix; Animus answers as that person, with their user
// token, and marks everything it posts so it never acts on its own comments.
import { AnimusError } from '../../plugin/src/proc.ts';
import type { Finding } from './check.ts';
import { personEnv, type Config } from './config.ts';
import { freshToken, GITHUB, githubRepo, type GitHubUrls } from './github-app.ts';
import type { Drafts } from './drafts.ts';
import { isOwner } from './owner.ts';
import type { HelixJob, Project, Store } from './store.ts';
import type { Supervisor } from './supervisor.ts';

/** Hidden in every comment Animus posts: a comment that carries it is never read as a command. */
export const MARKER = '<!-- animus -->';

/** A comment more than this old when Helix first sees it is answered, not acted on. */
const TOO_OLD_MS = 24 * 60 * 60 * 1000;

/** The part of a GitHub issue comment this needs; html_url says issue or pull request. */
export type IssueComment = { id: number; body: string; user: { login: string }; created_at: string; html_url: string };

export async function gh(method: string, path: string, token: string, urls: GitHubUrls, body?: unknown): Promise<unknown> {
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

/** A pull request as GitHub has it now, read with the person's token; undefined when GitHub has none by that number. author is the login that opened it. */
export async function readPull(store: Store, config: Pick<Config, 'github'>, urls: GitHubUrls, person: string, repo: string, number: number): Promise<{ url: string; title: string; body: string; author: string; state: string; merged: boolean } | undefined> {
  const token = await tokenOf(store, config, person, urls);
  if (!token) throw new AnimusError(`${person} has no GitHub token to read pull request ${number} with`);
  try {
    const p = await gh('GET', `/repos/${repo}/pulls/${number}`, token, urls) as { html_url: string; title: string; body?: string | null; user: { login: string }; state: string; merged?: boolean };
    return { url: p.html_url, title: p.title, body: p.body ?? '', author: p.user.login, state: p.state, merged: Boolean(p.merged) };
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

/** Every item of a GitHub list, page by page; path already has its query. */
async function pages<T>(path: string, token: string, urls: GitHubUrls): Promise<T[]> {
  const all: T[] = [];
  for (let page = 1; ; page++) {
    const got = await gh('GET', `${path}&per_page=100&page=${page}`, token, urls) as T[];
    all.push(...got);
    if (got.length < 100) return all;
  }
}

/** Every comment on the repository updated since, oldest created first. */
const listComments = (repo: string, since: string, token: string, urls: GitHubUrls) =>
  pages<IssueComment>(`/repos/${repo}/issues/comments?since=${encodeURIComponent(since)}&sort=created&direction=asc`, token, urls);

/**
 * A pull request's reviews and inline comments made after since by people on this Helix (by GitHub login, as /animus comments are),
 * as a draft's references are kept: one file each, by name; left_out counts those by anyone else, which no session is shown.
 */
async function reviewsSince(store: Store, repo: string, pull: number, since: string, token: string, urls: GitHubUrls): Promise<{ references: { name: string; text: string }[]; left_out: number }> {
  type Review = { id: number; user: { login: string }; body?: string; submitted_at?: string };
  type Inline = { id: number; user: { login: string }; body: string; path: string; line?: number; created_at: string };
  const after = (t?: string) => Boolean(t) && Date.parse(t!) > Date.parse(since);
  const ours = new Set(Object.values(store.people()).flatMap((p) => p.github ? [p.github.toLowerCase()] : []));
  const isOurs = (c: { user: { login: string } }) => ours.has(c.user.login.toLowerCase());
  const reviews = (await pages<Review>(`/repos/${repo}/pulls/${pull}/reviews?`, token, urls)).filter((r) => r.body?.trim() && after(r.submitted_at));
  const inline = (await pages<Inline>(`/repos/${repo}/pulls/${pull}/comments?`, token, urls)).filter((c) => after(c.created_at));
  return {
    references: [
      ...reviews.filter(isOurs).map((r) => ({ name: `review-${r.id}.md`, text: `Review by ${r.user.login}:\n\n${r.body!.trim()}\n` })),
      ...inline.filter(isOurs).map((c) => ({ name: `comment-${c.id}.md`, text: `${c.user.login} on ${c.path}${c.line ? ` line ${c.line}` : ''}:\n\n${c.body.trim()}\n` })),
    ],
    left_out: [...reviews, ...inline].filter((c) => !isOurs(c)).length,
  };
}

/** Who may read a project's comments, in the order their tokens are tried: whoever added it, then everyone else. */
const readers = (store: Store, project: Project) =>
  [...new Set([...(project.added_by ? [project.added_by] : []), ...Object.keys(store.people())])].filter((n) => store.person(n));

/**
 * What `helix check` says of each GitHub project's comments: whether any
 * person's token can read them, the way the watcher does. A project that
 * none can read is never watched, so a `/animus` there goes unanswered.
 */
export async function checkComments(store: Store, config: Pick<Config, 'github'>, urls: GitHubUrls = GITHUB, now = Date.now()): Promise<Finding[]> {
  const findings: Finding[] = [];
  for (const project of store.projects().filter((p) => p.state === 'ready')) {
    const repo = githubRepo(project.url);
    if (!repo) continue;
    const what = `comments on ${repo}`;
    const why: string[] = [];
    for (const person of readers(store, project)) {
      try {
        const token = await tokenOf(store, config, person, urls);
        if (!token) { why.push(`${person} has no GitHub token`); continue; }
        await listComments(repo, new Date(now).toISOString(), token, urls);
        findings.push({ what, ok: true, detail: `${person}'s token reads them` });
        break;
      } catch (err) { why.push(`${person}: ${(err as Error).message}`); }
    }
    if (!findings.some((f) => f.what === what)) findings.push({ what, ok: false, detail: `no person's GitHub token can read them, so /animus there goes unanswered (${why.join('; ') || 'no one on this Helix'})` });
  }
  return findings;
}

/** A draft as a comment: a line saying Animus drafted it, the spec in a `markdown` fence (longer than any run of backticks in it), what Animus read of it against the project as a `text` fence after it, and the replies Animus understands. */
export function draftComment(spec: string, summary?: string): string {
  const fenceOf = (text: string) => '`'.repeat(Math.max(3, ...(text.match(/`+/g) ?? []).map((r) => r.length + 1)));
  const fence = fenceOf(spec);
  return [
    'Animus drafted this spec from the issue and your comment. Edit this comment to change it by hand.',
    '', `${fence}markdown`, spec.trimEnd(), fence, '',
    ...(summary ? ['Animus read it against the project:', '', `${fenceOf(summary)}text`, summary, fenceOf(summary), ''] : []),
    'Reply with a comment:',
    '- `/animus <what to change>` to revise it',
    '- `/animus submit` to queue it as a job',
    '- `/animus discard` to drop it',
  ].join('\n');
}

/**
 * What a job submitted from an issue, or a fix from a pull request, says there when it ends; nothing for any other
 * step, which neither is told. A fix that pushed says what it changed, its cost and its page at url.
 */
function milestone(job: HelixJob, url?: string): string | undefined {
  const text = step(job, url);
  const n = job.left_out;
  return text && n ? `${text}\nIt left out ${n} ${n === 1 ? 'review or comment' : 'reviews and comments'} by people not on this Helix.` : text;
}

function step(job: HelixJob, url?: string): string | undefined {
  if (job.state !== 'ended') return undefined;
  if (job.outcome === 'needs-input') return `Job ${job.id} needs input: ${job.question}\nReply with a comment: \`/animus answer <your answer>\``;
  if (job.ask && job.outcome === 'pr') return `Job ${job.id} pushed to this pull request: ${job.ask}\nIt cost $${(job.cost_usd ?? 0).toFixed(2)}.${url ? ` Its page: ${url.replace(/\/+$/, '')}/jobs/${job.id}` : ''}`;
  if (job.outcome === 'pr' && job.pr) return `Job ${job.id} opened a pull request: ${job.pr}`;
  // A job that failed after its fix rounds still publishes its report as a draft PR (outcome draft-pr): that is a failure, with the link. A fix's is the pull request it is on.
  return `Job ${job.id} ${job.outcome === 'refused' ? 'was refused' : 'failed'}: ${job.reason ?? job.outcome}${job.pr && !job.ask ? `. The failure report: ${job.pr}` : ''}`;
}

/**
 * The supervisor's notify for the issue a job was submitted from, or the pull
 * request a fix was asked on: Animus comments there, as the job's person, when
 * the job opens its pull request (a fix: pushes), fails or needs input.
 * Comments go out one at a time, in the order they came.
 */
export function githubNotifier(opts: { store: Store; config: Pick<Config, 'github' | 'url'>; github?: GitHubUrls; say?: (line: string) => void }): (job: HelixJob) => void {
  let last = Promise.resolve();
  return (job) => {
    const text = job.github && milestone(job, opts.config.url);
    if (!job.github || !text) return;
    const { repo, issue } = job.github;
    last = last.then(() => commentAs(opts.store, opts.config, opts.github ?? GITHUB, job.person, repo, issue, text)).then(() => {})
      .catch((err: unknown) => opts.say?.(`job ${job.id}: could not comment on ${repo}#${issue}: ${(err as Error).message}`));
  };
}

const USAGE ='Say what you want after `/animus`, as in `/animus add a login page`.';
const FIX_USAGE = 'Comment `/animus <what to change>` to have Animus change this pull request; it works on an open pull request an Animus job opened.';
// fix is for pull requests; on an issue it is not draft text.
const WORDS = ['submit', 'discard', 'answer', 'cancel', 'fix'];

/**
 * Reads the new comments of every ready project on GitHub. The first read of
 * a project starts its position at now, so nothing said before Helix watched
 * is acted on; `since` goes by update time, so a comment counts only when it
 * was created at or after the position and is not among those handled.
 */
export function commentWatcher(opts: {
  store: Store; config: Pick<Config, 'github' | 'owner'>; drafts: Pick<Drafts, 'github' | 'githubDiscard' | 'githubSubmit'>; jobs: Pick<Supervisor, 'submit' | 'answer' | 'cancel' | 'fix'>;
  github?: GitHubUrls; say?: (line: string) => void; now?: () => number;
}): { poll(): Promise<void> } {
  const { store, config, drafts, jobs } = opts;
  const urls = opts.github ?? GITHUB;
  const say = opts.say ?? (() => {});
  const now = opts.now ?? Date.now;

  /** The comments updated since, read with the token of whoever added the project, else of another person; a failed read is logged and the next person tried. */
  async function read(project: Project, repo: string, since: string): Promise<IssueComment[] | undefined> {
    for (const person of readers(store, project)) {
      try {
        const token = await tokenOf(store, config, person, urls);
        if (token) return await listComments(repo, since, token, urls);
      } catch (err) { say(`comments on ${repo}: ${person}'s token could not read them: ${(err as Error).message}`); }
    }
    return undefined;
  }

  /** The latest job submitted from the issue (or fix asked on the pull request) that waits for an answer, or for `cancel` is queued or running. */
  const jobOn = (repo: string, number: number, word: 'answer' | 'cancel') => (word === 'answer' ? store.inState('ended').filter((j) => j.outcome === 'needs-input') : [...store.inState('queued'), ...store.inState('waiting'), ...store.inState('running')])
    .filter((j) => j.github?.repo.toLowerCase() === repo.toLowerCase() && j.github.issue === number)
    .sort((a, b) => b.id - a.id)[0];

  /** `/animus answer <text>` or `/animus cancel` on an issue or pull request, for its job or fix: the person's, or anyone's for the owner; what to tell them there. */
  async function jobCommand(person: string, repo: string, number: number, word: 'answer' | 'cancel', text: string, where: string): Promise<string> {
    if (word === 'answer' && !text) return 'Say the answer after `/animus answer`.';
    const job = jobOn(repo, number, word);
    if (!job) return `No job from this ${where} is ${word === 'answer' ? 'waiting for an answer' : 'queued or running'}.`;
    if (job.person !== person && !isOwner(config, person)) return `Only ${job.person} or the owner may ${word} job ${job.id}.`;
    try {
      // The owner acts as the job's person, as the owner's Cancel does in Slack.
      if (word === 'answer') jobs.answer(job.person, job.id, text); else jobs.cancel(job.person, job.id);
    } catch (err) {
      if (err instanceof AnimusError) return `Job ${job.id}: ${err.message}.`;
      throw err;
    }
    return word === 'answer' ? `Got your answer: job ${job.id} resumes.` : `Job ${job.id} was cancelled.`;
  }

  /** 👀 on a comment, to say it was seen; a refusal of it stops nothing. */
  async function seen(person: string, repo: string, id: number): Promise<void> {
    const token = await tokenOf(store, config, person, urls);
    if (token) await gh('POST', `/repos/${repo}/issues/comments/${id}/reactions`, token, urls, { content: 'eyes' }).catch((err: unknown) => say(`comment ${id} on ${repo}: ${(err as Error).message}`));
  }

  /** `/animus <text>` (or `/animus fix <text>`) on a pull request: a fix queued as `animus fix` on Helix would queue it, with the reviews since the job's last push; else the one line saying why not. */
  async function fixCommand(person: string, project: Project, repo: string, number: number, text: string): Promise<string | undefined> {
    const ask = /^fix(\s|$)/i.test(text) ? text.slice('fix'.length).trim() : text;
    if (!ask) return FIX_USAGE;
    // The latest job on Helix that pushed to it, as the supervisor finds the one a fix continues; its end is the last push.
    const last = store.list(-1).filter((j) => j.repo === project.name && j.pr?.endsWith(`/pull/${number}`) && j.ended && (j.outcome === 'pr' || j.outcome === 'draft-pr')).sort((a, b) => a.id - b.id).at(-1);
    let references: { name: string; text: string }[] = [];
    let left_out = 0;
    if (last) {
      const token = await tokenOf(store, config, person, urls);
      if (!token) throw new AnimusError(`${person} has no GitHub token to read pull request ${number} with`);
      ({ references, left_out } = await reviewsSince(store, repo, number, last.ended!, token, urls));
    }
    try {
      await jobs.fix(person, { repo: project.name, pr: String(number), ask, github: { repo, issue: number }, ...(references.length ? { references } : {}), ...(left_out ? { left_out } : {}) });
    } catch (err) {
      if (err instanceof AnimusError) return `Not queued: ${err.message}.`;
      throw err;
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
    const text = body.slice('/animus'.length).trim();
    const word = text.split(/\s/)[0]!.toLowerCase();
    if (word === 'answer' || word === 'cancel') { await reply(await jobCommand(person, repo, number, word, text.slice(word.length).trim(), m[1] === 'pull' ? 'pull request' : 'issue')); return; }
    if (m[1] === 'pull') {
      const refused = await fixCommand(person, project, repo, number, text);
      if (refused) await reply(refused); else await seen(person, repo, c.id);
      return;
    }
    if (word === 'discard') { await reply(await drafts.githubDiscard(person, { repo, number })); return; }
    if (word === 'submit') { await reply(await drafts.githubSubmit(person, { repo, number }, jobs)); return; }
    if (WORDS.includes(word)) return;
    await seen(person, repo, c.id);
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
