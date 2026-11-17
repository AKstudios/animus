// Cleanup: what a job leaves behind goes once nobody needs it, and its
// record never does. A job whose pull request merged or closed loses any
// worktree still standing at once, and its branch and evidence branch (here
// and on origin) once the pull request has been finished for --days; a job
// that never had a pull request loses them once it last ran that long ago.
// A job with an open pull request, or one waiting for an answer, is never
// touched. The job's folder (spec, gate output, reviews, screenshots,
// transcripts), Claude Code's own transcripts and the run log are kept for
// analysis: only a job named on the command line goes whole, and at once.
import { existsSync, readdirSync, rmSync, statSync } from 'node:fs';
import { join } from 'node:path';
import { revParse } from './git.ts';
import { animusHome, jobDir, loadState, readRuns } from './log.ts';
import { evidenceBranch, type PrState } from './pr.ts';
import { AnimusError, tryGit } from './proc.ts';
import { removeWorkspace } from './workspace.ts';

/** How long a finished job's branches outlive its pull request, or its last run when it had none, in days. */
export const KEEP_DAYS = 30;
const DAY_MS = 24 * 60 * 60 * 1000;

/** A pull request's state, and when it merged or closed if it did; undefined when GitHub cannot say. */
export type PrEnd = (url: string, cwd: string) => { state: PrState; ended?: string } | undefined;

export type CleanupOptions = {
  /** Only these jobs, whole and at once: their folders go too. */
  jobs?: readonly string[];
  days?: number;
  /** Report what would go; remove nothing. */
  dryRun?: boolean;
  now?: number;
};

/** What happened to one job: what was removed, and why anything of it stays. */
export type Cleaned = { job: string; removed: string[]; kept?: string };

export function cleanup(opts: CleanupOptions, lookup: PrEnd): Cleaned[] {
  const root = jobDir('');
  const all = existsSync(root) ? readdirSync(root).filter((job) => loadState(job)) : [];
  const unknown = opts.jobs?.find((job) => !all.includes(job));
  if (unknown) throw new AnimusError(`no job ${unknown} under ${root}`);
  const prs = new Map<string, string>();
  for (const run of readRuns()) if (run.pr) prs.set(run.job, run.pr);
  const named = Boolean(opts.jobs?.length);
  return (named ? opts.jobs! : all).map((job) => cleanJob(job, prs.get(job), named, opts, lookup));
}

function cleanJob(job: string, pr: string | undefined, named: boolean, opts: CleanupOptions, lookup: PrEnd): Cleaned {
  const state = loadState(job)!;
  const dir = jobDir(job);
  const { repo } = state;
  const hasRepo = existsSync(join(repo, '.git'));
  const days = opts.days ?? KEEP_DAYS;
  const now = opts.now ?? Date.now();
  const lastRun = statSync(join(dir, 'state.json')).mtimeMs;

  if (state.outcome === 'needs-input' && !named) return { job, removed: [], kept: 'it is waiting for an answer; name it to remove it now' };
  // Since when nobody needs its branches: its pull request ended, or, with none, it last ran.
  let since = lastRun;
  if (pr) {
    const end = lookup(pr, hasRepo ? repo : animusHome());
    if (!end) return { job, removed: [], kept: `the state of ${pr} could not be read` };
    if (end.state === 'OPEN') return { job, removed: [], kept: `${pr} is open` };
    if (end.ended) since = Date.parse(end.ended);
  }
  const old = named || now - since >= days * DAY_MS;
  // A job with a finished pull request needs no worktree; one without keeps it as long as its branch.
  if (!pr && !old) return { job, removed: [], kept: `it has no pull request and last ran less than ${days} day(s) ago; name it to remove it now` };

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
    if (old && tryGit(repo, ['remote', 'get-url', 'origin'])) {
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
    for (const n of old ? names : []) {
      if (!revParse(repo, `refs/heads/${n}`)) continue;
      if (act && tryGit(repo, ['branch', '-D', n]) === undefined) problems.push(`the branch ${n} could not be deleted`);
      else removed.push(`branch ${n}`);
    }
  }
  if (problems.length) return { job, removed, kept: `${problems.join('; ')}; cleanup tries again next time` };
  if (!old) return { job, removed, kept: `its branches stay until ${days} day(s) after ${pr} ended` };
  if (!named) return { job, removed };
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
