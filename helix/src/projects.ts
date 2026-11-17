// Projects people add themselves (`animus project add`). Anyone on Helix may
// add one, and anyone whose GitHub token may push to it may submit for it:
// GitHub is the member list, so Helix keeps none. A project is taken only
// once it has been checked in a process of its own: Helix clones it with the
// adder's token, sees that token may push, reads its profile, and runs the
// profile's installs and setup once as a job would, in a container when jobs
// run in one. A project that fails the check says why and can be added again.
import { spawn, spawnSync } from 'node:child_process';
import { appendFileSync, existsSync, mkdirSync, readdirSync, readFileSync, rmSync } from 'node:fs';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { githubUrl } from '../../plugin/src/git.ts';
import { loadProfile, PROFILE_PATH } from '../../plugin/src/profile.ts';
import { failureExcerpt } from '../../plugin/src/proc.ts';
import { githubPush, type Runner } from './check.ts';
import { checkName, credentialEnv, personEnv, type Config } from './config.ts';
import { personDirs, runArgs, type ContainerConfig } from './container.ts';
import { isOwner } from './owner.ts';
import type { Project, Store } from './store.ts';
import { Refused } from './supervisor.ts';

/** Where Helix keeps its clone of a project it added. */
export const projectDir = (home: string, name: string) => join(home, 'repos', name);
/** A project's check: its log, and the worktree its setup is tried in. */
export const checkFolder = (home: string, name: string) => join(home, 'projects', name);
export const checkLog = (home: string, name: string) => join(checkFolder(home, name), 'check.log');

/** Starts a project's check and returns at once; the check moves the project to ready or failed. */
export type StartCheck = (name: string) => void;

/** `POST /projects`: takes the project as checking and starts its check. */
export function addProject(opts: { store: Store; home: string; startCheck: StartCheck; at?: Date }, person: string, body: Record<string, unknown>): Project {
  const { store, home } = opts;
  const { name, url: given } = body;
  if (typeof name !== 'string' || typeof given !== 'string') throw new Refused(400, 'a project needs name (what submissions call it) and url (its GitHub address)');
  try { checkName(name, 'a project\'s name'); } catch (err) { throw new Refused(400, (err as Error).message); }
  const url = githubUrl(given);
  if (!url) throw new Refused(400, `${given} is not a GitHub repository's address`);
  const known = store.project(name);
  if (known?.state === 'checking') throw new Refused(409, `Helix is already checking ${name}`);
  if (known?.state === 'ready') throw new Refused(409, known.url === url ? `${name} is already on Helix` : `Helix already has a project named ${name}, for ${known.url || 'a clone with no origin'}: choose another name`);
  const same = store.projects().find((p) => p.url === url && p.state !== 'failed');
  if (same) throw new Refused(409, `${url} is already on Helix as ${same.name}`);
  const project: Project = { name, url, dir: projectDir(home, name), state: 'checking', added: (opts.at ?? new Date()).toISOString(), added_by: person };
  store.putProject(project);
  store.record(person, 'project-added', { project: name });
  rmSync(checkLog(home, name), { force: true });
  opts.startCheck(name);
  return project;
}

/** `GET /projects/<name>`: the project and its check's log. */
export function projectView(store: Store, home: string, name: string): Project & { log: string } {
  const project = store.project(name);
  if (!project) throw new Refused(404, `Helix has no project named ${name}`);
  const file = checkLog(home, name);
  return { ...project, log: existsSync(file) ? readFileSync(file, 'utf8') : '' };
}

/**
 * Deletes what Helix made for a project: each person's clone of it, its
 * check's folder, and its own clone when Helix made that too. A clone added
 * on the machine (helix add-repo) is someone's own and stays.
 */
export function forgetProject(home: string, project: Project): void {
  const people = join(home, 'people');
  // A project added again under this name may be another repository: no clone of the old one may be found for it.
  if (existsSync(people)) for (const person of readdirSync(people)) rmSync(join(personDirs(home, person).repos, project.name), { recursive: true, force: true });
  rmSync(checkFolder(home, project.name), { recursive: true, force: true });
  if (project.added_by && project.dir === projectDir(home, project.name)) rmSync(project.dir, { recursive: true, force: true });
}

