// The supervisor: the queue and its loop are the plugin's (plugin/src/queue.ts);
// this starts each job the queue says fits as its own `animus run` process with
// the submitter's credentials in its environment and nobody else's. It holds no
// state of its own: the table says what is queued and running, and Animus's
// job files say how far a job got, so after a crash the queue puts what was
// running back and resumes it.
import { spawn, type ChildProcess } from 'node:child_process';
import { appendFileSync, existsSync, mkdirSync, readFileSync, writeFileSync } from 'node:fs';
import { basename, dirname, isAbsolute, join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { AnimusError } from '../../plugin/src/proc.ts';
import { specInBody } from '../../plugin/src/fix.ts';
import { countUses } from '../../plugin/src/lessons.ts';
import { animusHome, CANCELLED_MARKER, loadProgress, readRuns, type Progress } from '../../plugin/src/log.ts';
import type { PersonalSkill } from '../../plugin/src/personal.ts';
import { loadFactory, resolvePlan, type Tier } from '../../plugin/src/profiles.ts';
import { parseSpec } from '../../plugin/src/spec.ts';
import { isOwner } from './owner.ts';
import { createQueue, MAX_INTERRUPTIONS } from '../../plugin/src/queue.ts';
import type { Reading } from '../../plugin/src/room.ts';
import { credentialEnv, personEnv, readyRepos, type Config } from './config.ts';
import { GITHUB, githubRepo, liveTokenFile, type GitHubUrls } from './github-app.ts';
import { readPull } from './github-comments.ts';
import type { HelixJob, Store } from './store.ts';
import { earlierOf, findOnGitHub, waitingFor, type FindPull } from './waiting.ts';

export const PLUGIN = join(dirname(fileURLToPath(import.meta.url)), '..', '..', 'plugin');

/**
 * How a job's process is started. env is what the job runs with (the
 * person's credentials and Animus's variables); a launch may add to it, and
 * names the folder to start in.
 */
export type Launch = (job: HelixJob, repoDir: string, env: Record<string, string>) => { command: string; args: string[]; env?: Record<string, string>; cwd?: string };

/** What `animus` is asked to do for a job: run it, or resume one that ran before. */
export const animusArgs = (job: HelixJob, repoDir: string): string[] => {
  if (job.animus_job) return ['resume', job.animus_job, ...(job.answer ? ['--answer', job.answer] : [])];
  const skills = existsSync(skillsFile(job)) ? ['--skills', skillsFile(job)] : [];
  const references = existsSync(referencesDir(job)) ? ['--references', referencesDir(job)] : [];
  // `--` keeps an ask that starts with a dash from being read as an option.
  if (job.ask) return ['fix', '--repo', repoDir, ...skills, ...references, '--', job.pr!, job.ask!];
  return ['run', job.spec, '--repo', repoDir, ...(job.draft ? ['--draft'] : []), ...skills];
};

/** Where Helix keeps the skills a person sent with a spec: beside it, so a job's container sees them where the spec is. */
export const skillsFile = (job: Pick<HelixJob, 'spec'>) => join(dirname(job.spec), 'skills.json');
/** Where Helix keeps what a script fetched for a fix (its pull request's reviews), one file each as a draft's references are. */
export const referencesDir = (job: Pick<HelixJob, 'spec'>) => join(dirname(job.spec), 'references');

/** The same command a person runs on a laptop, on this machine as Helix's account. */
const animus: Launch = (job, repoDir) => ({
  command: process.execPath,
  args: ['--disable-warning=ExperimentalWarning', join(PLUGIN, 'src', 'cli.ts'), ...animusArgs(job, repoDir)],
});

export { MAX_INTERRUPTIONS };

/** Looks at a person's credentials before their job starts: why the job cannot run, or variables to add to it (the person's git identity). */
export type Preflight = (person: string, env: Record<string, string>, repoDir: string, repo: string) => { why?: string; env?: Record<string, string> };

/** github: the issue it was submitted from, which its progress is told on. */
export type Submission = { repo: string; spec: string; name?: string; draft?: boolean; skills?: PersonalSkill[]; github?: { repo: string; issue: number } };

/** While this file is in Helix's home, no job starts; submissions still queue. `helix upgrade` sets it to drain the machine. */
export const pauseFile = (home: string) => join(home, 'paused');
/** What `helix upgrade` writes in the pause file: the next `helix serve` takes the pause off. */
export const UNTIL_RESTART = 'until restart';

/**
 * A fix on an open pull request (GLOSSARY.md): the pull request as a number, `#number` or its URL, and what to change.
 * From a /animus fix comment: github, the pull request it reports on, and references, files fetched for it by name.
 */
export type FixRequest = { repo: string; pr: string; ask: string; skills?: PersonalSkill[]; github?: { repo: string; issue: number }; references?: { name: string; text: string }[] };

export type Supervisor = {
  submit(person: string, s: Submission): HelixJob;
  /** Queues a fix of an open Animus pull request whose author is a person here, asked by that person or the owner; it runs as the author's person. */
  fix(person: string, f: FixRequest): Promise<HelixJob>;
  cancel(person: string, id: number): HelixJob;
  answer(person: string, id: number, text: string): HelixJob;
  log(id: number, lines?: number): string;
  /** Where a running job says it is, from the Animus state it writes. */
  progress(job: HelixJob): Progress | undefined;
  /** The Animus home a person's jobs keep their folders and run log in. */
  animusHome(person: string): string;
  /** Starts what the queue holds while slots are free: after the config changed, or a pause ended. */
  wake(): void;
  /** Looks at the waiting jobs' earlier pull requests (about each minute): a merged one queues its job, a closed one fails it. */
  poll(): Promise<void>;
  /** Stops starting jobs and ends the ones running. */
  stop(): void;
};

export class Refused extends AnimusError {
  status: number;
  constructor(status: number, message: string) { super(message); this.status = status; }
}

/**
 * Tells the job, before it is killed, that it was cancelled and not just stopped: it leaves this file beside its spec.
 * Only beside a spec with an absolute path: a job with none has no folder, and a relative one would put the file wherever Helix runs.
 */
function markCancelled(job: Pick<HelixJob, 'spec'>): void {
  if (!isAbsolute(job.spec)) return;
  try { writeFileSync(join(dirname(job.spec), CANCELLED_MARKER), ''); } catch { /* the job's folder is gone: nothing is left to tell */ }
}

/** Ends a job's process. A job is a tree (animus, the agent, the project's checks): the whole group goes where there is one. */

function kill(pid: number, child?: ChildProcess): void {
  try {
    if (process.platform !== 'win32') process.kill(-pid, 'SIGTERM');
    else if (child) child.kill();
    else process.kill(pid);
  } catch { /* already gone */ }
}

/** Whether a job can no longer be cancelled: it ended, failed or was cancelled already. */
export const jobIsOver = (job: HelixJob): boolean => job.state === 'ended' || job.state === 'cancelled';

/**
 * Cancels a person's queued, waiting and running jobs, from any process: `helix
 * remove-person` runs beside `helix serve`, which sees the job's process end
 * and leaves the table as this says. Jobs that already ended are kept.
 */
export function cancelJobsOf(store: Store, person: string, reap: (id: number) => void = () => {}): HelixJob[] {
  const now = new Date().toISOString();
  const theirs = [...store.inState('queued'), ...store.inState('waiting'), ...store.inState('running')].filter((j) => j.person === person);
  for (const job of theirs) {
    const { pid, ...rest } = job;
    store.save({ ...rest, state: 'cancelled', ended: now, reason: `${person} was removed from Helix` });
    markCancelled(job);
    if (pid) kill(pid);
    reap(job.id);
  }
  return theirs;
}

export function supervise(opts: {
  store: Store; config: Config; home: string; launch?: Launch; preflight?: Preflight; say?: (line: string) => void;
  /** Runs before each job, ahead of preflight, while the job holds its slot: a fresh GitHub token (github-app.ts beforeJob). Throws why the job cannot run. */
  prepare?: (person: string, repo: string) => Promise<void>;
  /** Brings the clone the job runs in up to date with its base branch on GitHub, with the job's environment; throws why it cannot. Left out with containers, which do it inside (container.ts jobCommand). */
  fresh?: (repoDir: string, env: Record<string, string>) => unknown;
  /** Admits a queued job's spec against its project on GitHub as it starts, with the job's environment: the list of problems when it no longer passes, nothing when it does. Throws why it cannot be read, which fails the job. */
  admit?: (job: HelixJob, repoDir: string, env: Record<string, string>) => string | undefined;
  /** Ends what a job leaves running outside its process tree (its container). */
  reap?: (id: number) => void;
  /** The Animus home a person's jobs write their state to, when it is not Helix's own. */
  animusHomeOf?: (person: string) => string;
  /** Told each job as it starts and as it ends, however it was submitted: the Slack bot posts it. */
  notify?: (job: HelixJob) => void;
  /** Reads the machine's free memory and load before each start; the machine's own by default, fixed ones in tests. */
  machine?: () => Reading;
  /** Where GitHub is, for reading the pull request a fix is asked on; github.com by default. */
  github?: GitHubUrls;
  /** Finds the pull request of the spec a waiting job runs after; GitHub's, read with the person's token, by default. */
  findPull?: FindPull;
}): Supervisor {
  const { store, config, home } = opts;
  const launch = opts.launch ?? animus;
  const say = opts.say ?? (() => {});
  const reap = opts.reap ?? (() => {});
  const notify = opts.notify ?? (() => {});
  /** Saves a job that started or ended, and says so to notify. */
  const saveAndTell = (job: HelixJob) => { store.save(job); notify(job); };
  const children = new Map<number, ChildProcess>();
  const now = () => new Date().toISOString();
  const logFile = (id: number) => join(home, 'jobs', String(id), 'log.txt');

  const mine = (person: string, id: number): HelixJob => {
    const job = store.get(id);
    if (!job) throw new Refused(404, `no job ${id}`);
    if (job.person !== person) throw new Refused(403, `job ${id} is ${job.person}'s`);
    return job;
  };

  /** Refuses a repository Helix does not have, or has not finished checking. */
  const readyProject = (repo: string): void => {
    const project = store.project(repo);
    if (project?.state === 'checking') throw new Refused(409, `Helix is still checking the project ${repo}: animus project list says when it is ready`);
    if (project?.state !== 'ready') throw new Refused(400, `Helix has no project named ${repo}; it has ${Object.keys(readyRepos(store)).join(', ') || 'none'}. Add it from a checkout of it: animus project add`);
  };

  /** Starts a job's process; false when the job ended without one. */
  function start(job: HelixJob): boolean {
    const project = store.project(job.repo);
    const repoDir = project?.state === 'ready' ? project.dir : '';
    const person = store.person(job.person);
    mkdirSync(dirname(logFile(job.id)), { recursive: true });
    let env: NodeJS.ProcessEnv;
    let launched: ReturnType<Launch>;
    try {
      // Taken off since the job was queued: it never runs, and never with the machine's own logins in place of theirs.
      if (!person) throw new AnimusError(`${job.person} is no longer on Helix`);
      if (!repoDir) throw new AnimusError(`Helix no longer has the project ${job.repo}`);
      const live = liveTokenFile(job.person);
      // Signed in with the GitHub App: git and Animus's gh read the token as it is when they use it (github-app.ts liveTokenDir).
      const theirs = { ...personEnv(person), ...(existsSync(live) ? { ANIMUS_GH_TOKEN_FILE: live } : {}) };
      const looked = opts.preflight?.(job.person, theirs, repoDir, job.repo) ?? {};
      if (looked.why) throw new AnimusError(looked.why);
      // What the person set themselves wins over what was looked up.
      const jobEnv = { ...looked.env, ...theirs, ...credentialEnv(theirs), ANIMUS_USER: job.person, ANIMUS_TRIGGER: 'helix', ...(job.github ? { ANIMUS_CLOSES: String(job.github.issue) } : {}), ANIMUS_BIN: join(PLUGIN, 'bin', 'animus') };
      // The profile is read from the base branch as GitHub has it now, with the person's token as their pushes use.
      opts.fresh?.(repoDir, jobEnv);
      // A queued job is admitted again: the profile may have changed since it was submitted. A resumed one was admitted when it first started.
      // A fix has no spec of its own: the animus process reads the spec of the job it continues, or of its pull request.
      const refused = job.animus_job || job.ask ? undefined : opts.admit?.(job, repoDir, jobEnv);
      if (refused) {
        saveAndTell({ ...job, state: 'ended', ended: now(), outcome: 'refused', reason: refused });
        say(`job ${job.id} was refused before it started: ${refused.split('\n')[0]}`);
        return false;
      }
      launched = launch(job, repoDir, jobEnv);
      env = { ...process.env, ...jobEnv, ...launched.env };
    } catch (err) {
      saveAndTell({ ...job, state: 'ended', ended: now(), outcome: 'failed', reason: (err as Error).message });
      say(`job ${job.id} did not start: ${(err as Error).message}`);
      return false;
    }
    const child = spawn(launched.command, launched.args, { cwd: launched.cwd ?? repoDir, env, detached: process.platform !== 'win32', stdio: ['ignore', 'pipe', 'pipe'] });
    children.set(job.id, child);
    const { answer: _used, ...rest } = job;
    let running: HelixJob = { ...rest, state: 'running', started: now(), ...(child.pid ? { pid: child.pid } : {}) };
    saveAndTell(running);
    say(`job ${job.id} started for ${job.person}: ${job.title}`);

    let out = '';
    child.stdout!.on('data', (chunk: Buffer) => { out += chunk.toString(); });
    child.stderr!.on('data', (chunk: Buffer) => {
      const text = chunk.toString();
      appendFileSync(logFile(job.id), text);
      const id = /^job (\S+): /m.exec(text)?.[1];
      if (id && !running.animus_job && !queue.stopped()) {
        running = { ...running, animus_job: id };
        // Saved onto what the table says now: a job cancelled before this line came stays cancelled.
        const current = store.get(job.id);
        if (current?.state === 'running') store.save({ ...current, animus_job: id });
      }
    });
    const end = (fallback: string) => {
      if (!children.delete(job.id) || queue.stopped()) return;
      const current = store.get(job.id);
      // Cancelled, or put back in the queue by stop(): what the table says stands.
      if (current?.state === 'running') {
        let result: { outcome?: string; pr?: string; reason?: string; question?: string; cost_usd?: number } = {};
        try { result = JSON.parse(out) as typeof result; } catch { /* it died before it could say */ }
        const { pid: _pid, ...kept } = current;
        saveAndTell({
          ...kept, state: 'ended', ended: now(), outcome: result.outcome ?? 'failed',
          ...(result.pr ? { pr: result.pr } : {}), ...(result.question ? { question: result.question } : {}), ...(result.cost_usd !== undefined ? { cost_usd: result.cost_usd } : {}),
          ...(result.reason ?? (result.outcome ? undefined : fallback) ? { reason: result.reason ?? fallback } : {}),
        });
        say(`job ${job.id} ended: ${result.outcome ?? 'failed'}${result.pr ? ` ${result.pr}` : ''}`);
        // A container job was given Helix's lessons read-only and cannot count them: its run line says which.
        // The person's home is the job's to write, so nothing read from it may stop Helix: a failure is said and the queue goes on.
        try {
          const home = opts.animusHomeOf?.(current.person);
          const given = home && current.started ? readRuns(join(home, 'runs.jsonl')).findLast((r) => r.job === current.animus_job && Date.parse(r.ended) >= Date.parse(current.started!))?.lessons : undefined;
          const ids = Array.isArray(given) ? given.filter((n): n is number => Number.isInteger(n)) : [];
          if (ids.length) countUses(ids);
        } catch (err) {
          say(`job ${job.id}: lesson uses not counted: ${err instanceof Error ? err.message : String(err)}`);
        }
      }
      queue.release(job.id);
    };
    child.on('error', (err) => end(`could not start: ${err.message}`));
    child.on('close', (code, signal) => {
      // Animus says why on its last line when it refuses to start a job.
      const last = existsSync(logFile(job.id)) ? readFileSync(logFile(job.id), 'utf8').trimEnd().split('\n').pop() : undefined;
      end(`animus ended with ${signal ?? `exit ${code}`} and no result${last ? `: ${last.replace(/^(animus|helix): /, '')}` : ''}`);
    });
    return true;
  }

  const { prepare } = opts;
  const findPull = opts.findPull ?? findOnGitHub(store, config, opts.github ?? GITHUB);
  const queue = createQueue<HelixJob>({
    store, config, name: 'Helix', say, reap, start, end: saveAndTell,
    earlier: (job) => earlierOf(findPull, job),
    jobMemory: config.container?.memory,
    ...(prepare ? { prepare: (job: HelixJob) => prepare(job.person, job.repo) } : {}),
    ...(opts.machine ? { machine: opts.machine } : {}),
    paused: () => existsSync(pauseFile(home)),
    kill(job) {
      const child = children.get(job.id);
      const pid = child?.pid ?? job.pid;
      if (pid) kill(pid, child);
    },
  });
  const tick = queue.tick;
  queue.begin();

  return {
    async fix(person, f) {
      readyProject(f.repo);
      const repo = githubRepo(store.project(f.repo)!.url);
      if (!repo) throw new Refused(400, `the project ${f.repo} is not on GitHub, so Helix cannot fix its pull requests`);
      const asked = f.pr.trim();
      const n = Number(/^#?(\d+)$/.exec(asked)?.[1] ?? (asked.toLowerCase().includes(`/${repo.toLowerCase()}/pull/`) ? /\/pull\/(\d+)\/?$/.exec(asked)?.[1] : undefined));
      if (!n) throw new Refused(400, `${asked} is not a pull request of ${repo}: give its number or its address`);
      let pull: Awaited<ReturnType<typeof readPull>>;
      try { pull = await readPull(store, config, opts.github ?? GITHUB, person, repo, n); } catch (err) { throw err instanceof Refused ? err : new Refused(502, (err as Error).message); }
      if (!pull) throw new Refused(404, `GitHub has no pull request ${n} on ${repo}`);
      if (pull.merged || pull.state !== 'open') throw new Refused(409, `pull request ${f.pr} is ${pull.merged ? 'merged' : 'closed'}, so it cannot be fixed`);
      if (!specInBody(pull.body)) throw new Refused(400, `pull request ${f.pr} holds no Animus spec block, so no Animus job opened it and there is nothing to fix`);
      const author = Object.entries(store.people()).find(([, p]) => p.github?.toLowerCase() === pull.author.toLowerCase())?.[0];
      if (!author) throw new Refused(403, `pull request ${f.pr} was opened by ${pull.author}, who is not a person on this Helix, so Helix cannot fix it`);
      if (person !== author && !isOwner(config, person)) throw new Refused(403, `pull request ${f.pr} was opened by ${author}: only ${author} or the owner may fix it`);
      const onPr = store.list().filter((j) => j.repo === f.repo && j.pr?.endsWith(`/pull/${n}`));
      const active = onPr.find((j) => j.ask && (j.state === 'queued' || j.state === 'running' || (j.state === 'ended' && j.outcome === 'needs-input')));
      const page = config.url ? ` (${config.url.replace(/\/+$/, '')}/jobs/${active?.id})` : '';
      if (active) throw new Refused(409, `pull request ${f.pr} has a fix ${active.state === 'ended' ? 'waiting for an answer' : active.state}: job ${active.id}${page}`);
      // The author's latest job that ended in it (a fix that failed has none to its name), whose session the fix resumes; with none, `animus fix` runs from the pull request alone.
      const target = onPr.filter((j) => j.person === author && j.state === 'ended' && (j.outcome === 'pr' || j.outcome === 'draft-pr')).sort((a, b) => a.id - b.id).at(-1);
      // It runs as the author's person: their folder holds the worktree and session it continues, and their token pushes to the branch.
      const job = store.add({
        state: 'queued', person: author, repo: f.repo, spec: '', title: `fix: ${target?.title ?? pull.title}`, ...(target?.tier ? { tier: target.tier } : {}), draft: false,
        pr: target?.pr ?? pull.url, ...(target ? { fix_of: target.id } : {}), ask: f.ask, ...(f.github ? { github: f.github } : {}), submitted: now(),
      });
      // The job's folder is where a container finds what Helix keeps for the job (its skills); a fix has no spec file in it.
      job.spec = join(home, 'jobs', String(job.id), 'fix');
      mkdirSync(dirname(job.spec), { recursive: true });
      // Skills are the author's alone: the owner's are never sent to a job that runs as someone else.
      if (f.skills?.length && person === author) writeFileSync(skillsFile(job), `${JSON.stringify(f.skills, null, 2)}\n`);
      if (f.references?.length) {
        mkdirSync(referencesDir(job), { recursive: true });
        f.references.forEach((r, i) => writeFileSync(join(referencesDir(job), `${i + 1}-${r.name}`), r.text));
      }
      store.save(job);
      store.record(person, 'submitted', { job: job.id, repo: f.repo, ...(target ? { fix_of: target.id } : {}) });
      tick();
      return store.get(job.id)!;
    },
    submit(person, s) {
      readyProject(s.repo);
      let title: string;
      let tier: Tier | undefined;
      let after: string[];
      try {
        const spec = parseSpec(s.spec, s.name ?? 'spec.md');
        title = spec.title;
        after = spec.after;
        // A spec the factory will not run fails in its own time; here it only goes uncounted.
        try { tier = resolvePlan(loadFactory(), spec).implement.tier; } catch { /* no tier */ }
      } catch (err) { throw new Refused(400, (err as Error).message); }
      // A spec that runs after another waits in the queue, with no slot and no process, until that spec's pull request is merged; the first look is now.
      const job = store.add({
        state: after.length ? 'waiting' : 'queued', person, repo: s.repo, spec: '', title, ...(tier ? { tier } : {}), draft: Boolean(s.draft), ...(s.github ? { github: s.github } : {}), submitted: now(),
        ...(after.length ? { after, waiting: waitingFor(after[0]!) } : {}),
      });
      job.spec = join(home, 'jobs', String(job.id), basename(s.name ?? 'spec.md'));
      mkdirSync(dirname(job.spec), { recursive: true });
      writeFileSync(job.spec, s.spec);
      if (s.skills?.length) writeFileSync(skillsFile(job), `${JSON.stringify(s.skills, null, 2)}\n`);
      store.save(job);
      store.record(person, 'submitted', { job: job.id, repo: s.repo });
      tick();
      if (after.length) void queue.poll();
      return store.get(job.id)!;
    },
    cancel(person, id) {
      const job = mine(person, id);
      if (jobIsOver(job)) throw new Refused(409, `job ${id} has already ${job.state === 'cancelled' ? 'been cancelled' : 'ended'}`);
      store.record(person, 'cancelled', { job: id });
      markCancelled(job);
      return queue.cancel(job);
    },
    answer(person, id, text) {
      const job = mine(person, id);
      if (job.state !== 'ended' || job.outcome !== 'needs-input') throw new Refused(409, `job ${id} is not waiting for an answer`);
      store.record(person, 'answered', { job: id, answer: text });
      return queue.answer(job, text);
    },
    log(id, lines = 200) {
      if (!existsSync(logFile(id))) return '';
      return readFileSync(logFile(id), 'utf8').trimEnd().split('\n').slice(-lines).join('\n');
    },
    wake: () => tick(),
    poll: () => queue.poll(),
    progress: (job) => (job.animus_job ? loadProgress(job.animus_job, opts.animusHomeOf?.(job.person)) : undefined),
    animusHome: (person) => opts.animusHomeOf?.(person) ?? animusHome(),
    stop: () => queue.stop(),
  };
}
