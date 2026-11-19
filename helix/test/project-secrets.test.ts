// A project's secrets on Helix: kept under its home, set and removed over the
// API by whoever added the project (or the owner), or by anyone for their own
// value, given to a job only by the names its profile lists, and shown as ***
// wherever a job's or a check's output is written. Nothing starts a model.
import assert from 'node:assert/strict';
import { spawn, spawnSync } from 'node:child_process';
import { existsSync, mkdirSync, mkdtempSync, readFileSync, statSync, writeFileSync } from 'node:fs';
import type { AddressInfo } from 'node:net';
import { tmpdir } from 'node:os';
import { dirname, join } from 'node:path';
import { test } from 'node:test';
import { fileURLToPath } from 'node:url';
import { toolsLog, writeJson } from '../../plugin/src/log.ts';
import { runJob } from '../../plugin/src/pipeline.ts';
import { prBody } from '../../plugin/src/pr.ts';
import { useJobEnv } from '../../plugin/src/profile.ts';
import { loadFactory, resolvePlan } from '../../plugin/src/profiles.ts';
import * as client from '../../plugin/src/remote.ts';
import { parseSpec } from '../../plugin/src/spec.ts';
import { deps, fakeAgent, makeRepo, write, writeSpec, type Step } from '../../plugin/test/helpers.ts';
import { hashToken, type Config } from '../src/config.ts';
import { freshBase } from '../src/fresh.ts';
import { checkProject, projectDir, removeProject, setupHere } from '../src/projects.ts';
import { jobSecrets, secretsDir, setSecret } from '../src/secrets.ts';
import { serve } from '../src/server.ts';
import { openStore } from '../src/store.ts';
import { supervise, type Launch } from '../src/supervisor.ts';
import { until } from './fake-slack.ts';

const CLI = join(dirname(fileURLToPath(import.meta.url)), '..', '..', 'plugin', 'src', 'cli.ts');
const SPEC = '---\nsize: small\n---\n# Done\n\n## Acceptance criteria\n\n1. It works.\n';
const git = (cwd: string, ...args: string[]) => {
  const r = spawnSync('git', args, { cwd, encoding: 'utf8', env: { ...process.env, GIT_AUTHOR_NAME: 'T', GIT_AUTHOR_EMAIL: 't@x', GIT_COMMITTER_NAME: 'T', GIT_COMMITTER_EMAIL: 't@x', GIT_CONFIG_GLOBAL: '/dev/null' } });
  assert.equal(r.status, 0, r.stderr);
  return r.stdout.trim();
};

/** A bare origin whose main holds profile, and Helix's clone of it. */
function github(profile: string) {
  const dir = mkdtempSync(join(tmpdir(), 'helix-secrets-'));
  const origin = join(dir, 'origin.git');
  const seed = join(dir, 'seed');
  git(dir, 'init', '--quiet', '--bare', '-b', 'main', origin);
  git(dir, 'clone', '--quiet', origin, seed);
  git(seed, 'checkout', '--quiet', '-b', 'main');
  mkdirSync(join(seed, '.animus'), { recursive: true });
  writeFileSync(join(seed, '.animus', 'animus.yaml'), profile);
  git(seed, 'add', '-A');
  git(seed, 'commit', '--quiet', '-m', 'profile');
  git(seed, 'push', '--quiet', 'origin', 'main:main');
  const clone = join(dir, 'clone');
  git(dir, 'clone', '--quiet', origin, clone);
  return { dir, clone };
}

