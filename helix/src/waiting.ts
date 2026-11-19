// What a waiting job waits for (GLOSSARY.md): the pull request of each spec its
// header says it runs `after:`. Found as `animus run` finds it on a laptop, from
// Helix's side: the pull request of the job Helix ran for that spec file, else
// one titled as the spec file in the project's clone. Read with the job's
// person's token, as Helix reads GitHub for everything else.
import { existsSync } from 'node:fs';
import { basename, resolve } from 'node:path';
import type { Earlier } from '../../plugin/src/queue.ts';
import { AnimusError } from '../../plugin/src/proc.ts';
import { loadSpec } from '../../plugin/src/spec.ts';
import type { Config } from './config.ts';
import { GITHUB, githubRepo, type GitHubUrls } from './github-app.ts';
import { gh, readPull, tokenOf } from './github-comments.ts';
import type { HelixJob, Store } from './store.ts';

export type PullState = 'OPEN' | 'MERGED' | 'CLOSED';

/** The pull request of the earlier spec `name` for this job, as GitHub has it; undefined when there is none yet. */
export type FindPull = (job: HelixJob, name: string) => Promise<{ url: string; state: PullState } | undefined>;

export const waitingFor = (name: string) => `waiting for ${name}'s pull request`;

/** Where each earlier spec's pull request stands: the first one not merged says what the job waits for, and one closed unmerged ends it. */
export async function earlierOf(find: FindPull, job: HelixJob): Promise<Earlier> {
  let open: string | undefined;
  for (const name of job.after ?? []) {
    const pull = await find(job, name);
    if (pull?.state === 'CLOSED') return { state: 'closed', reason: 'its earlier pull request was closed' };
    if (pull?.state !== 'MERGED') open ??= waitingFor(name);
  }
  return open ? { state: 'open', waiting: open } : { state: 'merged' };
}

type ListedPull = { html_url: string; title: string; created_at: string; merged_at?: string | null; closed_at?: string | null };

/** The pull request from GitHub, with the person's token. */
export function findOnGitHub(store: Store, config: Pick<Config, 'github'>, urls: GitHubUrls = GITHUB): FindPull {
  return async (job, name) => {
    const project = store.project(job.repo);
    const repo = project && githubRepo(project.url);
    if (!project || !repo) throw new AnimusError(`the project ${job.repo} is not on GitHub, so its pull requests cannot be read`);
    // The job Helix ran for that spec file, newest first: its pull request, or its title for a pull request not yet known.
    const ran = store.list(-1).filter((j) => j.repo === job.repo && j.id < job.id && !j.ask && basename(j.spec) === basename(name)).at(-1);
    const number = /\/pull\/(\d+)$/.exec(ran?.pr ?? '')?.[1];
    if (number) {
      const pull = await readPull(store, config, urls, job.person, repo, Number(number));
      return pull ? { url: pull.url, state: pull.merged ? 'MERGED' : pull.state === 'open' ? 'OPEN' : 'CLOSED' } : undefined;
    }
    const file = resolve(project.dir, name);
    // A spec file in the clone that cannot be read has no title to look for: the job keeps waiting.
    const title = ran?.title ?? (existsSync(file) ? (() => { try { return loadSpec(file).title; } catch { return undefined; } })() : undefined);
    if (!title) return undefined;
    const token = await tokenOf(store, config, job.person, urls);
    if (!token) throw new AnimusError(`${job.person} has no GitHub token to read pull requests with`);
    const all = await gh('GET', `/repos/${repo}/pulls?state=all&sort=created&direction=desc&per_page=100`, token, urls) as ListedPull[];
    const found = all.find((p) => p.title === title);
    return found && { url: found.html_url, state: found.merged_at ? 'MERGED' : found.closed_at ? 'CLOSED' : 'OPEN' };
  };
}
