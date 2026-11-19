// A provision job (docs/helix.md): the job a failed add check queues so an
// agent can fix the project's environment (its Dockerfile and profile) until
// the check passes. It is an ordinary job in the queue, for the person who
// added the project, with a spec Helix writes from the check's output. A
// project has at most one at a time: queued or running, or ended in a pull
// request that is still open.
import { mkdirSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';
import type { HelixJob, Project, Store } from './store.ts';

/** What `animus project list` and a project's view say of its provision job. */
export type Provision = { job: number; state: HelixJob['state']; pr?: string };

/** The provision job a project has now: queued, waiting or running, else the latest that ended in a pull request. */
export function provisionOf(store: Store, name: string): HelixJob | undefined {
  const mine = (jobs: HelixJob[]) => jobs.filter((j) => j.provision && j.repo === name);
  const active = mine([...store.inState('queued'), ...store.inState('waiting'), ...store.inState('running')])[0];
  // A pull request counts as open until Helix has seen it merged or closed (provisionEnded); one closed by hand blocks provisioning until it does.
  return active ?? mine(store.inState('ended')).filter((j) => j.pr && !j.pr_done && (j.outcome === 'pr' || j.outcome === 'draft-pr')).pop();
}

/**
 * Helix has seen a provision job's pull request merged or closed (open-prs.ts).
 * Merged, and its project still failed: the add check runs again on the base
 * branch, which no second provision job follows. Once per pull request.
 */
export function provisionEnded(opts: { store: Store; startCheck: (name: string) => void }, jobId: number, merged: boolean): void {
  const { store } = opts;
  const job = store.get(jobId);
  if (!job?.provision || job.pr_done) return;
  store.save({ ...job, pr_done: merged ? 'merged' : 'closed' });
  const project = store.project(job.repo);
  if (!merged || project?.state !== 'failed') return;
  const { reason: _old, ...rest } = project;
  store.putProject({ ...rest, state: 'checking', after_provision: job.id });
  opts.startCheck(project.name);
}

export const provisionView = (store: Store, name: string): { provision?: Provision } => {
  const job = provisionOf(store, name);
  return job ? { provision: { job: job.id, state: job.state, ...(job.pr ? { pr: job.pr } : {}) } } : {};
};

/** What the add's output says of a provision job that exists. */
export const describeExisting = (job: HelixJob): string =>
  job.state === 'ended' ? `provision job ${job.id} has an open pull request, ${job.pr}` : `provision job ${job.id} is ${job.state}`;

/** The spec of a provision job, from why the add check failed. */
export const provisionSpec = (name: string, why: string): string => `---
size: small
---
# Fix ${name}'s environment so its add check passes

The add check of ${name} failed on its base branch:

${why}

Change \`.animus/Dockerfile\` and \`.animus/animus.yaml\` only, so the image builds, setup runs and every gate passes. Fixing the project's code or tests is not part of this.

## Acceptance criteria

1. The add check of ${name} passes on this job's branch.
`;

/** Queues a provision job for whoever added the project, with its spec in the job's folder. */
export function queueProvision(opts: { store: Store; home: string; project: Project; why: string; at?: Date }): HelixJob {
  const { store, home, project } = opts;
  const person = project.added_by!;
  const job = store.add({
    state: 'queued', person, repo: project.name, spec: '', title: `Fix ${project.name}'s environment so its add check passes`, draft: false,
    provision: true, submitted: (opts.at ?? new Date()).toISOString(),
  });
  job.spec = join(home, 'jobs', String(job.id), 'provision.md');
  mkdirSync(join(home, 'jobs', String(job.id)), { recursive: true });
  writeFileSync(job.spec, provisionSpec(project.name, opts.why));
  store.save(job);
  store.record(person, 'submitted', { job: job.id, repo: project.name });
  return job;
}
