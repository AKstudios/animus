import assert from 'node:assert/strict';
import { execFileSync } from 'node:child_process';
import { existsSync, mkdirSync, mkdtempSync, readFileSync, writeFileSync } from 'node:fs';
import type { AddressInfo } from 'node:net';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { test } from 'node:test';
import { githubUrl } from '../../plugin/src/git.ts';
import { addProject as addFrom } from '../../plugin/src/project.ts';
import * as client from '../../plugin/src/remote.ts';
import { makeRepo, write } from '../../plugin/test/helpers.ts';
import { hashToken, importRegistry, loadConfig, type Config } from '../src/config.ts';
import { personDirs } from '../src/container.ts';
import { checkFolder, checkInChild, checkLog, checkProject, failInterruptedChecks, projectDir, setupHere, type StartCheck } from '../src/projects.ts';
import { serve } from '../src/server.ts';
import { openStore } from '../src/store.ts';
import { supervise, type Launch } from '../src/supervisor.ts';

const SPEC = '---\nsize: small\n---\n# Done\n\n## Acceptance criteria\n\n1. It works.\n';
const git = (cwd: string, ...args: string[]) => execFileSync('git', args, { cwd, encoding: 'utf8' }).trim();

test('a GitHub address in any form a clone has is made the https one; anything else is not GitHub', () => {
  for (const url of ['https://github.com/acme/app', 'https://github.com/acme/app.git', 'git@github.com:acme/app.git', 'ssh://git@github.com/acme/app.git', 'https://github.com/acme/app/']) {
    assert.equal(githubUrl(url), 'https://github.com/acme/app.git', url);
  }
  assert.equal(githubUrl('https://github.com/acme/my.site.git'), 'https://github.com/acme/my.site.git');
  for (const url of ['https://gitlab.com/acme/app.git', '/srv/app.git', 'https://github.com/acme', 'https://github.com/acme/app/tree/main']) assert.equal(githubUrl(url), undefined, url);
});

test('people and repositories in a config.yaml from before are moved into the tables once, and the rest of the file stays', () => {
  const home = mkdtempSync(join(tmpdir(), 'helix-import-'));
  const repo = makeRepo();
  git(repo, 'remote', 'add', 'origin', 'https://github.com/acme/app.git');
  const file = join(home, 'config.yaml');
  writeFileSync(file, `port: 7421\nslots: 3\nurl: https://helix.example\nrepos:\n  app: ${repo}\npeople:\n  ana:\n    token_sha256: abc\n    github: ana-gh\n`);
  const store = openStore(join(home, 'helix.db'));
  store.putPerson('ben', { token_sha256: 'kept' });

  assert.deepEqual(importRegistry(store, file), { people: ['ana'], repos: ['app'] });
  assert.deepEqual(store.person('ana'), { token_sha256: 'abc', github: 'ana-gh' });
  assert.equal(store.personByToken('abc'), 'ana');
  assert.deepEqual(store.project('app'), { ...store.project('app')!, url: 'https://github.com/acme/app.git', dir: repo, state: 'ready' });
  assert.equal(store.project('app')!.added_by, undefined);
  assert.deepEqual(loadConfig(file), { host: '127.0.0.1', port: 7421, slots: 3, url: 'https://helix.example' });
  assert.ok(!readFileSync(file, 'utf8').includes('people') && !readFileSync(file, 'utf8').includes('repos'));
  assert.deepEqual(importRegistry(store, file), { people: [], repos: [] });
  assert.deepEqual(store.person('ben'), { token_sha256: 'kept' });
  store.close();
});

/** A Helix with ana and ben, no projects, and a check the test runs by hand. */
async function helix() {
  const home = mkdtempSync(join(tmpdir(), 'helix-projects-'));
  const config: Config = { host: '127.0.0.1', port: 0, slots: 1 };
  const store = openStore(join(home, 'helix.db'));
  store.putPerson('ana', { token_sha256: hashToken('ana-token') });
  store.putPerson('ben', { token_sha256: hashToken('ben-token') });
  const started: string[] = [];
  const startCheck: StartCheck = (name) => { started.push(name); };
  const launch: Launch = () => ({ command: process.execPath, args: ['-e', 'console.log(JSON.stringify({ outcome: "pr", pr: "https://example.test/pr/1" }))'] });
  const supervisor = supervise({ store, config, home, launch });
  const server = serve({ config, store, supervisor, home, startCheck });
  await new Promise<void>((r) => { server.listen(0, '127.0.0.1', r); });
  process.env.HELIX_URL = `http://127.0.0.1:${(server.address() as AddressInfo).port}`;
  const as = (who: string) => { process.env.HELIX_TOKEN = `${who}-token`; };
  as('ana');
  const settle = (name: string, state: 'ready' | 'failed', reason?: string) => store.putProject({ ...store.project(name)!, state, ...(reason ? { reason } : {}) });
  const stop = () => { supervisor.stop(); server.close(); store.close(); };
  return { home, store, started, as, settle, stop };
}

