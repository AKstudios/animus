// Helix admits a spec against the project's base branch as GitHub has it
// (docs/adr/0007, 0008): at submit, and again when its queued job starts. A
// local bare repository stands in for GitHub; nothing starts a model.
import assert from 'node:assert/strict';
import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from 'node:fs';
import type { AddressInfo } from 'node:net';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { spawnSync } from 'node:child_process';
import { test } from 'node:test';
import * as client from '../../plugin/src/remote.ts';
import { startAdmit, submissionAdmit } from '../src/admit.ts';
import { hashToken, type Config } from '../src/config.ts';
import { freshBase } from '../src/fresh.ts';
import { checkProject, projectDir } from '../src/projects.ts';
import { serve } from '../src/server.ts';
import { openStore, type HelixJob } from '../src/store.ts';
import { pauseFile, supervise, type Launch } from '../src/supervisor.ts';
import { until } from './fake-slack.ts';

const git = (cwd: string, ...args: string[]) => {
  const r = spawnSync('git', args, { cwd, encoding: 'utf8', env: { ...process.env, GIT_AUTHOR_NAME: 'T', GIT_AUTHOR_EMAIL: 't@x', GIT_COMMITTER_NAME: 'T', GIT_COMMITTER_EMAIL: 't@x', GIT_CONFIG_GLOBAL: '/dev/null' } });
  assert.equal(r.status, 0, r.stderr);
  return r.stdout.trim();
};
const PROFILE = '.animus/animus.yaml';
const NO_TARGET = 'commands:\n  test: echo ok\n';
const WITH_TARGET = `${NO_TARGET}ui:\n  targets:\n    web:\n      url: http://127.0.0.1:$PORT\n      pages: { home: / }\n`;

/** A bare origin holding a profile on main, Helix's clone of it, and a way to push a new profile afterwards. */
function github(first = NO_TARGET) {
  const dir = mkdtempSync(join(tmpdir(), 'helix-admit-'));
  const origin = join(dir, 'origin.git');
  const seed = join(dir, 'seed');
  git(dir, 'init', '--quiet', '--bare', '-b', 'main', origin);
  git(dir, 'clone', '--quiet', origin, seed);
  git(seed, 'checkout', '--quiet', '-b', 'main');
  const push = (text: string) => {
    mkdirSync(join(seed, '.animus'), { recursive: true });
    writeFileSync(join(seed, PROFILE), text);
    git(seed, 'add', '-A');
    git(seed, 'commit', '--quiet', '-m', 'profile');
    git(seed, 'push', '--quiet', 'origin', 'main:main');
  };
  push(first);
  const clone = join(dir, 'clone');
  git(dir, 'clone', '--quiet', origin, clone);
  return { dir, origin, clone, push };
}

const uiSpec = (header = '', page = 'home') => `---\nsize: small\ntype: ui\nui: { pages: [${page}] }\n${header}---\n# Show it\n\n## Acceptance criteria\n\n1. It shows.\n   $ node check.js\n`;

/** Helix with one person and the project `app` cloned in gh, listening; jobs launched by `launch`. */
async function helix(gh: ReturnType<typeof github>, launch: Launch) {
  const config: Config = { host: '127.0.0.1', port: 0, slots: 1 };
  const store = openStore(join(gh.dir, 'helix.db'));
  store.putPerson('ana', { token_sha256: hashToken('t') });
  store.putProject({ name: 'app', url: 'https://github.com/o/app.git', dir: gh.clone, state: 'ready', added: '' });
  const supervisor = supervise({ store, config, home: gh.dir, launch, fresh: freshBase, admit: startAdmit(gh.dir) });
  const server = serve({ config, store, supervisor, home: gh.dir, admit: submissionAdmit(store, config, gh.dir) });
  await new Promise<void>((r) => { server.listen(0, '127.0.0.1', r); });
  process.env.HELIX_URL = `http://127.0.0.1:${(server.address() as AddressInfo).port}`;
  process.env.HELIX_TOKEN = 't';
  const ended = (id: number) => until('the job ends', () => store.get(id)?.state === 'ended').then(() => store.get(id)!);
  const submit = (spec: string, extra: { profile?: string } = {}) => client.submit({ repo: 'app', spec, name: 'spec.md', ...extra });
  return { store, supervisor, server, ended, submit, stop: () => { supervisor.stop(); server.close(); store.close(); } };
}

const never: Launch = () => ({ command: process.execPath, args: ['-e', ''] });

// Protects: criterion 5. Fails when: Helix admits against the clone as it was made or checked out, or queues a spec the profile on GitHub refuses, or gives only the first problem.
test('POST /jobs refuses with every problem, against the base branch on GitHub, though the clone is stale and off its base', async () => {
  const gh = github();
  git(gh.clone, 'checkout', '--quiet', '-b', 'mine');
  const h = await helix(gh, never);
  try {
    await assert.rejects(
      h.submit(uiSpec('sise: small\n', 'nowhere')),
      (err: Error) => /^Helix refused: spec\.md is refused/.test(err.message)
        && /\[spec\] .*sise/.test(err.message) && /\[profile\] a ui spec needs a ui target/.test(err.message) && /read from origin\/main on GitHub/.test(err.message),
    );
    assert.deepEqual(h.store.list(), []);

    gh.push(WITH_TARGET);
    await assert.rejects(h.submit(uiSpec('', 'nowhere')), /\[profile\] nowhere is not a page of ui target web/);
    const queued = await h.submit(uiSpec());
    assert.equal(h.store.get(queued.id)?.title, 'Show it');
  } finally { h.stop(); }
});

