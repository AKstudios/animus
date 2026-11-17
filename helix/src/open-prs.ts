// The open pull requests Helix's jobs opened, for the display's overview. One
// GitHub call per project lists its open PRs, made with the GitHub token of a
// person whose job opened one; the PRs are matched to the jobs' PR URLs.
// Nothing is kept but the last answer per project, for a minute.
import type { DisplayPr } from '../../plugin/display/shape.ts';
import { personEnv } from './config.ts';
import type { Store } from './store.ts';

/** The part of a GitHub pull request this needs. */
export type GithubPr = { html_url: string; number: number; title: string; draft?: boolean; created_at: string };

/** Lists a repository's open PRs, newest first, with a GitHub token. */
export type ListPrs = (repoUrl: string, token: string) => Promise<GithubPr[]>;

const KEPT_MS = 60_000;

/** GitHub's own API; a project that is not on github.com has no open PRs here. */
export const listOpenPrs: ListPrs = async (repoUrl, token) => {
  const m = /github\.com[:/]([^/]+\/[^/]+?)(?:\.git)?\/?$/.exec(repoUrl);
  if (!m) return [];
  const res = await fetch(`https://api.github.com/repos/${m[1]}/pulls?state=open&sort=created&direction=desc&per_page=100`, {
    headers: { authorization: `Bearer ${token}`, accept: 'application/vnd.github+json', 'user-agent': 'animus-helix' },
    signal: AbortSignal.timeout(10_000),
  });
  if (!res.ok) throw new Error(`GitHub answered ${res.status}`);
  return (await res.json()) as GithubPr[];
};

/**
 * Reads the open PRs of every project, each project's from GitHub at most once
 * a minute. A project GitHub cannot be asked about, or fails, has none for that
 * minute. A PR whose person has left Helix, or has no GitHub token, is not asked
 * about and is not listed.
 */
export function openPrs(opts: { store: Store; list?: ListPrs; now?: () => number; fresh?: (person: string) => Promise<unknown> }): () => Promise<DisplayPr[]> {
  const { store } = opts;
  const list = opts.list ?? listOpenPrs;
  const now = opts.now ?? Date.now;
  const kept = new Map<string, { at: number; prs: Promise<DisplayPr[]> }>();

  const ask = async (name: string, url: string): Promise<DisplayPr[]> => {
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
    const open = await list(url, (await tokenOf(mine[0]!.person))!);
    return open.flatMap((pr): DisplayPr[] => {
      const job = mine.find((j) => j.pr === pr.html_url);
      return job ? [{ job: job.id, repo: name, person: job.person, number: pr.number, title: pr.title, url: pr.html_url, draft: pr.draft === true, created: pr.created_at }] : [];
    });
  };

  return async () => {
    const at = now();
    const all = await Promise.all(store.projects().filter((p) => p.state === 'ready').map((p) => {
      const known = kept.get(p.name);
      if (known && at - known.at < KEPT_MS) return known.prs;
      const prs = ask(p.name, p.url).catch(() => []);
      kept.set(p.name, { at, prs });
      return prs;
    }));
    return all.flat();
  };
}