/** Helix with ana (who added app and site), ben, and olu the owner, listening; jobs launched by launch. */
async function helix(profile = 'commands:\n  test: echo ok\n', launch: Launch = () => ({ command: process.execPath, args: ['-e', ''] })) {
  const gh = github(profile);
  const home = gh.dir;
  const config: Config = { host: '127.0.0.1', port: 0, slots: 1, owner: 'olu' };
  const store = openStore(join(home, 'helix.db'));
  for (const who of ['ana', 'ben', 'olu']) store.putPerson(who, { token_sha256: hashToken(`${who}-token`) });
  store.putProject({ name: 'app', url: 'https://github.com/o/app.git', dir: gh.clone, state: 'ready', added: '', added_by: 'ana' });
  store.putProject({ name: 'site', url: 'https://github.com/o/site.git', dir: join(home, 'site'), state: 'ready', added: '', added_by: 'ana' });
  const supervisor = supervise({ store, config, home, launch, fresh: freshBase, secrets: jobSecrets(home) });
  const server = serve({ config, store, supervisor, home });
  await new Promise<void>((r) => { server.listen(0, '127.0.0.1', r); });
  const url = `http://127.0.0.1:${(server.address() as AddressInfo).port}`;
  process.env.HELIX_URL = url;
  const as = (who: string) => { process.env.HELIX_TOKEN = `${who}-token`; };
  as('ana');
  const set = (person: string, project: string, name: string, value: string, mine = false) => setSecret({ store, home, config }, person, project, { name, value, mine });
  /** `animus <args>` as who, with input on its stdin. */
  const animus = (who: string, input: string, ...args: string[]) => new Promise<{ code: number | null; out: string }>((resolve) => {
    const child = spawn(process.execPath, ['--disable-warning=ExperimentalWarning', CLI, ...args], { env: { ...process.env, ANIMUS_HOME: join(home, 'animus'), HELIX_URL: url, HELIX_TOKEN: `${who}-token` } });
    let out = '';
    child.stdout.on('data', (c: Buffer) => { out += c.toString(); });
    child.stderr.on('data', (c: Buffer) => { out += c.toString(); });
    child.on('close', (code) => resolve({ code, out }));
    child.stdin.end(input);
  });
  const stop = () => { supervisor.stop(); server.close(); store.close(); };
  return { home, store, config, as, set, animus, stop };
}

// Protects: criterion 2 and the too-short note of criterion 6. Fails when: a value is taken from an argument, list shows a value, the warning is missing, or a short value is kept without saying it will show.
test('animus project secret set reads the value from stdin, never an argument, warns each time, and list shows names, scope and who without a value', async (t) => {
  const h = await helix();
  t.after(h.stop);

  const argued = await h.animus('ana', '', 'project', 'secret', 'set', 'app', 'API_KEY', 'sk-from-an-argument');
  assert.notEqual(argued.code, 0);
  assert.match(argued.out, /never from an argument/);

  const set = await h.animus('ana', 'sk-live-0123456789\n', 'project', 'secret', 'set', 'app', 'API_KEY');
  assert.equal(set.code, 0, set.out);
  assert.match(set.out, /the model can read every secret a job gets/);
  assert.doesNotMatch(set.out, /too short/);
  const short = await h.animus('ana', 'pin1\n', 'project', 'secret', 'set', 'app', 'PIN');
  assert.equal(short.code, 0, short.out);
  assert.match(short.out, /PIN is too short to be masked/);
  assert.match(short.out, /the model can read every secret a job gets/);

  const list = await h.animus('ana', '', 'project', 'secret', 'list', 'app');
  assert.equal(list.code, 0, list.out);
  assert.match(list.out, /API_KEY\s+shared\s+set by ana/);
  assert.match(list.out, /PIN\s+shared\s+set by ana/);
  assert.doesNotMatch(list.out, /sk-live|pin1|from-an-argument/);
  assert.ok(!readFileSync(join(secretsDir(h.home, 'app'), 'shared.json'), 'utf8').includes('from-an-argument'));

  const removed = await h.animus('ana', '', 'project', 'secret', 'remove', 'app', 'PIN');
  assert.equal(removed.code, 0, removed.out);
  assert.deepEqual((await client.secrets('app')).secrets.map((s) => s.name), ['API_KEY']);
});

