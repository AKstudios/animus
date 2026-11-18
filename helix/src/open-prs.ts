// The open pull requests Helix's jobs opened, for the display's overview. One
// GitHub call per project lists its open PRs, made with the GitHub token of a
// person whose job opened one; the PRs are matched to the jobs' PR URLs.
// Nothing is kept but the last answer per project, for a minute.
import type { DisplayClosed, DisplayPr } from '../../plugin/display/shape.ts';
import { personEnv } from './config.ts';
import type { Store } from './store.ts';

/** The part of a GitHub pull request this needs. */
export type GithubPr = { html_url: string; number: number; title: string; draft?: boolean; created_at: string; closed_at?: string | null; merged_at?: string | null };

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

/** What reads the open PRs also reads, with `.closed()`, the latest closed ones of the same projects. */
export type OpenPrs = { (): Promise<DisplayPr[]>; closed(): Promise<DisplayClosed[]> };

/**
 * Reads the open PRs of every project, each project's from GitHub at most once
 * a minute. A project GitHub cannot be asked about, or fails, has none for that
 * minute. A PR whose person has left Helix, or has no GitHub token, is not asked
 * about and is not listed.
 */
export function openPrs(opts: { store: Store; list?: ListPrs; listClosed?: ListPrs; now?: () => number; fresh?: (person: string) => Promise<unknown> }): OpenPrs {
  const { store } = opts;
  const list = opts.list ?? listOpenPrs;
  // A fake `list` without a fake `listClosed` must not send the closed call to GitHub itself.
  const listClosed = opts.listClosed ?? (opts.list ? async () => [] : listClosedPrs);
  const now = opts.now ?? Date.now;

  /** Each project's last answer for a minute, one cache per kind of call. */
  const cached = <T>(fetch: (name: string, url: string) => Promise<T[]>) => {
    const kept = new Map<string, { at: number; got: Promise<T[]> }>();
    return async () => {
      const at = now();
      const all = await Promise.all(store.projects().filter((p) => p.state === 'ready').map((p) => {
        const known = kept.get(p.name);
        if (known && at - known.at < KEPT_MS) return known.got;
        const got = fetch(p.name, p.url).catch(() => []);
        kept.set(p.name, { at, got });
        return got;
      }));
      return all.flat();
    };
  };

  const ask = async <T>(name: string, url: string, call: ListPrs, make: (pr: GithubPr, job: { id: number; person: string }) => T | undefined): Promise<T[]> => {
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
      const made = job && make(pr, job);
      return made ? [made] : [];
    });
  };

  const open = cached((name, url) => ask(name, url, list, (pr, job): DisplayPr => ({ job: job.id, repo: name, person: job.person, number: pr.number, title: pr.title, url: pr.html_url, draft: pr.draft === true, created: pr.created_at })));
  const closed = cached((name, url) => ask(name, url, listClosed, (pr, job): DisplayClosed => ({ job: job.id, number: pr.number, merged: !!pr.merged_at, at: pr.merged_at ?? pr.closed_at ?? pr.created_at })));
  return Object.assign(open, { closed });
}