test('a project added over the API is checked before jobs may be submitted for it, and a failed one can be added again', async (t) => {
  const h = await helix();
  t.after(h.stop);
  const added = await client.addProject({ name: 'app', url: 'git@github.com:acme/app.git' });
  assert.deepEqual([added.state, added.url, added.added_by, h.started], ['checking', 'https://github.com/acme/app.git', 'ana', ['app']]);
  assert.equal((added as { dir?: string }).dir, undefined, 'where Helix keeps it is its own business');
  assert.equal(h.store.project('app')!.dir, projectDir(h.home, 'app'));

  await assert.rejects(client.addProject({ name: 'app', url: 'https://github.com/acme/app' }), /already checking app/);
  await assert.rejects(client.submit({ repo: 'app', spec: SPEC, name: 'spec.md' }), /still checking the project app/);
  await assert.rejects(client.addProject({ name: 'other', url: 'https://gitlab.com/acme/app.git' }), /not a GitHub repository's address/);
  await assert.rejects(client.addProject({ name: '../app', url: 'https://github.com/acme/app.git' }), /project's name may hold/);

  h.settle('app', 'failed', 'setup did not pass');
  assert.deepEqual((await client.projects()).projects.map((p) => [p.name, p.state, p.reason]), [['app', 'failed', 'setup did not pass']]);
  await assert.rejects(client.submit({ repo: 'app', spec: SPEC, name: 'spec.md' }), /no project named app/);
  h.as('ben');
  assert.equal((await client.addProject({ name: 'app', url: 'https://github.com/acme/app.git' })).added_by, 'ben');
  h.settle('app', 'ready');

  // GitHub decides who may submit: ana did not add it, and may still.
  h.as('ana');
  assert.equal((await client.submit({ repo: 'app', spec: SPEC, name: 'spec.md' })).repo, 'app');
  await assert.rejects(client.addProject({ name: 'app', url: 'https://github.com/acme/app.git' }), /app is already on Helix/);
  await assert.rejects(client.addProject({ name: 'app', url: 'https://github.com/acme/site.git' }), /already has a project named app, for https:\/\/github.com\/acme\/app.git/);
  await assert.rejects(client.addProject({ name: 'app2', url: 'https://github.com/acme/app' }), /already on Helix as app/);
});

test('a project is removed only by whoever added it, with no jobs of its own waiting, and the clones Helix made of it go', async (t) => {
  const h = await helix();
  t.after(h.stop);
  h.as('ben');
  await client.addProject({ name: 'app', url: 'https://github.com/acme/app.git' });
  await assert.rejects(client.removeProject('app'), /still checking app/);
  h.settle('app', 'ready');
  h.as('ana');
  mkdirSync(join(projectDir(h.home, 'app'), '.git'), { recursive: true });
  mkdirSync(join(personDirs(h.home, 'ana').repos, 'app', '.git'), { recursive: true });
  mkdirSync(join(personDirs(h.home, 'ana').repos, 'site', '.git'), { recursive: true });
  mkdirSync(checkFolder(h.home, 'app'), { recursive: true });
  writeFileSync(checkLog(h.home, 'app'), 'ready\n');

  await assert.rejects(client.removeProject('app'), /added by ben: only ben can remove it, or whoever runs Helix \(helix remove-repo app\)/);
  h.as('ben');
  const queued = h.store.add({ state: 'queued', person: 'ana', repo: 'app', spec: '', title: 't', draft: false, submitted: '' });
  await assert.rejects(client.removeProject('app'), new RegExp(`job\\(s\\) ${queued.id} are queued or running for app`));
  h.store.save({ ...queued, state: 'cancelled' });

  await client.removeProject('app');
  assert.equal(h.store.project('app'), undefined);
  assert.ok(!existsSync(projectDir(h.home, 'app')) && !existsSync(checkFolder(h.home, 'app')));
  assert.ok(!existsSync(join(personDirs(h.home, 'ana').repos, 'app')), 'a project added again under this name may be another repository');
  assert.ok(existsSync(join(personDirs(h.home, 'ana').repos, 'site')));
  await assert.rejects(client.removeProject('app'), /no project named app/);

  // One added on the machine can be removed only there.
  h.store.putProject({ name: 'site', url: '', dir: '/srv/site', state: 'ready', added: '' });
  await assert.rejects(client.removeProject('site'), /added on the machine: only whoever runs Helix can remove it/);
});

/** A Helix home with ana, whose GitHub token is in her env file, and a project of hers to check, cloned from a bare repository. */
function toCheck(profile?: string) {
  const home = mkdtempSync(join(tmpdir(), 'helix-check-project-'));
  const source = makeRepo();
  if (profile !== undefined) {
    write(source, '.animus/animus.yaml', profile);
    git(source, 'add', '-A');
    git(source, 'commit', '-qm', 'profile');
  }
  const bare = join(home, 'origin.git');
  git(home, 'clone', '-q', '--bare', source, bare);
  writeFileSync(join(home, 'ana.env'), 'GH_TOKEN=github_pat_ana\n');
  const store = openStore(join(home, 'helix.db'));
  store.putPerson('ana', { token_sha256: 'x', env_file: join(home, 'ana.env') });
  store.putProject({ name: 'app', url: bare, dir: projectDir(home, 'app'), state: 'checking', added: '2026-11-16T00:00:00.000Z', added_by: 'ana' });
  const said: string[] = [];
  return { home, store, said, say: (line: string) => said.push(line) };
}

test('the check clones the project, reads its profile, runs its setup once in a worktree on the base, and takes it', () => {
  const c = toCheck('commands:\n  test: grep -q done src/feature.txt\nsetup: echo "set up for $GH_TOKEN" > setup.txt\n');
  let ranIn = '';
  const ok = checkProject({
    store: c.store, home: c.home, name: 'app', say: c.say,
    setup: (worktree, clone, env) => { ranIn = worktree; assert.equal(clone, projectDir(c.home, 'app')); return setupHere(worktree, clone, env); },
  });
  assert.equal(ok, true, c.said.join('\n'));
  assert.equal(c.store.project('app')!.state, 'ready');
  assert.ok(existsSync(join(projectDir(c.home, 'app'), '.animus', 'animus.yaml')));
  assert.equal(ranIn, join(checkFolder(c.home, 'app'), 'setup'));
  assert.ok(!existsSync(ranIn), 'the worktree is removed after');
  assert.ok(c.said.some((l) => /base main, gates test/.test(l)) && c.said.some((l) => l === 'setup passed'));
  c.store.close();
});

test('a project with no profile, or whose setup fails, is failed with why; one added again meanwhile is left to its own check', () => {
  const none = toCheck();
  // A bare repository whose default branch has no profile.
  const empty = makeRepo();
  git(empty, 'rm', '-q', '.animus/animus.yaml');
  git(empty, 'commit', '-qm', 'no profile');
  git(none.home, 'clone', '-q', '--bare', empty, join(none.home, 'bare-empty.git'));
  none.store.putProject({ ...none.store.project('app')!, url: join(none.home, 'bare-empty.git') });
  assert.equal(checkProject({ store: none.store, home: none.home, name: 'app', say: none.say, setup: setupHere }), false);
  assert.match(none.store.project('app')!.reason!, /default branch has no \.animus\/animus\.yaml\. Run animus init/);
  none.store.close();

  const broken = toCheck('commands:\n  test: "true"\nsetup: echo the install broke; exit 3\n');
  assert.equal(checkProject({ store: broken.store, home: broken.home, name: 'app', say: broken.say, setup: setupHere }), false);
  assert.match(broken.store.project('app')!.reason!, /setup did not pass, so every job would fail at it:[\s\S]*the install broke/);
  broken.store.close();

  // Setup is what takes minutes, so it is where someone removes the project and adds it again.
  const raced = toCheck('commands:\n  test: "true"\nsetup: "true"\n');
  const store = raced.store;
  const check = checkProject({
    store, home: raced.home, name: 'app', say: raced.say,
    setup: () => { store.putProject({ ...store.project('app')!, added: '2026-11-17T00:00:00.000Z' }); return { code: 0, output: '' }; },
  });
  assert.equal(check, true);
  assert.equal(store.project('app')!.state, 'checking', 'the newer add is its own check\'s to settle');
  store.close();
});

test('a project whose adder has no GitHub token, or whose origin cannot be cloned, fails its check', () => {
  const c = toCheck('commands:\n  test: "true"\n');
  c.store.putPerson('ana', { token_sha256: 'x' });
  assert.equal(checkProject({ store: c.store, home: c.home, name: 'app', say: c.say, setup: setupHere }), false);
  assert.match(c.store.project('app')!.reason!, /no GitHub token on Helix/);

  c.store.putPerson('ana', { token_sha256: 'x', env_file: join(c.home, 'ana.env') });
  c.store.putProject({ ...c.store.project('app')!, state: 'checking', url: join(c.home, 'nothing.git') });
  assert.equal(checkProject({ store: c.store, home: c.home, name: 'app', say: c.say, setup: setupHere }), false);
  assert.match(c.store.project('app')!.reason!, /could not clone/);
  c.store.close();
});

test('Helix runs the check as a helix check-project process of its own, whose output is the check\'s log', async () => {
  const c = toCheck('commands:\n  test: "true"\nsetup: echo installing\n');
  const before = process.env.HELIX_HOME;
  process.env.HELIX_HOME = c.home;
  try {
    checkInChild(c.store, c.home)('app');
    // The check settles the state, then says so: wait for its last line too, or a loaded machine reads the log in between.
    const said = () => existsSync(checkLog(c.home, 'app')) && /is ready|failed:/.test(readFileSync(checkLog(c.home, 'app'), 'utf8'));
    for (let i = 0; i < 500 && (c.store.project('app')!.state === 'checking' || !said()); i++) await new Promise((r) => { setTimeout(r, 20); });
    assert.equal(c.store.project('app')!.state, 'ready', readFileSync(checkLog(c.home, 'app'), 'utf8'));
    assert.match(readFileSync(checkLog(c.home, 'app'), 'utf8'), /^cloning [\s\S]*setup passed\napp is ready/m);
  } finally {
    if (before === undefined) delete process.env.HELIX_HOME; else process.env.HELIX_HOME = before;
    c.store.close();
  }
});

test('a check that was running when Helix stopped fails its project, to be added again', () => {
  const home = mkdtempSync(join(tmpdir(), 'helix-'));
  const store = openStore(join(home, 'helix.db'));
  store.putProject({ name: 'app', url: '', dir: '', state: 'checking', added: '' });
  store.putProject({ name: 'site', url: '', dir: '', state: 'ready', added: '' });
  assert.deepEqual(failInterruptedChecks(store), ['app']);
  assert.deepEqual(store.projects().map((p) => p.state), ['failed', 'ready']);
  store.close();
});

test('animus project add sends the checkout\'s GitHub address, prints the check as it goes, and refuses a checkout with no committed profile', async (t) => {
  const h = await helix();
  t.after(h.stop);
  const repo = makeRepo();
  git(repo, 'remote', 'add', 'origin', 'git@github.com:acme/meal-planner.git');
  const said: string[] = [];
  let polls = 0;
  const added = await addFrom(repo, {
    say: (l) => said.push(l),
    sleep: async () => {
      polls++;
      mkdirSync(checkFolder(h.home, 'project'), { recursive: true });
      if (polls === 1) writeFileSync(checkLog(h.home, 'project'), 'cloning\n');
      if (polls === 2) { writeFileSync(checkLog(h.home, 'project'), 'cloning\nsetup passed\n'); h.settle('project', 'ready'); }
    },
  });
  assert.deepEqual([added.name, added.state, added.url], ['project', 'ready', 'https://github.com/acme/meal-planner.git']);
  assert.deepEqual(said.slice(1), ['  cloning', '  setup passed']);

  const bare = makeRepo();
  git(bare, 'remote', 'add', 'origin', 'https://github.com/acme/other.git');
  git(bare, 'rm', '-q', '--cached', '.animus/animus.yaml');
  await assert.rejects(addFrom(bare, { say: () => {} }), /is not committed/);
  const away = makeRepo();
  git(away, 'remote', 'add', 'origin', 'https://gitlab.com/acme/other.git');
  await assert.rejects(addFrom(away, { say: () => {} }), /not on GitHub/);
});
