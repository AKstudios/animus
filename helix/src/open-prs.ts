// The open pull requests Helix's jobs opened, for the display's overview. One
// GitHub call per project lists its open PRs, made with the GitHub token of a
// person whose job opened one; the PRs are matched to the jobs' PR URLs.
// Nothing is kept but the last answer per project, for a minute.
import type { DisplayClosed, DisplayPr } from '../../plugin/display/shape.ts';
import { issuesInBody } from '../../plugin/src/issues.ts';
import { personEnv } from './config.ts';
import { GITHUB, githubRepo } from './github-app.ts';
import { gh } from './github-comments.ts';
import { provisionOf } from './provision.ts';
import type { Project, Store } from './store.ts';

/** The part of a GitHub pull request this needs. */
export type GithubPr = { html_url: string; number: number; title: string; draft?: boolean; created_at: string; closed_at?: string | null; merged_at?: string | null; body?: string | null };

/** Lists a repository's open PRs, newest first, with a GitHub token. */
export type ListPrs = (repoUrl: string, token: string) => Promise<GithubPr[]>;

/** The closed PRs kept per project: GitHub's `per_page`, the most recently updated. */
const CLOSED = 10;

const KEPT_MS = 60_000;

/** GitHub's own API; a project that is not on github.com has no open PRs here. */
const github = (state: 'open' | 'closed'): ListPrs => async (repoUrl, token) => {
  const m = /github\.com[:/]([^/]+\/[^/]+?)(?:\.git)?\/?$/.exec(repoUrl);
  if (!m) return [];
  const res = await fetch(`https://api.github.com/repos/${m[1]}/pulls?${state === 'open' ? 'state=open&sort=created&direction=desc&per_page=100' : `state=closed&sort=updated&direction=desc&per_page=${CLOSED}`}`, {
    headers: { authorization: `Bearer ${token}`, accept: 'application/vnd.github+json', 'user-agent': 'animus-helix' },
    signal: AbortSignal.timeout(10_000),
  });
  if (!res.ok) throw new Error(`GitHub answered ${res.status}`);
  return (await res.json()) as GithubPr[];
};
export const listOpenPrs = github('open');
export const listClosedPrs = github('closed');

/** Closes a repository's issues as not planned with a GitHub token, leaving any already closed as they are. */
export type CloseIssues = (repoUrl: string, numbers: number[], token: string) => Promise<void>;

export const closeAsNotPlanned: CloseIssues = async (repoUrl, numbers, token) => {
  const repo = githubRepo(repoUrl);
  if (!repo) return;
  for (const n of numbers) {
    // One a person closed keeps the reason they gave.
    const issue = await gh('GET', `/repos/${repo}/issues/${n}`, token, GITHUB) as { state?: string };
    if (issue.state === 'open') await gh('PATCH', `/repos/${repo}/issues/${n}`, token, GITHUB, { state: 'closed', state_reason: 'not_planned' });
  }
};

/** What reads the open PRs also reads, with `.closed()`, the latest closed ones of the same projects. */
export type OpenPrs = { (): Promise<DisplayPr[]>; closed(): Promise<DisplayClosed[]> };

/**
 * Reads the open PRs of every project, each project's from GitHub at most once
 * a minute. A project GitHub cannot be asked about, or fails, has none for that
 * minute. A PR whose person has left Helix, or has no GitHub token, is not asked
 * about and is not listed.
 */
