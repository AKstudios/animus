// Git helpers shared by the workspace, the install cache and the gates.
import { copyFileSync, existsSync, mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { dirname, isAbsolute, join, matchesGlob, resolve } from 'node:path';
import { git, tryGit } from './proc.ts';

export const jobBranch = (id: string) => `animus/${id}`;

export function revParse(cwd: string, ref: string): string | undefined {
  return tryGit(cwd, ['rev-parse', '--verify', '--quiet', `${ref}^{commit}`]);
}

function gitPath(cwd: string, which: '--git-dir' | '--git-common-dir'): string {
  const p = git(cwd, ['rev-parse', which]);
  return isAbsolute(p) ? p : resolve(cwd, p);
}

/** The git dir shared by every worktree of the repository: the install cache lives there. */
export function commonDir(cwd: string): string {
  return gitPath(cwd, '--git-common-dir');
}

/** The main checkout of the repository cwd belongs to. */
export function mainCheckout(cwd: string): string {
  return dirname(gitPath(cwd, '--git-common-dir'));
}

/** Files changed, added or untracked in the worktree, as `git status --porcelain` lines. */
export function uncommitted(cwd: string): string[] {
  return git(cwd, ['status', '--porcelain', '--untracked-files=all']).split('\n').filter(Boolean);
}

/** Files added, changed or deleted between two commits. */
export function touchedFiles(cwd: string, from: string, to: string): string[] {
  const out = git(cwd, ['diff', '--name-only', '--no-renames', from, to]);
  return out ? out.split('\n') : [];
}

/** Runs fn in a detached scratch worktree of commit, removed afterwards. */
export function withScratch<T>(repo: string, commit: string, fn: (worktree: string) => T): T {
  const wt = join(mkdtempSync(join(tmpdir(), 'animus-scratch-')), 'wt');
  git(repo, ['worktree', 'add', '--quiet', '--detach', wt, commit]);
  try {
    return fn(wt);
  } finally {
    tryGit(repo, ['worktree', 'remove', '--force', wt]);
    rmSync(dirname(wt), { recursive: true, force: true });
  }
}

/** Whether a path is one of these globs, matches one, or lies under a folder one names. */
export function matchesAny(path: string, globs: readonly string[]): boolean {
  return globs.some((g) => {
    const folder = g.replace(/\/+$/, '');
    return path === g || matchesGlob(path, g) || path.startsWith(`${folder}/`);
  });
}

/**
 * The identity of what the worktree holds: the tree `git add -A` would commit
 * (tracked and untracked files that are not ignored, deleted ones gone),
 * written through a copy of the index so the real one is left alone.
 * Committing the same files gives the same identity.
 */
export function contentTree(cwd: string): string {
  const tmp = mkdtempSync(join(tmpdir(), 'animus-index-'));
  const index = join(tmp, 'index');
  try {
    const real = resolve(cwd, git(cwd, ['rev-parse', '--git-path', 'index']));
    // A copy keeps the index's file stats, so only files changed since are read again.
    if (existsSync(real)) copyFileSync(real, index);
    git(cwd, ['add', '-A'], { GIT_INDEX_FILE: index });
    return git(cwd, ['write-tree'], { GIT_INDEX_FILE: index });
  } finally {
    rmSync(tmp, { recursive: true, force: true });
  }
}

/** Commits everything in the worktree that is not committed yet. Returns whether there was anything. */
export function commitAll(cwd: string, message: string): boolean {
  if (!uncommitted(cwd).length) return false;
  git(cwd, ['add', '-A']);
  git(cwd, ['commit', '--quiet', '--no-verify', '-m', message]);
  return true;
}

/**
 * The https address of a GitHub repository, from any of the forms a clone's
 * origin takes. Helix clones with its people's tokens, which needs https.
 */
export function githubUrl(url: string): string | undefined {
  const m = /^(?:https:\/\/github\.com\/|git@github\.com:|ssh:\/\/git@github\.com\/)([A-Za-z0-9-]+)\/([A-Za-z0-9._-]+?)(?:\.git)?\/?$/.exec(url.trim());
  return m ? `https://github.com/${m[1]}/${m[2]}.git` : undefined;
}
