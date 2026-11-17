// A job's workspace: a fresh git worktree on its own branch, with the
// project's installs cloned in and its setup run. Containers replace this in
// office mode; the pipeline only needs a directory to work in.
import { existsSync, readFileSync, writeFileSync } from 'node:fs';
import { basename, dirname, isAbsolute, join, resolve } from 'node:path';
import { jobBranch, revParse } from './git.ts';
import { pruneInstalls, remakeInstalls, restoreInstalls, type Install } from './installs.ts';
import type { Profile } from './profile.ts';
import { failureExcerpt, git, AnimusError, sh, tryGit } from './proc.ts';
import { uiDown } from './ui.ts';

export type Workspace = { worktree: string; branch: string; base: string; baseBranch: string };

/** Where job worktrees go: the profile's `worktrees`, else ../.worktrees/<repo name>, as orbit had it. */
export function worktreesRoot(repo: string, profile: Pick<Profile, 'worktrees'>): string {
  if (profile.worktrees) return isAbsolute(profile.worktrees) ? profile.worktrees : resolve(repo, profile.worktrees);
  return join(dirname(repo), '.worktrees', basename(repo));
}

/**
 * The commit a job starts from: the base branch as the remote has it, so the
 * pull request holds only the job's commits; the local branch when there is
 * no remote or it cannot be reached.
 */
export function baseCommit(repo: string, baseBranch: string, log: (line: string) => void = () => {}): string {
  if (tryGit(repo, ['remote', 'get-url', 'origin'])) {
    if (tryGit(repo, ['fetch', '--quiet', 'origin', baseBranch]) === undefined) log(`could not fetch origin/${baseBranch}; using what this clone has`);
    const remote = revParse(repo, `origin/${baseBranch}`);
    if (remote) {
      const ahead = Number(tryGit(repo, ['rev-list', '--count', `${remote}..${baseBranch}`]) ?? 0);
      if (ahead) log(`the local ${baseBranch} is ${ahead} commit(s) ahead of origin/${baseBranch}; the job starts from origin/${baseBranch}, so its pull request holds only its own commits`);
      return remote;
    }
  }
  const local = revParse(repo, baseBranch);
  if (!local) throw new AnimusError(`the base branch ${baseBranch} does not exist in ${repo}`);
  return local;
}

export function createWorkspace(repo: string, profile: Profile, job: string, baseBranch: string, log: (line: string) => void = () => {}): Workspace {
  const branch = jobBranch(job);
  const worktree = join(worktreesRoot(repo, profile), job);
  if (existsSync(worktree)) throw new AnimusError(`${worktree} already exists`);
  const base = baseCommit(repo, baseBranch, log);
  git(repo, ['worktree', 'add', '--quiet', '-b', branch, worktree, base]);
  return { worktree, branch, base, baseBranch };
}

/** A workspace for a job that ran before: its worktree if it is still there, else a new one on its branch. */
export function reopenWorkspace(repo: string, ws: Workspace): Workspace {
  if (existsSync(join(ws.worktree, '.git'))) return ws;
  if (!revParse(repo, ws.branch)) throw new AnimusError(`${ws.branch} no longer exists; the job cannot be resumed`);
  tryGit(repo, ['worktree', 'prune']);
  git(repo, ['worktree', 'add', '--quiet', ws.worktree, ws.branch]);
  return ws;
}

/** Removes a job's worktree, stopping what it served, and drops install saves no job has used lately. */
export function removeWorkspace(repo: string, worktree: string): void {
  if (!existsSync(worktree)) return;
  try { uiDown(worktree); } catch { /* nothing was up */ }
  tryGit(repo, ['worktree', 'remove', '--force', worktree]);
  tryGit(repo, ['worktree', 'prune']);
  try { pruneInstalls(repo); } catch { /* the cache is only a cache: the next removal tries again */ }
}

/**
 * Readies a worktree that has not been: the profile's installs come first,
 * cloned from the install cache or made and saved (installs.ts), then its
 * setup. A setup that fails on restored installs gets them made afresh and
 * runs once more, so a bad save costs one install, never a red gate. A file
 * in the worktree's git dir records what ran, so a resumed job skips it.
 */
export function ensureSetup(worktree: string, profile: { setup?: string; installs?: readonly Install[] }, log: (line: string) => void = () => {}): void {
  const installs = profile.installs ?? [];
  if (!profile.setup && !installs.length) return;
  const signature = JSON.stringify([installs, profile.setup ?? '']);
  const done = join(git(worktree, ['rev-parse', '--absolute-git-dir']), 'animus-setup');
  if (existsSync(done) && readFileSync(done, 'utf8') === signature) return;
  const used = restoreInstalls(worktree, installs, log);
  if (profile.setup) {
    let r = sh(profile.setup, worktree, { CI: '1' });
    if (r.code !== 0 && used.some((u) => u.restored)) {
      log('setup failed on cached installs; installing them afresh');
      remakeInstalls(worktree, used);
      r = sh(profile.setup, worktree, { CI: '1' });
    }
    if (r.code !== 0) throw new AnimusError(`setup failed in ${worktree}: ${profile.setup}\n${failureExcerpt(r.output, 40)}`);
  }
  writeFileSync(done, signature);
}