// Protects: criteria 2 and 3, who may change which value. Fails when: anyone may set or remove a shared secret, a person cannot keep their own, or the files are readable by others.
test('only whoever added the project or the owner sets or removes a shared secret; with --mine anyone keeps their own, and removing the project removes them', async (t) => {
  const h = await helix();
  t.after(h.stop);
  h.as('ben');
  await assert.rejects(client.setSecret('app', 'API_KEY', 'ben-shared-value', false), /only ana .* or whoever runs Helix/);
  assert.deepEqual(await client.setSecret('app', 'API_KEY', 'ben-own-value-1', true), { project: 'app', name: 'API_KEY', mine: true, masked: true });
  h.as('olu');
  await client.setSecret('app', 'API_KEY', 'olu-shared-value', false);
  await client.setSecret('app', 'OLD', 'olu-old-value-1', false);
  h.as('ben');
  await assert.rejects(client.removeSecret('app', 'OLD', false), /only ana/);
  await assert.rejects(client.setSecret('app', 'ANIMUS_HOME', 'anything-at-all', true), /Animus or Helix sets ANIMUS_HOME itself/);
  await assert.rejects(client.setSecret('nowhere', 'API_KEY', 'anything-at-all', true), /no project named nowhere/);
  assert.deepEqual((await client.secrets('app')).secrets, [
    { name: 'API_KEY', scope: 'shared', by: 'olu' }, { name: 'OLD', scope: 'shared', by: 'olu' }, { name: 'API_KEY', scope: 'mine', by: 'ben' },
  ]);
  h.as('ana');
  assert.deepEqual((await client.secrets('app')).secrets.map((s) => s.scope), ['shared', 'shared'], 'ben\'s own value is his');
  await client.removeSecret('app', 'OLD', false);
  await assert.rejects(client.removeSecret('app', 'OLD', false), /no shared secret OLD/);
  h.as('ben');
  await client.removeSecret('app', 'API_KEY', true);
  assert.deepEqual((await client.secrets('app')).secrets.map((s) => s.scope), ['shared']);

  if (process.platform !== 'win32') {
    assert.equal(statSync(secretsDir(h.home, 'app')).mode & 0o777, 0o700);
    assert.equal(statSync(join(secretsDir(h.home, 'app'), 'shared.json')).mode & 0o777, 0o600);
  }
  removeProject({ store: h.store, home: h.home, config: h.config }, 'ana', 'app');
  assert.ok(!existsSync(secretsDir(h.home, 'app')));
});

// Protects: criterion 3 and criterion 6 in a job's log and result. Fails when: a job gets a name its profile does not list, another project's value, the shared value over its person's own, or the value shows in log.txt or the reason.
test('a job gets only the names its base branch lists, its person\'s own value before the shared one, and its output shows them as ***', async (t) => {
  let seen: Record<string, string> = {};
  const launch: Launch = (_job, _dir, env) => {
    seen = env;
    return { command: process.execPath, args: ['-e', 'process.stderr.write("using " + process.env.API_KEY + "\\n"); console.log(JSON.stringify({ outcome: "failed", reason: "it printed " + process.env.DB_URL }))'] };
  };
  const h = await helix('commands:\n  test: echo ok\nsecrets: [API_KEY, DB_URL, SITE_ONLY]\n', launch);
  t.after(h.stop);
  h.set('ana', 'app', 'API_KEY', 'shared-api-key-1');
  h.set('ana', 'app', 'API_KEY', 'ana-own-api-key-1', true);
  h.set('ana', 'app', 'DB_URL', 'postgres://shared-db');
  h.set('ana', 'app', 'UNLISTED', 'unlisted-value-1');
  h.set('ana', 'site', 'SITE_ONLY', 'site-only-value-1');
  h.set('ben', 'app', 'DB_URL', 'bens-own-db-url-1', true);

  const job = await client.submit({ repo: 'app', spec: SPEC, name: 'spec.md' });
  await until('the job ends', () => h.store.get(job.id)?.state === 'ended');

  assert.equal(seen.API_KEY, 'ana-own-api-key-1');
  assert.equal(seen.DB_URL, 'postgres://shared-db');
  assert.equal(seen.UNLISTED, undefined);
  assert.equal(seen.SITE_ONLY, undefined);
  const log = readFileSync(join(h.home, 'jobs', String(job.id), 'log.txt'), 'utf8');
  assert.match(log, /using \*\*\*/);
  assert.doesNotMatch(log, /ana-own-api-key-1/);
  assert.equal(h.store.get(job.id)!.reason, 'it printed ***');
});

// Protects: criterion 6 in the add check's output. Fails when: a gate that prints a secret puts its value in the check's log or reason.
test('the add check runs with the adder\'s secrets and shows them as *** in what it says', () => {
  const home = mkdtempSync(join(tmpdir(), 'helix-secrets-check-'));
  const source = makeRepo();
  write(source, '.animus/animus.yaml', 'secrets: [API_KEY]\ncommands:\n  test: echo "key is $API_KEY"; exit 1\n');
  spawnSync('git', ['add', '-A'], { cwd: source });
  spawnSync('git', ['commit', '-qm', 'profile'], { cwd: source });
  const bare = join(home, 'origin.git');
  git(home, 'clone', '-q', '--bare', source, bare);
  writeFileSync(join(home, 'ana.env'), 'GH_TOKEN=github_pat_ana\n');
  const store = openStore(join(home, 'helix.db'));
  store.putPerson('ana', { token_sha256: 'x', env_file: join(home, 'ana.env') });
  store.putProject({ name: 'app', url: bare, dir: projectDir(home, 'app'), state: 'checking', added: '2026-11-19T00:00:00.000Z', added_by: 'ana' });
  setSecret({ store, home, config: {} }, 'ana', 'app', { name: 'API_KEY', value: 'sk-check-0123456789', mine: false });
  const said: string[] = [];

  assert.equal(checkProject({ store, home, name: 'app', say: (l) => said.push(l), setup: setupHere }), false);
  const reason = store.project('app')!.reason!;
  assert.match(reason, /key is \*\*\*/);
  assert.ok(!said.join('\n').includes('sk-check-0123456789') && !reason.includes('sk-check-0123456789'), said.join('\n'));
  store.close();
});

