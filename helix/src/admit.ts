// Admit on Helix (docs/adr/0007, 0008): a spec is checked against the project's
// profile on its base branch as GitHub has it. The branch is fetched with the
// person's token and the profile read from origin/<base> itself, never from
// whatever the clone has checked out. Used when a spec is submitted and again
// when its queued job starts, so a job never fails at start for a reason admit
// did not name.
import { existsSync, readFileSync } from 'node:fs';
import { basename } from 'node:path';
import { admit, refusal, type Admitted, type Facts } from '../../plugin/src/admit.ts';
import { loadFactory } from '../../plugin/src/profiles.ts';
import { AnimusError } from '../../plugin/src/proc.ts';
import { parseProfile, PROFILE_PATH } from '../../plugin/src/profile.ts';
import { credentialEnv, personEnv, type Config } from './config.ts';
import { freshToken, liveTokenFile, type GitHubUrls } from './github-app.ts';
import { freshBase, git } from './fresh.ts';
import type { HelixJob, Store } from './store.ts';

/** What a spec was admitted as on Helix, and what to tell the person besides. */
export type Reading = { admitted: Admitted; warnings: string[] };

/**
 * Admits the spec's text against the project's clone: fetches its base branch
 * with env, reads the profile at that commit. Throws AnimusError when GitHub
 * cannot be reached or the base branch has no readable profile.
 * `checkout` is the profile text a laptop would use, to warn when it differs.
 */
export function admitOnBase(repoDir: string, env: Record<string, string>, text: string, name: string, checkout?: string): Reading {
  const commit = freshBase(repoDir, env);
  const shown = git(repoDir, ['show', `${commit}:${PROFILE_PATH}`], env);
  if (!shown.ok) throw new AnimusError(`the project's base branch on GitHub has no ${PROFILE_PATH}: commit one there (animus init writes it)`);
  const profile = parseProfile(shown.out, `${PROFILE_PATH} on GitHub`);
  const origin = (branch: string) => `origin/${branch}`;
  const facts: Facts = {
    profile, read: `${origin(profile.base)} on GitHub`,
    // A branch other than the profile's base has not been fetched yet: ask GitHub once.
    hasBranch: (b) => git(repoDir, ['rev-parse', '--verify', '--quiet', origin(b)], env).ok
      || git(repoDir, ['fetch', '--quiet', 'origin', `+refs/heads/${b}:refs/remotes/${origin(b)}`], env).ok,
    hasPath: (b, path) => git(repoDir, ['cat-file', '-e', `${origin(b)}:${path}`], env).ok,
  };
  const admitted = admit(loadFactory(), text, facts, name);
  if (admitted.spec.after.length) {
    admitted.problems.push({ who: 'spec', what: 'after: needs the earlier spec on the machine that follows it, and Helix cannot: start this one with `animus start --local`, or drop `after:`' });
  }
  const warnings = checkout !== undefined && checkout.trim() !== shown.out.trim()
    ? [`your checkout's ${PROFILE_PATH} differs from ${facts.read}: Helix reads GitHub's, so push yours first if the job should use it`]
    : [];
  return { admitted, warnings };
}

/** The environment Helix fetches a person's project with: their credentials, their live GitHub token if they signed in with the app. */
export function fetchEnv(store: Store, person: string): Record<string, string> {
  const theirs = { ...personEnv(store.person(person)), ...(existsSync(liveTokenFile(person)) ? { ANIMUS_GH_TOKEN_FILE: liveTokenFile(person) } : {}) };
  return { ...theirs, ...credentialEnv(theirs) };
}

/** The message a refused spec carries, or nothing when it is admitted. */
export const refusedWith = (name: string, r: Reading): string | undefined => (r.admitted.problems.length || !r.admitted.plan ? refusal(name, r.admitted).message : undefined);

/** The supervisor's admit at a job's start: the spec as it was queued, against the project's base branch as GitHub has it now. */
export const startAdmit = (job: Pick<HelixJob, 'spec'>, repoDir: string, env: Record<string, string>): string | undefined => {
  const name = basename(job.spec);
  return refusedWith(name, admitOnBase(repoDir, env, readFileSync(job.spec, 'utf8'), name));
};

/** Admits a submission for a project before it is queued; the person's token is refreshed first. */
export type AdmitSubmission = (person: string, repo: string, spec: string, name: string, checkout?: string) => Promise<Reading>;

export function submissionAdmit(store: Store, config: Config, github?: GitHubUrls): AdmitSubmission {
  return async (person, repo, spec, name, checkout) => {
    const project = store.project(repo);
    if (project?.state !== 'ready') throw new AnimusError(`Helix has no project named ${repo}`);
    await freshToken(store, config, person, github);
    return admitOnBase(project.dir, fetchEnv(store, person), spec, name, checkout);
  };
}

/** What a draft session is given of the project (draft.ts, project.json): the profile at the commit Helix fetched, never the clone's working tree. Nothing when that commit has no readable profile; the draft is then written without it, and Submit says why it cannot run. */
export function draftProject(repoDir: string, commit: string, env: Record<string, string>): { profile: string; read: string; commit: string } | undefined {
  const shown = git(repoDir, ['show', `${commit}:${PROFILE_PATH}`], env);
  if (!shown.ok) return undefined;
  try { return { profile: shown.out, read: `origin/${parseProfile(shown.out).base} on GitHub`, commit }; } catch { return undefined; }
}
