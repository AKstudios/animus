import assert from 'node:assert/strict';
import { execFileSync } from 'node:child_process';
import { existsSync, mkdirSync, mkdtempSync, readFileSync, statSync } from 'node:fs';
import type { AddressInfo } from 'node:net';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { test } from 'node:test';
import { doctor } from '../../plugin/src/doctor.ts';
import { tokenPage } from '../../plugin/src/join.ts';
import * as client from '../../plugin/src/remote.ts';
import { hashToken, loadConfig, saveConfig, type Config } from '../src/config.ts';
import { credentialsFile, invite, joinHelix, type Verify } from '../src/join.ts';
import { serve } from '../src/server.ts';
import { openStore } from '../src/store.ts';
import { supervise, type Launch } from '../src/supervisor.ts';

const SPEC = '---\nsize: small\n---\n# hold\n\n## Acceptance criteria\n\n1. It works.\n';

/** A Helix with one person (ana) and one repository whose origin is on GitHub; jobs hold until the test ends. */
async function helix(verify: Verify) {
  const home = mkdtempSync(join(tmpdir(), 'helix-join-'));
  process.env.HELIX_HOME = home;
  process.env.ANIMUS_HOME = join(home, 'client');
  delete process.env.HELIX_URL;
  delete process.env.HELIX_TOKEN;
  const repo = join(home, 'repo');
  mkdirSync(repo);
  execFileSync('git', ['init', '-q'], { cwd: repo });
  execFileSync('git', ['remote', 'add', 'origin', 'https://github.com/acme/app.git'], { cwd: repo });
  const config: Config = { host: '127.0.0.1', port: 0, slots: 1, repos: { app: repo }, people: { ana: { token_sha256: hashToken('ana-token') } } };
  saveConfig(config);
  const launch: Launch = () => ({ command: process.execPath, args: ['-e', 'setInterval(() => {}, 1000)'] });
  const store = openStore(join(home, 'helix.db'));
  const supervisor = supervise({ store, config, home, launch });
  const server = serve({ config, store, supervisor, verify });
  await new Promise<void>((r) => { server.listen(0, '127.0.0.1', r); });
  const url = `http://127.0.0.1:${(server.address() as AddressInfo).port}`;
  const stop = () => { supervisor.stop(); server.close(); store.close(); };
  return { home, url, config, store, supervisor, stop };
}

const works: Verify = async (env) => ({ findings: [{ what: 'GitHub token', ok: true, detail: `signs in as cleo-gh (${env.GH_TOKEN})` }], login: 'cleo-gh' });
const TOKENS = { claude_token: 'sk-ant-oat01-cleo', github_token: 'github_pat_cleo' };

test('an invited person joins with a code, gets a token that works at once, and the code works only once', async () => {
  const h = await helix(works);
  const { code } = invite(h.config, h.store, 'cleo');
  assert.match(code, /^[a-z2-9]{4}(-[a-z2-9]{4}){3}$/);

  // Typed by hand: capitals and no dashes still do.
  const details = await client.inviteDetails(h.url, code.toUpperCase().replace(/-/g, ''));
  assert.equal(details.name, 'cleo');
  assert.deepEqual(details.repos, [{ name: 'app', url: 'https://github.com/acme/app.git' }]);

  const joined = await client.join(h.url, code, TOKENS);
  assert.deepEqual([joined.name, joined.github], ['cleo', 'cleo-gh']);

  // The tokens are kept beside the person's folder, not in it, for their jobs only.
  const file = credentialsFile('cleo');
  assert.equal(readFileSync(file, 'utf8'), 'CLAUDE_CODE_OAUTH_TOKEN=sk-ant-oat01-cleo\nGH_TOKEN=github_pat_cleo\n');
  if (process.platform !== 'win32') assert.equal(statSync(file).mode & 0o777, 0o600);
  assert.ok(!file.startsWith(join(h.home, 'people')));
  assert.deepEqual(loadConfig().people.cleo, { token_sha256: hashToken(joined.token), env_file: file, github: 'cleo-gh' });

  process.env.HELIX_URL = h.url;
  process.env.HELIX_TOKEN = joined.token;
  const job = await client.submit({ repo: 'app', spec: SPEC, name: 'spec.md' });
  assert.equal(job.person, 'cleo');

  await assert.rejects(client.join(h.url, code, TOKENS), /does not let anyone in/);
  await assert.rejects(client.inviteDetails(h.url, 'aaaa-bbbb-cccc-dddd'), /does not let anyone in/);
  h.stop();
});

