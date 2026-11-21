// The loop of a provision job (provision.ts): on the machine, because a job's
// container has no Docker. Each attempt is one agent session that edits the
// project's Dockerfile and profile in a worktree, then Helix builds the image
// and runs the add check on the job's branch. The agent only edits files; this
// script decides whether an attempt passed and when to stop: five attempts,
// two hours, or the agent saying the failure is not the environment's. A check
// that passes ends in a pull request with the check's output as its proof.
import { readFileSync, rmSync } from 'node:fs';
import { hostname } from 'node:os';
import { join } from 'node:path';
import type { AgentRequest, AgentResult } from '../../plugin/src/agent.ts';
import type { ProvisionAttempt } from '../../plugin/display/shape.ts';
import { jobBranch } from '../../plugin/src/git.ts';
import { writeJson, type Progress, type ProvisionStage } from '../../plugin/src/log.ts';
import { publish as realPublish, type Publish } from '../../plugin/src/pr.ts';
import { loadProfile, mask, PROFILE_PATH } from '../../plugin/src/profile.ts';
import { readPrompt, type Factory } from '../../plugin/src/profiles.ts';
import { AnimusError, failureExcerpt, git } from '../../plugin/src/proc.ts';
import { cloneBase, freshBase } from './fresh.ts';
import { ImageFailed, readDockerfile, DOCKERFILE } from './project-image.ts';
import { runEnvironment, type SetupRun } from './projects.ts';
import { missingSecret, secretsFor } from './secrets.ts';
import type { HelixJob, Store } from './store.ts';

export const MAX_ATTEMPTS = 5;
export const MAX_MS = 2 * 60 * 60 * 1000;
/** The only files a provision job may change, whatever the profile protects. */
export const ALLOWED = [DOCKERFILE, PROFILE_PATH];

/** What the session answers: it changed the files, or the failure is not the environment's. */
const SCHEMA = {
  type: 'object',
  properties: { status: { enum: ['changed', 'not-environment'] }, summary: { type: 'string' }, reason: { type: 'string' } },
  required: ['status', 'summary'],
};

type Attempt = { changed: string[]; discarded: string[]; diff: string; failure: string };

/** What a job's process says when it ends, in the words of `animus run`'s result (supervisor.ts run). */
export type ProvisionResult = { outcome: 'pr' | 'failed'; pr?: string; reason?: string; cost_usd: number };

export type ProvisionOpts = {
  store: Store; home: string; job: HelixJob; factory: Factory;
  /** The adder's credentials and Animus's variables: git and the pull request use them, and a session gets its Claude sign-in from them. */
  env: Record<string, string>;
  /** One agent session in the worktree, in a container of image when there is one (the job image when not). */
  session: (req: AgentRequest, image: string | undefined) => AgentResult;
  setup: SetupRun;
  /** With containers: the image a Dockerfile gives (project-image.ts projectImage). Throws ImageFailed when it is refused or does not build. */
  image?: (dockerfile: string | undefined, base: string) => string;
  publish?: Publish;
  say: (line: string) => void;
  now?: () => number;
  maxAttempts?: number;
  maxMs?: number;
};

const capped = (text: string, n = 4000) => (text.length > n ? `${text.slice(0, n)}\n… (${text.length} characters)` : text);

function prompt(spec: string, attempts: Attempt[]): string {
  const earlier = attempts.map((a, i) => `### Attempt ${i + 1}\n\nChanged: ${a.changed.join(', ') || 'nothing'}${a.discarded.length ? `, and thrown away for being outside the two files: ${a.discarded.join(', ')}` : ''}\n\n${a.diff ? `\`\`\`diff\n${capped(a.diff)}\n\`\`\`\n\n` : ''}How it failed:\n\n\`\`\`\n${a.failure}\n\`\`\``);
  return `${spec}${earlier.length ? `\n\n## Earlier attempts\n\nTheir changes are in the worktree; do not repeat what failed.\n\n${earlier.join('\n\n')}\n` : ''}`;
}

const failureOf = (a: Attempt, i: number) => `attempt ${i + 1} changed ${a.changed.join(', ') || 'nothing'}${a.discarded.length ? ` (discarded: ${a.discarded.join(', ')})` : ''}; ${a.failure.split('\n').slice(0, 12).join('\n  ')}`;