/** `DELETE /projects/<name>`: only whoever added it or the owner, and only with none of its jobs queued or running. */
export function removeProject(opts: { store: Store; home: string; config: Pick<Config, 'owner'> }, person: string, name: string): Project {
  const { store, home } = opts;
  const project = store.project(name);
  if (!project) throw new Refused(404, `Helix has no project named ${name}`);
  if (project.added_by !== person && !isOwner(opts.config, person)) throw new Refused(403, `${name} was added ${project.added_by ? `by ${project.added_by}` : 'on the machine'}: only ${project.added_by ?? 'whoever runs Helix'} can remove it${project.added_by ? ', or whoever runs Helix' : ''} (helix remove-repo ${name})`);
  if (project.state === 'checking') throw new Refused(409, `Helix is still checking ${name}: remove it once the check ends`);
  const busy = [...store.inState('queued'), ...store.inState('running')].filter((j) => j.repo === name);
  if (busy.length) throw new Refused(409, `job(s) ${busy.map((j) => j.id).join(', ')} are queued or running for ${name}: wait for them, or cancel them, first`);
  store.dropProject(name);
  store.record(person, 'project-removed', { project: name });
  forgetProject(home, project);
  return project;
}

/** Runs the profile's installs and setup in a worktree of the project's clone: on the machine, or in a container. */
export type SetupRun = (worktree: string, clone: string, env: Record<string, string>) => { code: number; output: string };

const CLI = join(dirname(fileURLToPath(import.meta.url)), 'cli.ts');
const SETUP_MS = 30 * 60 * 1000;

/** The setup run as Helix's account on the machine, as jobs run without containers. */
export const setupHere: SetupRun = (worktree, _clone, env) => {
  const r = spawnSync(process.execPath, ['--disable-warning=ExperimentalWarning', CLI, 'setup', worktree], { encoding: 'utf8', timeout: SETUP_MS, env: { ...process.env, ...env } });
  return { code: r.status ?? 1, output: `${r.stdout ?? ''}${r.stderr ?? ''}${r.error ? r.error.message : ''}` };
};

/** The setup run in the job image, under a job's limits, seeing only the clone, the worktree and Animus. */
export function setupInContainer(opts: { animusRoot: string; image: string; limits: ContainerConfig; uid: number; gid: number; name: string }): SetupRun {
  return (worktree, clone, env) => {
    const args = runArgs({
      name: `helix-check-${opts.name}`, image: opts.image, limits: opts.limits, uid: opts.uid, gid: opts.gid,
      mounts: [{ path: opts.animusRoot, readOnly: true }, { path: clone }, { path: dirname(worktree) }],
      envNames: Object.keys(env).sort(), workdir: worktree,
      command: ['node', '--disable-warning=ExperimentalWarning', join(opts.animusRoot, 'helix', 'src', 'cli.ts'), 'setup', worktree],
    });
    const r = spawnSync('docker', args, { encoding: 'utf8', timeout: SETUP_MS, env: { ...process.env, ...env } });
    if (r.error || r.status !== 0) spawnSync('docker', ['rm', '--force', `helix-check-${opts.name}`], { stdio: 'ignore' });
    return { code: r.status ?? 1, output: `${r.stdout ?? ''}${r.stderr ?? ''}${r.error ? r.error.message : ''}` };
  };
}

const git = (args: string[], opts: { cwd?: string; env: Record<string, string> }) => {
  const r = spawnSync('git', args, { cwd: opts.cwd, encoding: 'utf8', timeout: SETUP_MS, env: { ...process.env, ...opts.env, GIT_TERMINAL_PROMPT: '0' } });
  return { code: r.status ?? 1, out: `${r.stderr ?? ''}${r.stdout ?? ''}`.trim() || (r.error?.message ?? '') };
};

/**
 * The check `helix check-project` runs. What it finds goes to say, line by
 * line, for the person waiting on `animus project add`. Moves the project to
 * ready or failed; whether it is ready.
 */