test('tokens that do not work are refused with why, and the code still works for another try', async () => {
  let good = false;
  const h = await helix(async () => (good ? works({}) : { findings: [{ what: 'push to app', ok: false, detail: 'https://github.com/acme/app.git refused: 403' }], login: 'cleo-gh' }));
  const { code } = invite(h.config, h.store, 'cleo');
  await assert.rejects(client.join(h.url, code, TOKENS), /push to app: .*refused: 403[\s\S]*code still works/);
  assert.equal(loadConfig().people.cleo, undefined);
  assert.ok(!existsSync(credentialsFile('cleo')));
  good = true;
  assert.equal((await client.join(h.url, code, TOKENS)).name, 'cleo');
  h.stop();
});

test('an invite for a GitHub login takes only a token that signs in as it; one for someone already on Helix is refused', async () => {
  const h = await helix(works);
  const { code } = invite(h.config, h.store, 'cleo', { github: 'someone-else' });
  await assert.rejects(client.join(h.url, code, TOKENS), /for the GitHub account someone-else, and the token signs in as cleo-gh/);
  assert.throws(() => invite(h.config, h.store, 'ana'), /already on Helix/);
  assert.throws(() => invite(h.config, h.store, '../ben'), /name may hold/);
  await assert.rejects(client.join(h.url, invite(h.config, h.store, 'dan').code, { claude_token: 'x', github_token: 'github_pat_dan' }), /claude_token/);
  h.stop();
});

test('an invite ends after 24 hours, and a new one for the same name replaces it', async () => {
  const h = await helix(works);
  const at = new Date('2026-11-16T12:00:00Z');
  const first = invite(h.config, h.store, 'cleo', { at });
  const second = invite(h.config, h.store, 'cleo', { at });
  const body = { code: second.code, ...TOKENS };
  await assert.rejects(joinHelix({ config: h.config, store: h.store, verify: works, at }, { ...body, code: first.code }), /does not let anyone in/);
  await assert.rejects(joinHelix({ config: h.config, store: h.store, verify: works, at: new Date('2026-11-17T12:00:01Z') }, body), /does not let anyone in/);
  assert.equal((await joinHelix({ config: h.config, store: h.store, verify: works, at: new Date('2026-11-17T11:59:00Z') }, body)).name, 'cleo');
  h.stop();
});

test('a person who leaves is off at once: token, jobs, credentials and folder', async () => {
  const h = await helix(works);
  const joined = await client.join(h.url, invite(h.config, h.store, 'cleo').code, TOKENS);
  client.saveHelixLogin({ url: h.url, token: joined.token, name: 'cleo' });
  const job = await client.submit({ repo: 'app', spec: SPEC, name: 'spec.md' });
  mkdirSync(join(h.home, 'people', 'cleo', 'animus'), { recursive: true });

  const gone = await client.leave();
  assert.deepEqual(gone, { name: 'cleo', cancelled: [job.id] });
  assert.equal(h.store.get(job.id)?.state, 'cancelled');
  assert.equal(loadConfig().people.cleo, undefined);
  assert.ok(!existsSync(credentialsFile('cleo')));
  assert.ok(!existsSync(join(h.home, 'people', 'cleo')));
  await assert.rejects(client.jobs(), /valid token is needed/);
  h.stop();
});

test('the client uses HELIX_URL and HELIX_TOKEN when set, else what join kept; doctor says which', async () => {
  const h = await helix(works);
  assert.equal(client.helixLogin(), undefined);
  await assert.rejects(client.jobs(), /has not joined a Helix/);
  client.saveHelixLogin({ url: h.url, token: 'ana-token', name: 'ana' });
  if (process.platform !== 'win32') assert.equal(statSync(client.helixFile()).mode & 0o777, 0o600);
  assert.equal((await client.jobs()).slots, 1);
  const found = await doctor(h.home);
  assert.match(found.find((f) => f.what === 'helix token')?.detail ?? '', /ana's, from .*helix\.json/);
  assert.equal(client.helixLogin({ HELIX_URL: 'http://x', HELIX_TOKEN: 't' })?.from, 'HELIX_URL and HELIX_TOKEN');
  h.stop();
});

test('GitHub\'s token page comes filled in for the repositories\' owner, with what a job needs', () => {
  const page = new URL(tokenPage({ name: 'cleo', expires: '', repos: [{ name: 'app', url: 'https://github.com/acme/app.git' }] }));
  assert.equal(page.origin + page.pathname, 'https://github.com/settings/personal-access-tokens/new');
  const q = Object.fromEntries(page.searchParams);
  assert.equal(q.target_name, 'acme');
  assert.deepEqual([q.contents, q.pull_requests, q.expires_in], ['write', 'write', '90']);
  assert.ok(q.name!.length <= 40);
  assert.match(q.description!, /acme\/app/);
});