// Protects: criterion 6 in what a job writes for the display and the pull request. Fails when: state, progress or run files, or the PR body, hold a secret's value.
test('inside a job, its job files and its pull request body show each secret of 8 or more characters as ***', (t) => {
  process.env.SECRET_MASK_LONG = 'long-secret-value';
  process.env.SECRET_MASK_SHORT = 'short';
  t.after(() => { delete process.env.SECRET_MASK_LONG; delete process.env.SECRET_MASK_SHORT; useJobEnv({ env: {}, secrets: [] }); });
  useJobEnv({ env: {}, secrets: ['SECRET_MASK_LONG', 'SECRET_MASK_SHORT'] });

  const file = join(mkdtempSync(join(tmpdir(), 'secret-mask-')), 'state.json');
  writeJson(file, { reason: 'failed with long-secret-value and short' });
  assert.deepEqual(JSON.parse(readFileSync(file, 'utf8')), { reason: 'failed with *** and short' });
  const spec = parseSpec('# Done\n\n## Acceptance criteria\n\n1. It works.\n   $ true\n');
  const body = prBody({ job: 'j', spec, plan: resolvePlan(loadFactory(), spec), summary: 'used long-secret-value', gates: [], gateAttempts: 1, fixRounds: 0, reviewRounds: 0, open: [], protectedTouched: [], escalations: [], models: 'fake', cost_usd: 0 });
  assert.ok(body.includes('used ***') && !body.includes('long-secret-value'));
});

// Protects: criterion 6 for what a running job writes (on one machine and in a Helix container alike): its gate reports and tool calls, read by the display, and its log, which the queue's loop stores as is. Fails when: a gate's output, a command the agent ran, or a logged failure holds the value.
test('a job whose gate prints its secret writes *** in its gate reports, its tools.jsonl and its log', async (t) => {
  process.env.SECRET_MASK_GATE = 'gate-secret-value';
  t.after(() => { delete process.env.SECRET_MASK_GATE; useJobEnv({ env: {}, secrets: [] }); });
  const repo = makeRepo();
  write(repo, '.animus/animus.yaml', 'secrets: [SECRET_MASK_GATE]\ncommands:\n  test: echo "key is $SECRET_MASK_GATE"; false\n');
  git(repo, 'commit', '-qam', 'secret');
  let tries = 0;
  const tried: Step = (req) => {
    write(req.cwd, 'src/feature.txt', `try ${++tries}\n`);
    git(req.cwd, 'add', '-A'); git(req.cwd, 'commit', '-qm', 'try');
    // A failed report with a changed branch is logged with its summary.
    return { output: { status: 'failed', summary: 'key is gate-secret-value' }, tools: [{ at: '', tool: 'Bash', target: 'curl -H "key: gate-secret-value" example.test', ok: true, ms: 1 }] };
  };
  const d = deps(fakeAgent([tried, tried, tried]).agent);

  const run = await runJob({ repo, specFile: writeSpec('size: small\ndifficulty: routine\ntype: feature') }, d);

  assert.equal(run.outcome, 'draft-pr', run.reason);
  const report = readFileSync(join(run.dir, 'gates', 'run-1.txt'), 'utf8');
  assert.match(report, /key is \*\*\*/);
  const tools = readFileSync(toolsLog(run.job), 'utf8');
  assert.match(tools, /key: \*\*\*/);
  const log = d.lines.join('\n');
  assert.match(log, /key is \*\*\*/);
  for (const text of [report, tools, log, d.published[0]!.body]) assert.ok(!text.includes('gate-secret-value'), text);
});
