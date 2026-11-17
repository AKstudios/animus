// The helix command, run on the machine that runs the jobs.
import { spawn, spawnSync } from 'node:child_process';
import { existsSync, readFileSync, rmSync, unwatchFile, watchFile, writeFileSync } from 'node:fs';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { parseArgs } from 'node:util';
import { claudeAgent } from '../../plugin/src/agent.ts';
import { loadFactory } from '../../plugin/src/profiles.ts';
import { AnimusError } from '../../plugin/src/proc.ts';
import { CLEANUP_EVERY_MS, CLEANUP_FIRST_MS, helixCleanup } from './cleanup.ts';
import { KEEP_DAYS } from '../../plugin/src/cleanup.ts';
import { checkEnv, checkPerson, describeFindings, failing, githubPush, githubToken } from './check.ts';
import { animusVersion } from '../../plugin/src/version.ts';
import { containerLaunch, containerProblem, imageName, personDirs, removeContainer } from './container.ts';
import { addPerson, addRepo, configFile, helixHome, identityEnv, importRegistry, loadConfig, readyRepos, removeRepo } from './config.ts';
import { ensureSetup } from '../../plugin/src/workspace.ts';
import { loadProfile } from '../../plugin/src/profile.ts';
import { checkInChild, checkProject, failInterruptedChecks, forgetProject, setupHere, setupInContainer } from './projects.ts';
import { INVITE_HOURS, invite, takeOff } from './join.ts';
import { serve } from './server.ts';
import { openStore, type Store } from './store.ts';
import { releaseToFollow } from './upgrade.ts';
import { cancelJobsOf, pauseFile, supervise, UNTIL_RESTART } from './supervisor.ts';

/** This checkout of Animus: what `helix upgrade` moves to another release. */
const ROOT = join(dirname(fileURLToPath(import.meta.url)), '..', '..');
const pidFile = () => join(helixHome(), 'serve.pid');
const dbFile = () => join(helixHome(), 'helix.db');

/**
 * Helix's tables, with the people and repositories of a config.yaml from
 * before 0.4 moved into them first.
 */
function openHelix(): Store {
  const store = openStore(dbFile());
  const moved = importRegistry(store);
  if (moved.people.length || moved.repos.length) console.error(`helix: moved ${[moved.people.length ? `people (${moved.people.join(', ')})` : '', moved.repos.length ? `repositories (${moved.repos.join(', ')})` : ''].filter(Boolean).join(' and ')} from ${configFile()} into ${dbFile()}`);
  return store;
}

/** With one store open for a command, closed after it, whatever it throws. */
function withStore<T>(fn: (store: Store) => T): T {
  const store = openHelix();
  try { return fn(store); } finally { store.close(); }
}
const uid = () => process.getuid?.() ?? 1000;
const gid = () => process.getgid?.() ?? 1000;

/** Builds the job image for this release, for this account's uid. */
function buildImage(): boolean {
  const image = imageName(animusVersion());
  console.log(`building ${image}`);
  return run('docker', ['build', '-t', image, '--build-arg', `UID=${uid()}`, '--build-arg', `GID=${gid()}`, join(ROOT, 'helix', 'deploy', 'image')]);
}

const sleep = (ms: number) => { Atomics.wait(new Int32Array(new SharedArrayBuffer(4)), 0, 0, ms); };

