// Helix against a local bare repository standing in for GitHub: the profile is
// changed and pushed after Helix's clone exists, and the job or draft must read
// the new one. The sessions are scripts that print what they can see; nothing
// reaches GitHub or starts a model.
import assert from 'node:assert/strict';
import { existsSync, mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { spawnSync } from 'node:child_process';
import { test } from 'node:test';
import { hashToken, type Config } from '../src/config.ts';
import { jobCommand } from '../src/container.ts';
import { draftRunner, type DraftLaunch } from '../src/drafts.ts';
import { freshBase } from '../src/fresh.ts';
import { openStore, type HelixJob } from '../src/store.ts';
import { supervise, type Launch } from '../src/supervisor.ts';
import { fakeTransport, until } from './fake-slack.ts';

const git = (cwd: string, ...args: string[]) => {
  const r = spawnSync('git', args, { cwd, encoding: 'utf8', env: { ...process.env, GIT_AUTHOR_NAME: 'T', GIT_AUTHOR_EMAIL: 't@x', GIT_COMMITTER_NAME: 'T', GIT_COMMITTER_EMAIL: 't@x', GIT_CONFIG_GLOBAL: '/dev/null' } });
  assert.equal(r.status, 0, r.stderr);
  return r.stdout.trim();
};
const PROFILE = '.animus/animus.yaml';
const profile = (test: string, base = 'main') => `commands:\n  test: ${test}\nbase: ${base}\n`;

/** A bare origin holding a profile on main, Helix's clone of it, and a way to push a new profile afterwards. */
function github() {
  const dir = mkdtempSync(join(tmpdir(), 'helix-fresh-'));
  const origin = join(dir, 'origin.git');
  const seed = join(dir, 'seed');
  git(dir, 'init', '--quiet', '--bare', '-b', 'main', origin);
  git(dir, 'clone', '--quiet', origin, seed);
  git(seed, 'checkout', '--quiet', '-b', 'main');
  const push = (text: string, branch = 'main') => {
    if (spawnSync('git', ['rev-parse', '--verify', '--quiet', branch], { cwd: seed }).status === 0) git(seed, 'checkout', '--quiet', branch);
    else git(seed, 'checkout', '--quiet', '-b', branch);
    mkdirSync(join(seed, '.animus'), { recursive: true });
    writeFileSync(join(seed, PROFILE), text);
    git(seed, 'add', '-A');
    git(seed, 'commit', '--quiet', '-m', `profile on ${branch}`);
    git(seed, 'push', '--quiet', 'origin', `${branch}:${branch}`);
  };
  push(profile('echo old'));
  const clone = join(dir, 'clone');
  git(dir, 'clone', '--quiet', origin, clone);
  return { dir, origin, clone, push };
}

const SPEC = '---\nsize: small\n---\n# Fresh\n\n## Acceptance criteria\n\n1. It works.\n';

/** Helix with one person and the project `app` cloned in gh; launch is what stands in for `animus run`. */
function helix(gh: ReturnType<typeof github>, launch: Launch) {
  const config: Config = { host: '127.0.0.1', port: 0, slots: 1 };
  const store = openStore(join(gh.dir, 'helix.db'));
  store.putPerson('ana', { token_sha256: hashToken('t') });
  store.putProject({ name: 'app', url: 'https://github.com/o/app.git', dir: gh.clone, state: 'ready', added: '' });
  const supervisor = supervise({ store, config, home: gh.dir, launch, fresh: freshBase });
  const ended = (job: HelixJob) => until('the job ends', () => store.get(job.id)?.state === 'ended').then(() => store.get(job.id)!);
  return { store, config, supervisor, ended };
}

// Protects: criterion 1. Fails when: a job reads the clone as it was made, or follows the profile's base only in the stale copy.
test('a job reads the profile as the base branch has it on GitHub, though the clone was made before it changed', async () => {
  const gh = github();
  const reads = (job: HelixJob, repoDir: string) => ({ command: process.execPath, args: ['-e', `console.log(JSON.stringify({ outcome: 'pr', reason: require('fs').readFileSync(${JSON.stringify(join(repoDir, PROFILE))}, 'utf8') }))`] }) as ReturnType<Launch>;
  const h = helix(gh, reads);
  gh.push(profile('echo new'));

  const job = h.supervisor.submit('ana', { repo: 'app', spec: SPEC });
  const ended = await h.ended(job);

  assert.equal(ended.reason, profile('echo new'));
});

// Protects: "the profile's base as GitHub has it". Fails when: the base is taken from the stale clone's profile, so a base the profile has since changed is never fetched.
test('the base is the one the profile names on GitHub now, not the one the clone\'s copy names', () => {
  const gh = github();
  gh.push(profile('echo develop', 'develop'), 'develop');
  gh.push(profile('echo main', 'develop'), 'main');

  const commit = freshBase(gh.clone);

  assert.equal(commit, git(gh.origin, 'rev-parse', 'develop'));
});

// Protects: criterion 3 for jobs. Fails when: a refused or unreachable fetch lets the job start on the stale clone, or its reason is lost.
test('a job whose fetch fails ends before it starts, with the reason', async () => {
  const gh = github();
  const marker = join(gh.dir, 'started');
  const h = helix(gh, () => ({ command: process.execPath, args: ['-e', `require('fs').writeFileSync(${JSON.stringify(marker)}, '')`] }));
  rmSync(gh.origin, { recursive: true });

  const job = h.supervisor.submit('ana', { repo: 'app', spec: SPEC });
  const ended = await h.ended(job);

  assert.equal(ended.outcome, 'failed');
  assert.match(ended.reason!, /could not fetch main from GitHub/);
  assert.equal(existsSync(marker), false);
});

test('a clone\'s own branches and uncommitted work are left alone', () => {
  const gh = github();
  git(gh.clone, 'checkout', '--quiet', '-b', 'mine');
  writeFileSync(join(gh.clone, 'notes.txt'), 'mine\n');
  git(gh.clone, 'add', 'notes.txt');
  git(gh.clone, 'commit', '--quiet', '-m', 'mine');
  gh.push(profile('echo new'));

  freshBase(gh.clone);

  assert.equal(git(gh.clone, 'rev-parse', '--abbrev-ref', 'HEAD'), 'mine');
  assert.equal(git(gh.clone, 'log', '-1', '--format=%s', 'mine'), 'mine');
  assert.equal(git(gh.clone, 'show', `origin/main:${PROFILE}`), profile('echo new').trim());
});

// Protects: criterion 1 with containers. Fails when: the command a container runs starts animus without fetching the base into the person's existing clone.
test('a container\'s command fetches the base into the person\'s clone before it starts animus', () => {
  const gh = github();
  const clone = join(gh.dir, 'person-clone');
  git(gh.dir, 'clone', '--quiet', gh.origin, clone);
  gh.push(profile('echo new'));
  const seen = join(gh.dir, 'seen');
  const animus = join(gh.dir, 'animus.ts');
  writeFileSync(animus, `require('fs').writeFileSync(${JSON.stringify(seen)}, require('fs').readFileSync(${JSON.stringify(join(clone, PROFILE))}, 'utf8'));`);

  const [command, ...args] = jobCommand({ node: process.execPath, cli: animus, fresh: join(import.meta.dirname, '..', 'src', 'cli.ts'), clone, origin: gh.origin, animus: [] });
  const r = spawnSync(command!, args, { encoding: 'utf8' });

  assert.equal(r.status, 0, r.stderr);
  assert.equal(readFileSync(seen, 'utf8'), profile('echo new'));
});

test('a container\'s command stops with the reason when the fetch fails', () => {
  const gh = github();
  const clone = join(gh.dir, 'person-clone');
  git(gh.dir, 'clone', '--quiet', gh.origin, clone);
  rmSync(gh.origin, { recursive: true });
  const marker = join(gh.dir, 'started');
  const animus = join(gh.dir, 'animus.ts');
  writeFileSync(animus, `require('fs').writeFileSync(${JSON.stringify(marker)}, '');`);

  const [command, ...args] = jobCommand({ node: process.execPath, cli: animus, fresh: join(import.meta.dirname, '..', 'src', 'cli.ts'), clone, origin: gh.origin, animus: [] });
  const r = spawnSync(command!, args, { encoding: 'utf8' });

  assert.notEqual(r.status, 0);
  assert.match(r.stderr, /could not fetch main from GitHub/);
  assert.equal(existsSync(marker), false);
});

/** A Helix with the drafts of ana for the project `app`; the draft session prints the profile it can see as the draft. */
function drafting(gh: ReturnType<typeof github>) {
  process.env.HELIX_HOME = gh.dir;
  const config: Config = { host: '127.0.0.1', port: 0, slots: 1, slack: { enabled: true } };
  const store = openStore(join(gh.dir, 'helix.db'));
  store.putPerson('ana', { token_sha256: hashToken('t') });
  store.putProject({ name: 'app', url: 'https://github.com/o/app.git', dir: gh.clone, state: 'ready', added: '' });
  store.setChannelProject('C0TEAM', 'app');
  const slack = fakeTransport();
  const sessions: string[] = [];
  const launch: DraftLaunch = (draft, repoDir) => {
    sessions.push(repoDir);
    const script = `const fs = require('fs'); fs.writeFileSync(${JSON.stringify(join(draft.folder, 'draft.md'))}, fs.readFileSync(${JSON.stringify(join(repoDir, PROFILE))}, 'utf8'));`;
    return { command: process.execPath, args: ['-e', script] };
  };
  const drafts = draftRunner(slack.transport, { store, config, home: gh.dir, launch, fresh: freshBase });
  return { drafts, slack, sessions };
}

// Protects: criterion 2. Fails when: a draft session reads the project's clone as it was before the profile changed.
test('a draft reads the repository as the base branch has it on GitHub when it is written', async () => {
  const gh = github();
  const h = drafting(gh);
  gh.push(profile('echo new'));

  await h.drafts.start('ana', 'U0ANA', 'C0TEAM', 'draft something');
  await until('the draft is posted', () => h.slack.sent.some((s) => s.method === 'upload'));

  assert.deepEqual(h.slack.sent.find((s) => s.method === 'upload'), { method: 'upload', channel: 'C0TEAM', thread: 'ts-1', filename: 'draft.md', content: profile('echo new') });
});

// Protects: criterion 3 for drafts. Fails when: a draft session starts on a stale clone after a failed fetch, or the thread is not told why.
test('a draft whose fetch fails ends before its session, with the reason in its thread', async () => {
  const gh = github();
  const h = drafting(gh);
  rmSync(gh.origin, { recursive: true });

  await h.drafts.start('ana', 'U0ANA', 'C0TEAM', 'draft something');
  await until('the failure is posted', () => h.slack.sent.some((s) => s.method === 'post' && /could not be written/.test(s.text)));

  const said = h.slack.sent.find((s) => s.method === 'post' && /could not be written/.test(s.text));
  assert.match((said as { text: string }).text, /could not fetch main from GitHub/);
  assert.deepEqual(h.sessions, []);
});
