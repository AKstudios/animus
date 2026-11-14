// Cleanup: what a job leaves behind goes once nobody needs it. A job whose
// pull request merged or closed loses its branch, its evidence branch (here
// and on origin) and any worktree still standing. Its folder under Animus's
// home goes once it is old, and so does everything of a job that never had a
// pull request. A job with an open pull request is never touched. The run log
// keeps every job's line.
import { existsSync, readdirSync, rmSync, statSync } from 'node:fs';
import { join } from 'node:path';
import { revParse } from './git.ts';
import { animusHome, jobDir, loadState, readRuns } from './log.ts';
import { evidenceBranch, type PrLookup } from './pr.ts';
import { AnimusError, tryGit } from './proc.ts';
import { removeWorkspace } from './workspace.ts';

/** How long a job's folder outlives its last run, in days. */
export const KEEP_DAYS = 14;
const DAY_MS = 24 * 60 * 60 * 1000;

export type CleanupOptions = {
  /** Only these jobs, and at once: a named job does not wait until it is old. */
  jobs?: readonly string[];
  days?: number;
  /** Report what would go; remove nothing. */
  dryRun?: boolean;
  now?: number;
};

/** What happened to one job: what was removed, and why anything of it stays. */
export type Cleaned = { job: string; removed: string[]; kept?: string };

export function cleanup(opts: CleanupOptions, lookup: PrLookup): Cleaned[] {
  const root = jobDir('');
  const all = existsSync(root) ? readdirSync(root).filter((job) => loadState(job)) : [];
  const unknown = opts.jobs?.find((job) => !all.includes(job));
  if (unknown) throw new AnimusError(`no job ${unknown} under ${root}`);
  const prs = new Map<string, string>();
  for (const run of readRuns()) if (run.pr) prs.set(run.job, run.pr);
  const named = Boolean(opts.jobs?.length);
  return (named ? opts.jobs! : all).map((job) => cleanJob(job, prs.get(job), named, opts, lookup));
}

function cleanJob(job: string, pr: string | undefined, named: boolean, opts: CleanupOptions, lookup: PrLookup): Cleaned {
  const state = loadState(job)!;
  const dir = jobDir(job);
  const { repo } = state;
  const hasRepo = existsSync(join(repo, '.git'));
  const days = opts.days ?? KEEP_DAYS;
  const old = named || (opts.now ?? Date.now()) - statSync(join(dir, 'state.json')).mtimeMs >= days * DAY_MS;

  if (pr) {
    const prState = lookup(pr, hasRepo ? repo : animusHome());
    if (!prState) return { job, removed: [], kept: `the state of ${pr} could not be read` };
    if (prState === 'OPEN') return { job, removed: [], kept: `${pr} is open` };
  } else if (!old) {
    return { job, removed: [], kept: `it has no pull request and last ran less than ${days} day(s) ago; name it to remove it now` };
  }

  const act = !opts.dryRun;
  const removed: string[] = [];
  const problems: string[] = [];
  if (hasRepo) {
    const { worktree, branch } = state.workspace;
    if (existsSync(worktree)) {
      if (act) removeWorkspace(repo, worktree);
      removed.push(`worktree ${worktree}`);
    }
    const names = [branch, evidenceBranch(job)];
    if (tryGit(repo, ['remote', 'get-url', 'origin'])) {
      const heads = tryGit(repo, ['ls-remote', '--heads', 'origin', ...names]);
      if (heads === undefined) problems.push('origin could not be reached');
      else {
        const there = names.filter((n) => heads.split('\n').some((line) => line.endsWith(`\trefs/heads/${n}`)));
        if (there.length && act && tryGit(repo, ['push', '--quiet', 'origin', '--delete', ...there]) === undefined) problems.push(`${there.join(' and ')} could not be deleted on origin`);
        else removed.push(...there.map((n) => `origin/${n}`));
        // A branch GitHub deleted on merge leaves its remote-tracking ref here.
        if (act) for (const n of names) tryGit(repo, ['branch', '-dr', `origin/${n}`]);
      }
    }
    for (const n of names) {
      if (!revParse(repo, `refs/heads/${n}`)) continue;
      if (act && tryGit(repo, ['branch', '-D', n]) === undefined) problems.push(`the branch ${n} could not be deleted`);
      else removed.push(`branch ${n}`);
    }
  }
  if (problems.length) return { job, removed, kept: `${problems.join('; ')}; its folder stays so cleanup can try again` };
  if (!old) return { job, removed, kept: `its folder stays until ${days} day(s) after its last run` };
  if (act) rmSync(dir, { recursive: true, force: true });
  removed.push(`folder ${dir}`);
  return { job, removed };
}

/** `animus cleanup`: one block per job. */
export function describeCleanup(results: readonly Cleaned[], dryRun = false): string {
  if (!results.length) return `no jobs under ${jobDir('')}`;
  return results.map((r) => [
    r.job,
    ...r.removed.map((what) => `  ${dryRun ? 'would remove' : 'removed'} ${what}`),
    ...(r.kept ? [`  kept: ${r.kept}`] : []),
  ].join('\n')).join('\n');
}