const USAGE = `helix: runs Animus jobs for several people on one machine

  helix serve
        Listen for submissions and run them, as many at once as config.yaml's slots.
  helix add-repo <name> <dir>
        A clone on this machine that jobs may be submitted for, ready at
        once. People add projects themselves with animus project add, which
        Helix checks first; this is for one cloned here by hand.
  helix invite <name> [--github <login>]
        Let a person join from their own machine: prints a one-time code that
        ends in ${INVITE_HOURS} hours. They run animus join <this Helix's address> <code>,
        which sends their Claude and GitHub tokens; Helix tries both, keeps
        them under ${helixHome()}/credentials and gives them their Helix token.
        --github: only a GitHub token that signs in as this login is taken.
        Run again for a new code; the earlier one stops working.
  helix add-person <name> [--env-file <file>]
        Let a person submit, and print their token once. The file holds
        KEY=VALUE lines set for their jobs only (CLAUDE_CODE_OAUTH_TOKEN, GH_TOKEN).
        Run again to give them a new token.
  helix remove-person <name>
        Take a person off: their token stops working, their queued and
        running jobs are cancelled, and their credentials file under
        ${helixHome()} is deleted. Prints what is left to do elsewhere.
  helix remove-repo <name>
        Stop taking jobs for a project, whoever added it. People's clones of
        it are deleted, and Helix's own when animus project add made it; one
        added with add-repo stays on disk.
  helix upgrade <tag> | --follow
        Move this machine to a release: stop starting jobs, wait for the
        running ones to end, check out the tag, install, run the tests, and
        restart Helix (its service manager starts it again). If the tests
        fail, the checkout goes back to where it was.
        --follow: to the release origin's stable branch is at, when that is
        not the one here; a release that failed here is not tried again.
        npm run deploy -- <ssh-host> runs this from another machine.
  helix image
        Build the image jobs run in (animus-job:<version>). Jobs run in
        containers when config.yaml has a container: entry.
  helix cleanup [--days <n>] [--dry-run]
        Remove what finished jobs leave on this machine: animus cleanup in
        each person's Animus home, with their credentials (a merged or
        closed pull request's worktree at once, its branches --days after,
        default ${KEEP_DAYS}), and the job images of other releases. Job folders,
        logs and transcripts are kept. helix serve runs it once a day.
  helix check [<name>]
        Try each person's credentials against GitHub and Claude: who the
        GitHub token is, when it ends, whether it may push to each repository,
        and whether the Claude token answers. Exits 1 if any does not.

Its files are under ${helixHome()} (HELIX_HOME). People, projects and the
queue are in helix.db; config.yaml holds the rest, and its slots are read
again whenever it changes. Host and port need a restart.`;

