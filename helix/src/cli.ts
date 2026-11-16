// The helix command, run on the machine that runs the jobs.
import { spawnSync } from 'node:child_process';
import { existsSync, readFileSync, rmSync, unwatchFile, watchFile, writeFileSync } from 'node:fs';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { parseArgs } from 'node:util';
import { claudeAgent } from '../../plugin/src/agent.ts';
import { loadFactory } from '../../plugin/src/profiles.ts';
import { AnimusError } from '../../plugin/src/proc.ts';
import { checkPerson, describeFindings, githubToken } from './check.ts';
import { animusVersion } from '../../plugin/src/version.ts';
import { containerLaunch, containerProblem, imageName, personDirs, removeContainer } from './container.ts';
import { addPerson, addRepo, configFile, helixHome, identityEnv, loadConfig, removePerson, removeRepo } from './config.ts';
import { serve } from './server.ts';
import { openStore } from './store.ts';
import { cancelJobsOf, pauseFile, supervise, UNTIL_RESTART } from './supervisor.ts';

/** This checkout of Animus: what `helix upgrade` moves to another release. */
const ROOT = join(dirname(fileURLToPath(import.meta.url)), '..', '..');
const pidFile = () => join(helixHome(), 'serve.pid');
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
        A clone on this machine that jobs may be submitted for.
  helix add-person <name> [--env-file <file>]
        Let a person submit, and print their token once. The file holds
        KEY=VALUE lines set for their jobs only (CLAUDE_CODE_OAUTH_TOKEN, GH_TOKEN).
        Run again to give them a new token.
  helix remove-person <name>
        Take a person off: their token stops working, their queued and
        running jobs are cancelled, and their credentials file under
        ${helixHome()} is deleted. Prints what is left to do elsewhere.
  helix remove-repo <name>
        Stop taking jobs for a repository. Its clone stays on disk.
  helix upgrade <tag>
        Move this machine to a release: stop starting jobs, wait for the
        running ones to end, check out the tag, install, run the tests, and
        restart Helix (its service manager starts it again). If the tests
        fail, the checkout goes back to where it was.
  helix image
        Build the image jobs run in (animus-job:<version>). Jobs run in
        containers when config.yaml has a container: entry.
  helix check [<name>]
        Try each person's credentials against GitHub and Claude: who the
        GitHub token is, when it ends, whether it may push to each repository,
        and whether the Claude token answers. Exits 1 if any does not.