export function openPrs(opts: {
  store: Store; list?: ListPrs; listClosed?: ListPrs; now?: () => number; fresh?: (person: string) => Promise<unknown>;
  /** Told of each closed PR that a job of Helix's opened, by the job's id: merged, or closed without. */
  ended?: (job: number, merged: boolean) => void;
  /** Closes the should-fix issues of a job's PR closed without merging (docs/adr/0012). */
  closeIssues?: CloseIssues;
}): OpenPrs {
  const { store } = opts;
  const list = opts.list ?? listOpenPrs;
  // A fake `list` without a fake `listClosed` must not send the closed call to GitHub itself.
  const listClosed = opts.listClosed ?? (opts.list ? async () => [] : listClosedPrs);
  const closeIssues = opts.closeIssues ?? (opts.list || opts.listClosed ? async () => {} : closeAsNotPlanned);
  const now = opts.now ?? Date.now;
  // The closed PRs whose should-fix issues were seen to: once each while Helix runs, as GitHub lists them every minute.
  const issuesClosed = new Set<string>();

  /** Each project's last answer for a minute, one cache per kind of call. */
  const cached = <T>(fetch: (name: string, url: string) => Promise<T[]>) => {
    const kept = new Map<string, { at: number; got: Promise<T[]> }>();
    return async () => {
      const at = now();
      // A failed project whose provision job opened a pull request is asked about too: its merge is what makes the project ready.
      const watched = (p: Project) => p.state === 'ready' || (p.state === 'failed' && !!provisionOf(store, p.name)?.pr);
      const all = await Promise.all(store.projects().filter(watched).map((p) => {
        const known = kept.get(p.name);
        if (known && at - known.at < KEPT_MS) return known.got;
        const got = fetch(p.name, p.url).catch(() => []);
        kept.set(p.name, { at, got });
        return got;
      }));
      return all.flat();
    };
  };

  const ask = async <T>(name: string, url: string, call: ListPrs, make: (pr: GithubPr, job: { id: number; person: string }, token: string) => T | undefined): Promise<T[]> => {
    // Newest job first, so the person asked is whoever opened the latest PR.
    const opened = store.inState('ended').filter((j) => j.repo === name && j.pr && (j.outcome === 'pr' || j.outcome === 'draft-pr')).reverse();
    const tokens = new Map<string, string | undefined>();
    const tokenOf = async (person: string) => {
      if (!tokens.has(person)) {
        let env: Record<string, string> = {};
        // A sign-in through the GitHub App is refreshed first: its access token lasts eight hours.
        try { await opts.fresh?.(person); env = personEnv(store.person(person)); } catch { /* a credentials file that is gone, or a sign-in GitHub refuses, is no token */ }
        tokens.set(person, store.person(person) ? env.GH_TOKEN ?? env.GITHUB_TOKEN : undefined);
      }
      return tokens.get(person);
    };
    const mine: typeof opened = [];
    for (const j of opened) if (await tokenOf(j.person)) mine.push(j);
    if (!mine.length) return [];
    const got = await call(url, (await tokenOf(mine[0]!.person))!);
    return got.flatMap((pr): T[] => {
      const job = mine.find((j) => j.pr === pr.html_url);
      const made = job && make(pr, job, tokens.get(job.person)!);
      return made ? [made] : [];
    });
  };

  const open = cached((name, url) => ask(name, url, list, (pr, job): DisplayPr => ({ job: job.id, repo: name, person: job.person, number: pr.number, title: pr.title, url: pr.html_url, draft: pr.draft === true, created: pr.created_at })));
  const closed = cached((name, url) => ask(name, url, listClosed, (pr, job, token): DisplayClosed => {
    opts.ended?.(job.id, !!pr.merged_at);
    // A merged PR leaves its unsettled should-fix issues open; a closed one's are closed as its person.
    const issues = pr.merged_at || issuesClosed.has(pr.html_url) ? [] : issuesInBody(pr.body ?? '');
    issuesClosed.add(pr.html_url);
    if (issues.length) closeIssues(url, issues.map((i) => i.number), token).catch(() => { /* issues GitHub will not close stay open, like a project without the Issues permission */ });
    return { job: job.id, number: pr.number, merged: !!pr.merged_at, at: pr.merged_at ?? pr.closed_at ?? pr.created_at };
  }));
  return Object.assign(open, { closed });
}