function main(argv: string[]): number | undefined {
  const [command, ...rest] = argv;
  const { values, positionals } = parseArgs({ args: rest, allowPositionals: true, options: { 'env-file': { type: 'string' }, github: { type: 'string' }, follow: { type: 'boolean' }, days: { type: 'string' }, 'dry-run': { type: 'boolean' } } });
  switch (command) {
    case 'serve': {
      const store = openHelix();
      const config = loadConfig();
      const home = helixHome();
      // A GitHub token that ended fails the job before it starts, with the reason.
      const preflight = (_person: string, env: Record<string, string>, repoDir: string, repo: string) => {
        if (!env.GH_TOKEN && !env.GITHUB_TOKEN) return {};
        const f = githubToken(env);
        if (!f.ok) return { why: `the GitHub token in the env file does not work: ${f.detail}` };
        // GitHub decides who may submit for a project: a token that may not push to it would fail at the end.
        const push = githubPush(repo, repoDir, env);
        if (!push.ok) return { why: `your GitHub token may not push to ${repo}: ${push.detail}. Add the repository to the token's repositories on GitHub` };
        // The job's commits, and its screenshots' commit, are the person's as GitHub knows them.
        return f.identity ? { env: identityEnv(f.identity) } : {};
      };
      for (const name of Object.keys(store.people())) {
        const bad = failing(checkPerson(store, name));
        if (bad.length) console.error(describeFindings(name, bad));
      }
      const say = (line: string) => console.error(`${new Date().toISOString().slice(0, 19)} ${line}`);
      // A pause left by helix upgrade ends with the restart it asked for.
      if (existsSync(pauseFile(home)) && readFileSync(pauseFile(home), 'utf8').trim() === UNTIL_RESTART) rmSync(pauseFile(home));
      if (existsSync(pauseFile(home))) say(`${pauseFile(home)} is there, so no job starts until it is removed`);
      for (const name of failInterruptedChecks(store)) say(`project ${name} was being checked when Helix stopped: it failed, to be added again`);
      writeFileSync(pidFile(), `${process.pid}\n`);
      // With containers, a job sees only its person's folders, and Helix never falls back to running it on the machine.
      let isolation = {};
      if (config.container) {
        const image = imageName(animusVersion());
        const problem = containerProblem(image);
        if (problem) throw new AnimusError(`config.yaml asks for containers, but ${problem}`);
        isolation = {
          launch: containerLaunch({ home, animusRoot: ROOT, image, limits: config.container, uid: uid(), gid: gid() }),
          reap: removeContainer,
          animusHomeOf: (person: string) => personDirs(home, person).animus,
        };
      }
      const supervisor = supervise({ store, config, home, preflight, say, ...isolation });
      const server = serve({ config, store, supervisor, home, startCheck: checkInChild(store, home, say), ...(config.container ? { reap: removeContainer } : {}) });
      server.listen(config.port, config.host, () => console.error(`helix ${animusVersion()}: listening on http://${config.host}:${config.port}, ${config.slots} job(s) at once${config.container ? ', each in a container' : ''}, projects: ${Object.keys(readyRepos(store)).join(', ') || 'none yet'}`));
      // Someone changed the slots or the container limits: the same config object, so everything sees it at once.
      watchFile(configFile(), { interval: 2000 }, () => {
        try {
          const fresh = loadConfig();
          if (fresh.host !== config.host || fresh.port !== config.port) say('host and port take effect at the next restart');
          Object.assign(config, { ...fresh, host: config.host, port: config.port });
          say(`config read again: ${config.slots} slot(s)`);
          supervisor.wake();
        } catch (err) { say(`config.yaml did not load, so the last one stands: ${(err as Error).message}`); }
      });
      // What finished jobs leave goes once a day, in a process of its own: Helix goes on answering meanwhile.
      let cleaning = false;
      const clean = () => {
        if (cleaning) return;
        cleaning = true;
        const child = spawn(process.execPath, ['--disable-warning=ExperimentalWarning', fileURLToPath(import.meta.url), 'cleanup'], { stdio: ['ignore', 'pipe', 'pipe'] });
        let out = '';
        child.stdout.on('data', (c: Buffer) => { out += c.toString(); });
        child.stderr.on('data', (c: Buffer) => { out += c.toString(); });
        child.on('error', (err) => { cleaning = false; say(`cleanup did not start: ${err.message}`); });
        child.on('close', (code) => {
          cleaning = false;
          for (const line of out.trimEnd().split('\n').filter(Boolean)) say(`cleanup: ${line}`);
          if (code) say(`cleanup ended with exit ${code}`);
        });
      };
      const first = setTimeout(clean, CLEANUP_FIRST_MS);
      const daily = setInterval(clean, CLEANUP_EVERY_MS);
      const stop = () => { clearTimeout(first); clearInterval(daily); unwatchFile(configFile()); supervisor.stop(); server.close(); store.close(); rmSync(pidFile(), { force: true }); process.exit(0); };
      process.on('SIGINT', stop);
      process.on('SIGTERM', stop);
      return undefined;
    }
    case 'check': {
      return withStore((store) => {
        const names = positionals[0] ? [positionals[0]] : Object.keys(store.people());
        if (positionals[0] && !store.person(positionals[0])) throw new AnimusError(`Helix has no person named ${positionals[0]}`);
        const agent = claudeAgent(loadFactory());
        let ok = true;
        for (const name of names) {
          const findings = checkPerson(store, name, { agent });
          console.log(describeFindings(name, findings));
          ok &&= !failing(findings).length;
        }
        return ok ? 0 : 1;
      });
    }
    case 'cleanup': {
      const days = values.days === undefined ? KEEP_DAYS : Number(values.days);
      if (!Number.isFinite(days) || days < 0) throw new AnimusError(`--days takes a number of days, not ${values.days}`);
      const contained = Boolean(loadConfig().container);
      const ok = withStore((store) => helixCleanup(store, { home: helixHome(), contained, days, dryRun: Boolean(values['dry-run']), version: animusVersion() }, (line) => console.log(line)));
      return ok ? 0 : 1;
    }
    case 'add-repo':
      if (!positionals[0] || !positionals[1]) throw new AnimusError('usage: helix add-repo <name> <dir>');
      withStore((store) => addRepo(store, positionals[0]!, positionals[1]!));
      console.log(`${positionals[0]} is on Helix`);
      return 0;
    case 'remove-person': {
      const name = positionals[0];
      if (!name) throw new AnimusError('usage: helix remove-person <name>');
      const contained = Boolean(loadConfig().container);
      const gone = withStore((store) => takeOff(name, store, contained ? removeContainer : undefined));
      const { kept, cancelled, folder } = gone;
      console.log([
        `${name} is off Helix: their token no longer works${cancelled.length ? `, and job(s) ${cancelled.map((j) => j.id).join(', ')} were cancelled` : ''}.`,
        kept ? `Their credentials file is outside ${helixHome()}, so it was left: delete ${kept}` : 'Their credentials file is deleted.',
        `Their folder ${folder} (clones, job state, Claude config) is deleted.`,
        '',
        'Left to do elsewhere:',
        '  - GitHub: revoke the token they gave Helix (they can, or an org owner under the org\'s personal access tokens), and take them off the organisation or repositories.',
        '  - Claude: take them off your Claude organisation, or have them revoke the token they gave Helix.',
        '  - Tailscale: remove them from the tailnet, which takes their devices off it.',
        '  - Their open animus/* pull requests: close or take over; animus cleanup removes the branches of closed ones.',
      ].join('\n'));
      return 0;
    }
    case 'invite': {
      const name = positionals[0];
      if (!name) throw new AnimusError('usage: helix invite <name> [--github <login>]');
      const made = withStore((store) => invite(store, name, values.github ? { github: values.github } : {}));
      console.log([
        `${name}'s code, shown this once, good until ${made.expires.slice(0, 16).replace('T', ' ')} UTC:`,
        '',
        `  ${made.code}`,
        '',
        'They install the animus plugin in Claude Code, then run:',
        '',
        `  animus join ${loadConfig().url ?? '<the address they reach Helix at; url: in config.yaml fills it in here>'} ${made.code}`,
      ].join('\n'));
      return 0;
    }
    case 'verify': {
      // Run by helix serve for someone joining: their tokens on stdin, the findings on stdout.
      const env = JSON.parse(readFileSync(0, 'utf8')) as Record<string, string>;
      const repos = withStore(readyRepos);
      console.log(JSON.stringify(checkEnv(repos, env, { agent: claudeAgent(loadFactory()) })));
      return 0;
    }
    case 'check-project': {
      // Run by helix serve for a project someone added: what it finds is the check's log.
      const name = positionals[0];
      if (!name) throw new AnimusError('usage: helix check-project <name>');
      const config = loadConfig();
      const setup = config.container
        ? setupInContainer({ animusRoot: ROOT, image: imageName(animusVersion()), limits: config.container, uid: uid(), gid: gid(), name })
        : setupHere;
      return withStore((store) => (checkProject({ store, home: helixHome(), name, setup, say: (line) => console.log(line) }) ? 0 : 1));
    }
    case 'setup': {
      // Run by a project's check, in the job image when jobs run in one: the profile's installs and setup in a worktree.
      const dir = positionals[0];
      if (!dir) throw new AnimusError('usage: helix setup <worktree>');
      ensureSetup(dir, loadProfile(dir), (line) => console.log(line));
      return 0;
    }
    case 'remove-repo': {
      const name = positionals[0];
      if (!name) throw new AnimusError('usage: helix remove-repo <name>');
      const gone = withStore((store) => {
        const busy = [...store.inState('queued'), ...store.inState('running')].filter((j) => j.repo === name);
        if (busy.length) throw new AnimusError(`job(s) ${busy.map((j) => j.id).join(', ')} are queued or running for ${name}: wait for them, or cancel them, first`);
        const project = store.project(name);
        removeRepo(store, name);
        if (project) forgetProject(helixHome(), project);
        return project;
      });
      console.log(gone?.added_by ? `${name} is off Helix, and the clones Helix made of it are deleted.` : `${name} is off Helix, and people's clones of it are deleted. Its clone is still at ${gone?.dir}; delete it when you no longer want it.`);
      return 0;
    }
    case 'image':
      return buildImage() ? 0 : 1;
    case 'upgrade':
      if (!positionals[0] === !values.follow) throw new AnimusError('usage: helix upgrade <tag> | --follow');
      return upgrade(positionals[0], Boolean(values.follow));
    case 'add-person': {
      if (!positionals[0]) throw new AnimusError('usage: helix add-person <name> [--env-file <file>]');
      const token = withStore((store) => addPerson(store, positionals[0]!, values['env-file']));
      console.log(`${positionals[0]}'s token, shown this once:\n\n  ${token}\n\nThey set HELIX_URL and HELIX_TOKEN, then: animus submit <spec.md>`);
      return 0;
    }
    case undefined: case 'help': case '--help': case '-h':
      console.log(USAGE);
      return 0;
    default:
      throw new AnimusError(`unknown command ${command}\n\n${USAGE}`);
  }
}

