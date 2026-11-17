import assert from 'node:assert/strict';
import { mkdtempSync, readFileSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { test } from 'node:test';
import { parse } from 'yaml';
import type { AddressInfo } from 'node:net';
import { describeUnreachable, signInWithGitHub } from '../../plugin/src/join.ts';
import { configFile, saveConfig, type Config } from '../src/config.ts';
import { deviceCode, githubSetup, githubUser, pollDevice, reachableRepos, refreshTokens } from '../src/github-app.ts';
import { credentialsFile, invite, type Verify } from '../src/join.ts';
import { serve } from '../src/server.ts';
import { openStore } from '../src/store.ts';
import { supervise } from '../src/supervisor.ts';
import { fakeGitHub, type FakeGitHub } from './fake-github.ts';

/** A Helix with a config.yaml of its own and no github: entry yet. */
function home() {
  process.env.HELIX_HOME = mkdtempSync(join(tmpdir(), 'helix-github-'));
  writeFileSync(configFile(), 'slots: 3\nowner: ajmal\n');
}

// Protects: criterion 1's happy path. Fails when: the ID is not tried with GitHub, or config.yaml loses what it had.
test('setup proves the client ID with a device-code request and writes it to config.yaml', async () => {
  home();
  const github = await fakeGitHub({ clientId: 'Iv23liGood' });
  await githubSetup(' Iv23liGood\n', github);
  await github.close();

  assert.deepEqual(github.calls, ['POST /login/device/code']);
  assert.deepEqual(parse(readFileSync(configFile(), 'utf8')), { slots: 3, owner: 'ajmal', github: { client_id: 'Iv23liGood' } });
});

// Protects: criterion 1's refusal. Fails when: GitHub's reason is lost, or the refused ID is written anyway.
test('an ID GitHub refuses is reported with its reason and nothing is written', async () => {
  home();
  const github = await fakeGitHub({ clientId: 'Iv23liGood' });
  await assert.rejects(githubSetup('Iv23liWrong', github), /GitHub refused the client ID Iv23liWrong: The client_id and\/or client_secret passed are incorrect\. \(incorrect_client_credentials\)\. Nothing was written/);
  await github.close();

  assert.equal(readFileSync(configFile(), 'utf8'), 'slots: 3\nowner: ajmal\n');
});

// Protects: the device flow's polling. Fails when: polling gives up while the person has not approved yet, or keeps the old pace after slow_down.
test('polling waits through slow_down and a pending approval, then returns the approver\'s tokens', async () => {
  const github = await fakeGitHub();
  const code = await deviceCode('Iv23liGood', github);
  github.slowDowns = 1;
  const waits: number[] = [];
  const tokens = await pollDevice('Iv23liGood', code, github, async (seconds) => {
    waits.push(seconds);
    if (waits.length === 2) github.approve(code.user_code, 'alex');
  });
  const user = await githubUser(tokens.access_token, github);
  await github.close();

  assert.deepEqual(waits, [10, 10]);
  assert.equal(user.login, 'alex');
  assert.match(tokens.refresh_token, /^ghr_/);
});

// Protects: a cancelled sign-in ends the poll. Fails when: access_denied is polled forever or its code is lost to the caller.
test('polling stops with GitHub\'s code when the person cancels', async () => {
  const github = await fakeGitHub();
  const code = await deviceCode('Iv23liGood', github);
  github.deny(code.user_code);
  await assert.rejects(pollDevice('Iv23liGood', code, github, async () => {}), { code: 'access_denied' });
  await github.close();
});

// Protects: refresh trades the refresh token for a new pair. Fails when: the new refresh token is not returned, or a refused one is not an error with GitHub's code.
test('refresh returns a new pair, and a used refresh token is refused with GitHub\'s code', async () => {
  const github = await fakeGitHub();
  const code = await deviceCode('Iv23liGood', github);
  github.approve(code.user_code, 'alex');
  const first = await pollDevice('Iv23liGood', code, github, async () => {});
  const second = await refreshTokens('Iv23liGood', first.refresh_token, github);

  assert.notEqual(second.refresh_token, first.refresh_token);
  assert.equal((await githubUser(second.access_token, github)).login, 'alex');
  await assert.rejects(refreshTokens('Iv23liGood', first.refresh_token, github), { code: 'bad_refresh_token' });
  await github.close();
});

// Protects: what the app reaches for a person. Fails when: an installation, or a page past the first, is left out.
test('reachable repositories span every installation the person can see, every page of each', async () => {
  const github = await fakeGitHub();
  github.installed = { AKstudios: ['animus', 'site'], acme: Array.from({ length: 101 }, (_, i) => `r${i}`), other: ['secret'] };
  github.access = { alex: ['AKstudios/animus', ...Array.from({ length: 101 }, (_, i) => `acme/r${i}`)] };
  const code = await deviceCode('Iv23liGood', github);
  github.approve(code.user_code, 'alex');
  const tokens = await pollDevice('Iv23liGood', code, github, async () => {});
  const reach = await reachableRepos(tokens.access_token, github);
  await github.close();

  assert.equal(reach.slug, 'animus-helix');
  assert.equal(reach.repos.length, 102);
  assert.ok(reach.repos.includes('AKstudios/animus') && reach.repos.includes('acme/r100'));
  assert.ok(!reach.repos.includes('AKstudios/site'));
});

/**
 * A Helix with the app and two projects, acme/app and AKstudios/site, that
 * signs people in at a fake GitHub. Each wait between polls is the person
 * approving, as approver, the code they were shown; each POST /join waits
 * on GitHub once, so the client asks again.
 */
async function helixWithApp(github: FakeGitHub) {
  const home = mkdtempSync(join(tmpdir(), 'helix-app-'));
  process.env.HELIX_HOME = home;
  process.env.ANIMUS_HOME = join(home, 'client');
  const config: Config = { host: '127.0.0.1', port: 0, slots: 1, github: { client_id: 'Iv23liGood' } };
  saveConfig(config);
  const store = openStore(join(home, 'helix.db'));
  store.putProject({ name: 'app', url: 'https://github.com/acme/app.git', dir: home, state: 'ready', added: '' });
  store.putProject({ name: 'site', url: 'https://github.com/AKstudios/site', dir: home, state: 'ready', added: '' });
  github.installed = { acme: ['app'] };
  const h = { url: '', store, approver: { code: '', login: '' }, stop: () => {} };
  const verify: Verify = async (env) => ({ findings: [{ what: 'GitHub token', ok: true, detail: env.GH_TOKEN! }, { what: 'push to site', ok: false, detail: 'refused: 403', optional: true }], login: 'from-verify' });
  const supervisor = supervise({ store, config, home, launch: () => ({ command: process.execPath, args: ['-e', ''] }) });
  const server = serve({ config, store, supervisor, verify, github: { urls: github, holdSeconds: 0, wait: async () => { github.approve(h.approver.code, h.approver.login); } } });
  await new Promise<void>((r) => { server.listen(0, '127.0.0.1', r); });
  h.url = `http://127.0.0.1:${(server.address() as AddressInfo).port}`;
  h.stop = () => { supervisor.stop(); server.close(); store.close(); };
  return h;
}

/** The person at the terminal: what animus join said and which page it opened. */
const terminal = () => ({ said: [] as string[], opened: [] as string[], say(line = '') { this.said.push(line); }, open(url: string) { this.opened.push(url); } });

// Protects: criteria 2 and 3. Fails when: join still needs a GitHub token, the person is not joined as the login that approved, their tokens are not kept, or an unreachable project is not named with the install link.
test('join shows GitHub\'s code, opens its page, waits for approval and joins as the approving login, naming the projects the app cannot reach', async () => {
  const github = await fakeGitHub();
  const h = await helixWithApp(github);
  const { code } = invite(h.store, 'cleo');
  h.approver = { code: 'WDJB-MJH1', login: 'cleo-gh' };
  const io = terminal();

  const joined = await signInWithGitHub(h.url, code, 'sk-ant-oat01-cleo', undefined, io);
  const person = h.store.person('cleo');
  h.stop();
  await github.close();

  assert.match(io.said.join('\n'), /Type WDJB-MJH1 at http:\/\/127\.0\.0\.1:\d+\/login\/device/);
  assert.deepEqual(io.opened, [`${github.web}/login/device`]);
  assert.deepEqual([joined.name, joined.github, person?.github], ['cleo', 'cleo-gh', 'cleo-gh']);
  assert.equal(readFileSync(credentialsFile('cleo'), 'utf8'), 'CLAUDE_CODE_OAUTH_TOKEN=sk-ant-oat01-cleo\nGH_TOKEN=ghu_1\nGH_REFRESH_TOKEN=ghr_1\n');
  const install = `${github.web}/apps/animus-helix/installations/new`;
  assert.deepEqual(joined.unreachable, [{ project: 'site', owner: 'AKstudios', install }]);
  assert.deepEqual(joined.cannot_push, []);
  assert.match(describeUnreachable(joined.unreachable!), new RegExp(`site \\(AKstudios\\): ${install}`));
});

// Protects: criterion 2's refusal. Fails when: another login than the invite's gets in, or the refusal takes the code.
test('an invite with --github refuses another login that approves, and its code still joins the right one', async () => {
  const github = await fakeGitHub();
  const h = await helixWithApp(github);
  const { code } = invite(h.store, 'cleo', { github: 'cleo-gh' });
  h.approver = { code: 'WDJB-MJH1', login: 'mallory' };
  await assert.rejects(signInWithGitHub(h.url, code, 'sk-ant-oat01-cleo', 'cleo-gh', terminal()), /for the GitHub account cleo-gh, and mallory approved/);
  assert.equal(h.store.person('cleo'), undefined);

  h.approver = { code: 'WDJB-MJH2', login: 'cleo-gh' };
  const joined = await signInWithGitHub(h.url, code, 'sk-ant-oat01-cleo', 'cleo-gh', terminal());
  h.stop();
  await github.close();

  assert.equal(joined.github, 'cleo-gh');
});