// Protects: waiting jobs. Fails when: Helix refuses a spec with after: at admit, so no job can wait there.
test('a spec with after: is admitted on Helix and queued as waiting', async () => {
  const gh = github(WITH_TARGET);
  const h = await helix(gh, never);
  try {
    const queued = await h.submit(uiSpec('after: earlier.md\n'));
    assert.equal(h.store.get(queued.id)?.state, 'waiting');
  } finally { h.stop(); }
});

// Protects: criterion 5, the drift warning. Fails when: a checkout whose profile is not GitHub's goes unmentioned, or one that matches is warned.
test('start --helix warns when the checkout\'s profile differs from the base branch\'s, and only then', async () => {
  const gh = github(WITH_TARGET);
  const h = await helix(gh, never);
  try {
    const same = await h.submit(uiSpec(), { profile: WITH_TARGET });
    const differs = await h.submit(uiSpec(), { profile: `${WITH_TARGET}base: main\nnotes: unpushed\n` });
    assert.equal(same.warnings, undefined);
    assert.match(differs.warnings![0]!, /differs from origin\/main on GitHub/);
  } finally { h.stop(); }
});

// Protects: criterion 8. Fails when: a queued job starts on a profile that no longer admits it, or ends as failed or without the list.
test('a queued job is admitted again at start and ends as refused, with the list, before any work', async () => {
  const gh = github(WITH_TARGET);
  const marker = join(gh.dir, 'started');
  const h = await helix(gh, () => ({ command: process.execPath, args: ['-e', `require('fs').writeFileSync(${JSON.stringify(marker)}, '')`] }));
  try {
    writeFileSync(pauseFile(gh.dir), '');
    const queued = await h.submit(uiSpec());
    gh.push(NO_TARGET);
    rmSync(pauseFile(gh.dir));
    h.supervisor.wake();

    const ended: HelixJob = await h.ended(queued.id);

    assert.equal(ended.outcome, 'refused');
    assert.match(ended.reason!, /\[profile\] a ui spec needs a ui target/);
    assert.equal(h.store.get(queued.id)?.started, undefined);
    assert.equal(spawnSync('test', ['-e', marker]).status, 1);
  } finally { h.stop(); }
});

// Protects: the answer for a project Helix is still checking. Fails when: admit, which runs ahead of the supervisor, tells the person the project does not exist.
test('a submit for a project still being checked is answered as still checking, not as unknown', async () => {
  const gh = github();
  const h = await helix(gh, never);
  try {
    h.store.putProject({ name: 'app', url: 'https://github.com/o/app.git', dir: gh.clone, state: 'checking', added: '' });
    await assert.rejects(h.submit(uiSpec()), /still checking the project app/);
    await assert.rejects(client.submit({ repo: 'nope', spec: uiSpec(), name: 'spec.md' }), /no project named nope/);
  } finally { h.stop(); }
});

const WITH_SECRET = `${NO_TARGET}secrets: [API_KEY]\n`;
const SPEC = '---\nsize: small\n---\n# Use the key\n\n## Acceptance criteria\n\n1. It works.\n   $ node check.js\n';
const SET_IT = /secret API_KEY\b.*animus project secret set app API_KEY/;

// Protects: criterion 4 at submit. Fails when: a spec is queued for a project whose base branch lists a secret with no value, or the refusal does not say how to set it, or the person's own value does not count.
test('a submit is refused while a secret the base branch lists has no value, naming it and the command, and taken once the person sets their own', async () => {
  const gh = github(WITH_SECRET);
  const h = await helix(gh, never);
  try {
    await assert.rejects(h.submit(SPEC), SET_IT);
    assert.deepEqual(h.store.list(), []);

    await client.setSecret('app', 'API_KEY', 'ana-own-key-0123', true);
    const queued = await h.submit(SPEC);
    assert.equal(h.store.get(queued.id)?.title, 'Use the key');
  } finally { h.stop(); }
});

// Protects: criterion 4 when a queued job starts. Fails when: a job starts though its base branch now lists a secret nobody set.
test('a queued job whose base branch has since listed an unset secret ends as refused at start, naming it', async () => {
  const gh = github();
  const h = await helix(gh, never);
  try {
    writeFileSync(pauseFile(gh.dir), '');
    const queued = await h.submit(SPEC);
    gh.push(WITH_SECRET);
    rmSync(pauseFile(gh.dir));
    h.supervisor.wake();

    const ended = await h.ended(queued.id);

    assert.equal(ended.outcome, 'refused');
    assert.match(ended.reason!, SET_IT);
  } finally { h.stop(); }
});

// Protects: criterion 4 in the add check. Fails when: the check runs setup though a listed secret has no value, or fails without naming it and the command.
test('the add check fails before setup while a secret its profile lists has no value, naming it and the command', () => {
  const gh = github(`${WITH_SECRET}setup: echo should not run\n`);
  writeFileSync(join(gh.dir, 'ana.env'), 'GH_TOKEN=github_pat_ana\n');
  const store = openStore(join(gh.dir, 'helix.db'));
  store.putPerson('ana', { token_sha256: 'x', env_file: join(gh.dir, 'ana.env') });
  store.putProject({ name: 'app', url: gh.origin, dir: projectDir(gh.dir, 'app'), state: 'checking', added: '2026-11-19T00:00:00.000Z', added_by: 'ana' });
  let setupRan = false;
  try {
    const ok = checkProject({ store, home: gh.dir, name: 'app', say: () => {}, setup: () => { setupRan = true; return { code: 0, output: '', gates: [] }; } });

    assert.equal(ok, false);
    assert.equal(setupRan, false);
    assert.equal(store.project('app')?.state, 'failed');
    assert.match(store.project('app')!.reason!, SET_IT);
  } finally { store.close(); }
});