Its files are under ${helixHome()} (HELIX_HOME). People, repositories and
slots are read again whenever config.yaml changes; host and port need a restart.`;

function main(argv: string[]): number | undefined {
  const [command, ...rest] = argv;
  const { values, positionals } = parseArgs({ args: rest, allowPositionals: true, options: { 'env-file': { type: 'string' } } });
  switch (command) {
    case 'serve': {
      const config = loadConfig();
      if (!Object.keys(config.people).length || !Object.keys(config.repos).length) throw new AnimusError(`${configFile()} names no ${Object.keys(config.repos).length ? 'people' : 'repositories'} yet: helix add-repo and helix add-person come first`);
      const home = helixHome();
      const store = openStore(join(home, 'helix.db'));
      // A GitHub token that ended fails the job before it starts, with the reason.
      const preflight = (_person: string, env: Record<string, string>) => {
        if (!env.GH_TOKEN && !env.GITHUB_TOKEN) return {};
        const f = githubToken(env);
        if (!f.ok) return { why: `the GitHub token in the env file does not work: ${f.detail}` };
        // The job's commits, and its screenshots' commit, are the person's as GitHub knows them.
        return f.identity ? { env: identityEnv(f.identity) } : {};
      };
      for (const name of Object.keys(config.people)) {
        const bad = checkPerson(config, name).filter((f) => !f.ok);
        if (bad.length) console.error(describeFindings(name, bad));
      }
      const say = (line: string) => console.error(`${new Date().toISOString().slice(0, 19)} ${line}`);
      // A pause left by helix upgrade ends with the restart it asked for.
      if (existsSync(pauseFile(home)) && readFileSync(pauseFile(home), 'utf8').trim() === UNTIL_RESTART) rmSync(pauseFile(home));
      if (existsSync(pauseFile(home))) say(`${pauseFile(home)} is there, so no job starts until it is removed`);
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
      const server = serve({ config, store, supervisor });
      server.listen(config.port, config.host, () => console.error(`helix ${animusVersion()}: listening on http://${config.host}:${config.port}, ${config.slots} job(s) at once${config.container ? ', each in a container' : ''}, repositories: ${Object.keys(config.repos).join(', ')}`));
      // Someone added or removed a person or a repository, or changed the slots: the same config object, so everything sees it at once.
      watchFile(configFile(), { interval: 2000 }, () => {
        try {
          const fresh = loadConfig();
          if (fresh.host !== config.host || fresh.port !== config.port) say('host and port take effect at the next restart');
          Object.assign(config, { ...fresh, host: config.host, port: config.port });
          say(`config read again: ${config.slots} slot(s), people: ${Object.keys(config.people).join(', ') || 'none'}, repositories: ${Object.keys(config.repos).join(', ') || 'none'}`);
          supervisor.wake();
        } catch (err) { say(`config.yaml did not load, so the last one stands: ${(err as Error).message}`); }
      });
      const stop = () => { unwatchFile(configFile()); supervisor.stop(); server.close(); store.close(); rmSync(pidFile(), { force: true }); process.exit(0); };
      process.on('SIGINT', stop);
      process.on('SIGTERM', stop);
      return undefined;
    }
    case 'check': {
      const config = loadConfig();
      const names = positionals[0] ? [positionals[0]] : Object.keys(config.people);
      if (positionals[0] && !config.people[positionals[0]]) throw new AnimusError(`${configFile()} has no person named ${positionals[0]}`);
      const agent = claudeAgent(loadFactory());
      let ok = true;
      for (const name of names) {
        const findings = checkPerson(config, name, { agent });
        console.log(describeFindings(name, findings));
        ok &&= findings.every((f) => f.ok);
      }
      return ok ? 0 : 1;
    }
    case 'add-repo':
      if (!positionals[0] || !positionals[1]) throw new AnimusError('usage: helix add-repo <name> <dir>');
      addRepo(positionals[0], positionals[1]);
      console.log(`${positionals[0]} added to ${configFile()}`);
      return 0;
    case 'remove-person': {
      const name = positionals[0];
      if (!name) throw new AnimusError('usage: helix remove-person <name>');
      const contained = Boolean(loadConfig().container);
      const { kept } = removePerson(name);
      const store = openStore(join(helixHome(), 'helix.db'));
      const cancelled = cancelJobsOf(store, name, contained ? removeContainer : undefined);
      store.close();
      // Their clones, job state and Claude config: theirs alone, and no use to anyone once they are gone.
      rmSync(personDirs(helixHome(), name).root, { recursive: true, force: true });
      console.log([
        `${name} is off Helix: their token no longer works${cancelled.length ? `, and job(s) ${cancelled.map((j) => j.id).join(', ')} were cancelled` : ''}.`,
        kept ? `Their credentials file is outside ${helixHome()}, so it was left: delete ${kept}` : 'Their credentials file is deleted.',
        `Their folder ${personDirs(helixHome(), name).root} (clones, job state, Claude config) is deleted.`,
        '',
        'Left to do elsewhere:',
        '  - GitHub: revoke the token they gave Helix (they can, or an org owner under the org\'s personal access tokens), and take them off the organisation or repositories.',
        '  - Claude: take them off your Claude organisation, or have them revoke the token they gave Helix.',
        '  - Tailscale: remove them from the tailnet, which takes their devices off it.',
        '  - Their open animus/* pull requests: close or take over; animus cleanup removes the branches of closed ones.',
      ].join('\n'));
      return 0;
    }
    case 'remove-repo': {
      const name = positionals[0];
      if (!name) throw new AnimusError('usage: helix remove-repo <name>');
      const store = openStore(join(helixHome(), 'helix.db'));
      const busy = [...store.inState('queued'), ...store.inState('running')].filter((j) => j.repo === name);
      store.close();
      if (busy.length) throw new AnimusError(`job(s) ${busy.map((j) => j.id).join(', ')} are queued or running for ${name}: wait for them, or cancel them, first`);
      const dir = removeRepo(name);
      console.log(`${name} is off Helix. Its clone is still at ${dir}; delete it when you no longer want it.`);
      return 0;
    }
    case 'image':
      return buildImage() ? 0 : 1;
    case 'upgrade':
      if (!positionals[0]) throw new AnimusError('usage: helix upgrade <tag>');
      return upgrade(positionals[0]);
    case 'add-person': {
      if (!positionals[0]) throw new AnimusError('usage: helix add-person <name> [--env-file <file>]');
      const token = addPerson(positionals[0], values['env-file']);
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

function upgrade(ref: string): number {
  const git = (...args: string[]) => spawnSync('git', args, { cwd: ROOT, encoding: 'utf8' });
  if (git('status', '--porcelain').stdout.trim()) throw new AnimusError(`${ROOT} has changes of its own; a release goes only onto a clean checkout`);
  if (!run('git', ['fetch', '--tags', '--force', 'origin'])) throw new AnimusError('git fetch failed: nothing was changed');
  if (git('rev-parse', '--verify', '--quiet', `${ref}^{commit}`).status !== 0) throw new AnimusError(`there is no ${ref} to move to`);
  const before = git('rev-parse', 'HEAD').stdout.trim();
  const home = helixHome();
  const store = openStore(join(home, 'helix.db'));
  // No job starts on one release and resumes on the next: the machine drains first.
  writeFileSync(pauseFile(home), `${UNTIL_RESTART}\n`);
  console.log('no new job starts now; submissions still queue');
  let said = '';
  for (let running = store.inState('running'); running.length; running = store.inState('running')) {
    const now = `waiting for job(s) ${running.map((j) => j.id).join(', ')} to end`;
    if (now !== said) console.log(now);
    said = now;
    sleep(5000);
  }
  store.close();
  const contained = Boolean(loadConfig().container);
  // The new release's image is built from its own Dockerfile, tagged with its own version.
  const moved = run('git', ['checkout', '--quiet', '--detach', ref]) && run('npm', ['ci']) && run('npm', ['test']) && run('npm', ['run', 'typecheck'])
    && (!contained || spawnSync(process.execPath, ['--disable-warning=ExperimentalWarning', join(ROOT, 'helix', 'src', 'cli.ts'), 'image'], { cwd: ROOT, stdio: 'inherit' }).status === 0);
  if (!moved) {
    console.error(`helix: ${ref} did not install or pass its tests here; going back to ${before.slice(0, 12)}`);
    run('git', ['checkout', '--quiet', '--detach', before]);
    run('npm', ['ci']);
  }
  const pid = existsSync(pidFile()) ? Number(readFileSync(pidFile(), 'utf8')) : 0;
  try {
    if (!pid) throw new Error('no pid');
    process.kill(pid, 'SIGTERM');
    console.log(`helix serve (pid ${pid}) is stopping; its service manager starts it again on ${moved ? ref : 'the release it had'}, and the queue goes on`);
  } catch {
    rmSync(pauseFile(home), { force: true });
    console.log(`helix serve is not running: start it to run ${moved ? ref : 'the release it had'}`);
  }
  return moved ? 0 : 1;
}

try {
  const code = main(process.argv.slice(2));
  if (code !== undefined) process.exit(code);
} catch (err) {
  if (!(err instanceof AnimusError)) throw err;
  console.error(`helix: ${err.message}`);
  process.exit(2);
}