export function checkProject(opts: { store: Store; home: string; name: string; setup: SetupRun; say: (line: string) => void; runner?: Runner }): boolean {
  const { store, home, name, say } = opts;
  const project = store.project(name);
  if (project?.state !== 'checking') return false;
  // Added again, or removed, while this ran: what is in the table now is not this check's to change.
  const settle = (to: Partial<Project>) => {
    const now = store.project(name);
    if (now?.state === 'checking' && now.added === project.added) store.putProject({ ...now, ...to });
  };
  const fail = (why: string) => { say(`failed: ${why}`); settle({ state: 'failed', reason: why }); return false; };
  const dir = project.dir;
  try {
    const env = personEnv(project.added_by ? store.person(project.added_by) : undefined);
    if (!env.GH_TOKEN && !env.GITHUB_TOKEN) return fail(`${project.added_by ?? 'whoever added it'} has no GitHub token on Helix to clone it with`);
    const withToken = { ...env, ...credentialEnv(env) };

    say(`cloning ${project.url} with ${project.added_by}'s GitHub token`);
    rmSync(dir, { recursive: true, force: true });
    mkdirSync(dirname(dir), { recursive: true });
    const cloned = git(['clone', '--quiet', project.url, dir], { env: withToken });
    if (cloned.code !== 0) return fail(`could not clone ${project.url}: ${cloned.out.split('\n').pop()}. If the repository is private, add it to your GitHub token's repositories on GitHub`);

    const push = githubPush(name, dir, env, opts.runner);
    if (!push.ok) return fail(`your GitHub token may not push to it: ${push.detail}. Add the repository to the token's repositories on GitHub (Settings, Developer settings, Fine-grained tokens), then add it again`);
    say(`your token may push to it`);

    let profile;
    try { profile = loadProfile(dir); } catch (err) {
      return fail(existsSync(join(dir, PROFILE_PATH))
        ? (err as Error).message
        : `its default branch has no ${PROFILE_PATH}. Run animus init in a checkout of it, correct what it drafts, commit and push it, then add it again`);
    }
    say(`${PROFILE_PATH}: base ${profile.base}, gates ${Object.keys(profile.commands).join(', ') || 'none'}`);

    if (!profile.setup && !profile.installs.length) {
      say('the profile has no installs or setup to try');
    } else {
      const fetched = git(['fetch', '--quiet', 'origin', profile.base], { cwd: dir, env: withToken });
      if (fetched.code !== 0) return fail(`its base branch ${profile.base} could not be fetched: ${fetched.out.split('\n').pop()}`);
      const worktree = join(checkFolder(home, name), 'setup');
      rmSync(worktree, { recursive: true, force: true });
      git(['worktree', 'prune'], { cwd: dir, env: {} });
      const added = git(['worktree', 'add', '--quiet', '--detach', worktree, `origin/${profile.base}`], { cwd: dir, env: {} });
      if (added.code !== 0) return fail(`could not make a worktree on ${profile.base}: ${added.out}`);
      say(`running the profile's installs and setup once, as a job would${profile.setup ? `: ${profile.setup}` : ''}`);
      const r = opts.setup(worktree, dir, env);
      git(['worktree', 'remove', '--force', worktree], { cwd: dir, env: {} });
      if (r.code !== 0) return fail(`setup did not pass, so every job would fail at it:\n${failureExcerpt(r.output, 30)}`);
      say('setup passed');
    }
    settle({ state: 'ready' });
    say(`${name} is ready: animus submit <spec.md> from a checkout of it`);
    return true;
  } catch (err) {
    return fail((err as Error).message);
  }
}

/**
 * Starts each check as a `helix check-project` process of its own, so Helix
 * goes on answering while a clone and an install take minutes. Its output is
 * the check's log. A check that dies without a word fails its project.
 * fresh, on a Helix with a GitHub App, refreshes the adder's token first
 * (github-app.ts freshToken); its refusal fails the project.
 */
export function checkInChild(store: Store, home: string, say: (line: string) => void = () => {}, fresh?: (person: string) => Promise<unknown>): StartCheck {
  return (name) => {
    const ended = (why: string) => {
      try {
        const now = store.project(name);
        if (now?.state === 'checking') store.putProject({ ...now, state: 'failed', reason: why });
        say(`project ${name}: ${store.project(name)?.state ?? 'gone'}`);
      } catch { /* Helix is stopping and its table is closed: the next start fails a check left checking */ }
    };
    const check = () => {
      const log = checkLog(home, name);
      mkdirSync(dirname(log), { recursive: true });
      const child = spawn(process.execPath, ['--disable-warning=ExperimentalWarning', CLI, 'check-project', name], { stdio: ['ignore', 'pipe', 'pipe'] });
      const write = (chunk: Buffer) => appendFileSync(log, chunk);
      child.stdout.on('data', write);
      child.stderr.on('data', write);
      child.on('error', (err) => ended(`its check could not start: ${err.message}`));
      child.on('close', (code, signal) => ended(`its check ended with ${signal ?? `exit ${code}`} before it said how it went`));
    };
    const adder = store.project(name)?.added_by;
    if (fresh && adder) void fresh(adder).then(check, (err: unknown) => ended((err as Error).message));
    else check();
    say(`project ${name}: checking`);
  };
}

/** A check that was running when Helix stopped has no process now: its project fails, to be added again. */
export function failInterruptedChecks(store: Store): string[] {
  const stuck = store.projects().filter((p) => p.state === 'checking');
  for (const p of stuck) store.putProject({ ...p, state: 'failed', reason: 'Helix stopped while it checked this project: add it again' });
  return stuck.map((p) => p.name);
}