export function runProvision(o: ProvisionOpts): ProvisionResult {
  const { store, home, job, say } = o;
  const plan = o.factory.provisioner;
  if (!plan) throw new AnimusError('profiles.yaml has no provisioner');
  const project = store.project(job.repo);
  if (!project) throw new AnimusError(`Helix no longer has the project ${job.repo}`);
  const now = o.now ?? Date.now;
  const deadline = now() + (o.maxMs ?? MAX_MS);
  const clone = project.dir;
  const base = cloneBase(clone);
  const start = freshBase(clone, o.env);
  const folder = join(home, 'jobs', String(job.id));
  const worktree = join(folder, 'work');
  const checkTree = join(folder, 'check');
  const branch = jobBranch(`provision-${job.id}`);
  const remove = (dir: string) => { rmSync(dir, { recursive: true, force: true }); git(clone, ['worktree', 'prune']); };
  remove(worktree);
  remove(checkTree);
  git(clone, ['worktree', 'add', '--quiet', '-B', branch, worktree, start]);

  const spec = readFileSync(job.spec, 'utf8');
  const attempts: Attempt[] = [];
  let cost = 0;
  const ended = (outcome: ProvisionResult['outcome'], more: Partial<ProvisionResult>): ProvisionResult => ({ outcome, ...more, cost_usd: cost });

  // What the display shows of it: the stage it is in (progress.json, as animus run writes) and each attempt (attempts.json).
  const max = o.maxAttempts ?? MAX_ATTEMPTS;
  const began = new Date().toISOString();
  const records: ProvisionAttempt[] = [];
  const saveRecords = () => writeJson(join(folder, 'attempts.json'), { max, attempts: records });
  const stage = (s: ProvisionStage, who: string) => writeJson(join(folder, 'progress.json'), {
    stage: s, who, at: new Date().toISOString(), started: began, attempt: { n: Math.min(attempts.length + 1, max), of: max }, pid: process.pid, host: hostname(),
  } satisfies Progress);
  /** The attempt under way has ended: how, and what it changed. */
  const finish = (r: Partial<ProvisionAttempt>) => {
    const a = records.at(-1)!;
    Object.assign(a, r, { ms: Date.now() - Date.parse(a.started) });
    saveRecords();
  };

  /** The add check on the branch as it stands: why it failed, or the output that is its proof. */
  const check = (): { why?: string; image?: string; proof: string[] } => {
    const lines: string[] = [];
    let given: Record<string, string> = {};
    const sayIt = (line: string) => { const m = mask(line, Object.values(given)); lines.push(m); say(m); };
    // A gate may print a secret: why the check failed goes into the next prompt and the job's reason, so it is masked as the add check's is.
    const fail = (why: string) => ({ why: mask(why, Object.values(given)), proof: lines });
    remove(checkTree);
    git(clone, ['worktree', 'add', '--quiet', '--detach', checkTree, branch]);
    try {
      let profile;
      try { profile = loadProfile(checkTree); } catch (err) { return fail((err as Error).message); }
      given = secretsFor(home, job.repo, job.person, profile.secrets);
      for (const s of profile.secrets) {
        const why = missingSecret(home, job.repo, job.person, s);
        if (why) return fail(why);
      }
      let image: string | undefined;
      if (o.image) stage('image', 'docker builds the project image');
      try { image = o.image?.(readDockerfile(checkTree, 'HEAD'), profile.base); } catch (err) { if (err instanceof ImageFailed) return fail(err.message); throw err; }
      if (!profile.setup && !profile.installs.length && !Object.keys(profile.commands).length) { sayIt('the profile has no installs, setup or gates to try'); return { ...(image ? { image } : {}), proof: lines }; }
      stage('check', "the profile's setup and every gate run");
      const why = runEnvironment({ setup: o.setup, worktree: checkTree, clone, env: { ...o.env, ...given }, image, profile, on: branch, say: sayIt });
      return { ...(why ? { why: fail(why).why } : {}), ...(image ? { image } : {}), proof: lines };
    } finally { remove(checkTree); }
  };

  try {
    // The session runs in the project's current image: the base's Dockerfile at first, then what the last attempt built.
    let image: string | undefined;
    try { image = o.image?.(readDockerfile(clone, start), base); } catch (err) { if (!(err instanceof ImageFailed)) throw err; }
    while (attempts.length < max && now() < deadline) {
      const n = attempts.length + 1;
      say(`attempt ${n}: an agent session on ${branch}${image ? `, in ${image}` : ''}`);
      records.push({ n, started: new Date().toISOString(), changed: [], result: 'running' });
      saveRecords();
      stage('agent', 'the agent edits the Dockerfile and profile');
      const before = git(worktree, ['rev-parse', 'HEAD']);
      const discard = () => { git(worktree, ['reset', '--hard', '--quiet', before]); git(worktree, ['clean', '-fdq']); };
      const r = o.session({
        role: 'provisioner', tier: plan.tier, effort: plan.effort, prompt: prompt(spec, attempts), cwd: worktree,
        system: readPrompt('provisioner'), schema: SCHEMA, maxUsd: plan.max_usd, timeoutMs: Math.max(1, deadline - now()), env: o.env,
      }, image);
      cost += r.cost_usd;
      const answer = (r.output ?? {}) as { status?: string; summary?: string; reason?: string };
      if (r.ok && answer.status === 'not-environment') {
        discard();
        const reason = `not an environment problem: ${answer.reason ?? answer.summary ?? 'the agent gave no reason'}`;
        say(reason);
        finish({ result: 'failed', ...(answer.summary ? { summary: answer.summary } : {}), why: reason });
        return ended('failed', { reason });
      }
      if (!r.ok) {
        discard();
        attempts.push({ changed: [], discarded: [], diff: '', failure: `the agent session ended with ${r.status}, so nothing it did was kept` });
        say(`attempt ${n}: ${attempts[n - 1]!.failure}`);
        finish({ result: 'failed', why: attempts[n - 1]!.failure });
        continue;
      }
      // Whatever the session did, committed or not, is one change against where it started.
      git(worktree, ['add', '-A']);
      const changed = git(worktree, ['diff', '--cached', '--name-only', '--no-renames', before]).split('\n').filter(Boolean);
      const other = changed.filter((f) => !ALLOWED.includes(f));
      if (other.length) {
        discard();
        attempts.push({ changed, discarded: other, diff: '', failure: `it changed files other than ${ALLOWED.join(' and ')}, so its changes were thrown away` });
        say(`attempt ${n}: ${attempts[n - 1]!.failure}: ${other.join(', ')}`);
        finish({ result: 'failed', changed, discarded: other, ...(answer.summary ? { summary: answer.summary } : {}), why: `${attempts[n - 1]!.failure}: ${other.join(', ')}` });
        continue;
      }
      const diff = changed.length ? git(worktree, ['diff', '--cached', before]) : '';
      git(worktree, ['reset', '--soft', '--quiet', before]);
      if (changed.length) git(worktree, ['commit', '--quiet', '--no-verify', '-m', `Provision attempt ${n}: ${answer.summary ?? 'change the environment'}`]);
      say(`attempt ${n} changed ${changed.join(', ') || 'nothing'}: ${answer.summary ?? ''}`);
      Object.assign(records.at(-1)!, { changed, ...(answer.summary ? { summary: answer.summary } : {}) });
      saveRecords();

      const checked = check();
      image = checked.image;
      if (!checked.why) {
        say('the add check passed');
        finish({ result: 'passed' });
        if (!Number(git(clone, ['rev-list', '--count', `${start}..${branch}`]))) {
          return ended('failed', { reason: `the add check passes on ${base} with no change to ${ALLOWED.join(' or ')}: add the project again` });
        }
        stage('pr', 'opening the pull request');
        const url = (o.publish ?? realPublish)({ cwd: worktree, branch, baseBranch: base, title: job.title, body: body(job, attempts.length + 1, checked.proof, answer.summary), draft: false });
        return ended('pr', { pr: url });
      }
      say(`attempt ${n}: the add check failed: ${checked.why.split('\n')[0]}`);
      attempts.push({ changed, discarded: [], diff, failure: failureExcerpt(checked.why, 30) });
      finish({ result: 'failed', why: checked.why });
    }
    const stop = attempts.length >= max ? `${attempts.length} attempts` : 'the time it may take';
    // The first line is what a list shows, so it says why the last attempt failed; every attempt follows.
    const last = attempts.at(-1)?.failure.split('\n')[0]?.replace(/:$/, '');
    return ended('failed', { reason: `the add check still fails after ${stop}${last ? `, the last because ${last}` : ''}\n${attempts.map(failureOf).join('\n')}` });
  } finally {
    remove(worktree);
  }
}

/** The pull request's description: what it is, and the check's output as its proof. */
function body(job: HelixJob, attempt: number, proof: string[], summary?: string): string {
  const output = failureExcerpt(proof.join('\n'), 60).replaceAll('```', "'''");
  return `${summary ?? job.title}\n\nProvision job ${job.id}: changes \`${DOCKERFILE}\` and \`${PROFILE_PATH}\` only, found by attempt ${attempt}.\n\n## Proof\n\nThe add check passed on this branch:\n\n\`\`\`\n${output}\n\`\`\`\n`;
}