/** Runs a command in this checkout; its output goes to the terminal. */
function run(command: string, args: string[]): boolean {
  return spawnSync(command, args, { cwd: ROOT, stdio: 'inherit', shell: process.platform === 'win32' }).status === 0;
}

/**
 * Moves this checkout to a release: the tag given, or with follow the
 * release origin's stable branch is at (upgrade.ts says when it stays).
 * Each try is kept in helix.db, so follow does not retry a release that
 * failed here.
 */
function upgrade(ref: string | undefined, follow: boolean): number {
  const git = (...args: string[]) => spawnSync('git', args, { cwd: ROOT, encoding: 'utf8' });
  const home = helixHome();
  // The pause an upgrade leaves stays until helix serve restarts: one upgrade at a time.
  if (existsSync(pauseFile(home)) && readFileSync(pauseFile(home), 'utf8').trim() === UNTIL_RESTART) {
    throw new AnimusError(`another helix upgrade is under way (${pauseFile(home)} says so). If none is, restart helix.service, which clears it`);
  }
  if (git('status', '--porcelain').stdout.trim()) throw new AnimusError(`${ROOT} has changes of its own; a release goes only onto a clean checkout`);
  if (!run('git', ['fetch', '--quiet', '--tags', '--force', 'origin'])) throw new AnimusError('git fetch failed: nothing was changed');
  if (follow) {
    // Named, so a clone of one branch follows stable too.
    git('fetch', '--quiet', 'origin', '+refs/heads/stable:refs/remotes/origin/stable');
    const stable = git('rev-parse', '--verify', '--quiet', 'origin/stable^{commit}');
    const to = withStore((store) => releaseToFollow({
      head: git('rev-parse', 'HEAD').stdout.trim(),
      stable: stable.status === 0 ? stable.stdout.trim() : undefined,
      tags: git('tag', '--points-at', 'origin/stable').stdout.split('\n').filter(Boolean),
      last: (tag) => store.upgrade(tag),
    }));
    if ('stay' in to) { console.log(`helix: staying: ${to.stay}`); return 0; }
    ref = to.tag;
  }
  if (!ref) throw new AnimusError('usage: helix upgrade <tag> | --follow');
  if (git('rev-parse', '--verify', '--quiet', `${ref}^{commit}`).status !== 0) throw new AnimusError(`there is no ${ref} to move to`);
  const before = git('rev-parse', 'HEAD').stdout.trim();
  console.log(`moving to ${ref}`);
  // No job starts on one release and resumes on the next: the machine drains first.
  writeFileSync(pauseFile(home), `${UNTIL_RESTART}\n`);
  let failed: string | undefined;
  try {
    console.log('no new job starts now; submissions still queue');
    withStore((store) => {
      let said = '';
      for (let running = store.inState('running'); running.length; running = store.inState('running')) {
        const now = `waiting for job(s) ${running.map((j) => j.id).join(', ')} to end`;
        if (now !== said) console.log(now);
        said = now;
        sleep(5000);
      }
    });
    const contained = Boolean(loadConfig().container);
    // The new release's image is built from its own Dockerfile, tagged with its own version.
    const steps: [string, () => boolean][] = [
      ['checkout', () => run('git', ['checkout', '--quiet', '--detach', ref])],
      ['npm ci', () => run('npm', ['ci'])],
      ['tests', () => run('npm', ['test'])],
      ['typecheck', () => run('npm', ['run', 'typecheck'])],
      ['job image', () => !contained || spawnSync(process.execPath, ['--disable-warning=ExperimentalWarning', join(ROOT, 'helix', 'src', 'cli.ts'), 'image'], { cwd: ROOT, stdio: 'inherit' }).status === 0],
    ];
    failed = steps.find(([, step]) => !step())?.[0];
  } catch (err) {
    rmSync(pauseFile(home), { force: true });
    throw err;
  }
  if (failed) {
    console.error(`helix: ${ref} failed at its ${failed} here; going back to ${before.slice(0, 12)}`);
    run('git', ['checkout', '--quiet', '--detach', before]);
    run('npm', ['ci']);
  }
  withStore((store) => store.putUpgrade({ tag: ref, at: new Date().toISOString(), ok: !failed, ...(failed ? { detail: `${failed} failed` } : {}) }));
  const pid = existsSync(pidFile()) ? Number(readFileSync(pidFile(), 'utf8')) : 0;
  try {
    if (!pid) throw new Error('no pid');
    process.kill(pid, 'SIGTERM');
    console.log(`helix serve (pid ${pid}) is stopping; its service manager starts it again on ${failed ? 'the release it had' : ref}, and the queue goes on`);
  } catch {
    rmSync(pauseFile(home), { force: true });
    console.log(`helix serve is not running: start it to run ${failed ? 'the release it had' : ref}`);
  }
  return failed ? 1 : 0;
}

try {
  const code = main(process.argv.slice(2));
  if (code !== undefined) process.exit(code);
} catch (err) {
  if (!(err instanceof AnimusError)) throw err;
  console.error(`helix: ${err.message}`);
  process.exit(2);
}
