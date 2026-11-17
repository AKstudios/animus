import assert from 'node:assert/strict';
import { chmodSync, mkdirSync, mkdtempSync, readFileSync, statSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { test } from 'node:test';
import { parse } from 'yaml';
import type { AddressInfo } from 'node:net';
import { describeUnreachable, githubLogin, signInWithGitHub } from '../../plugin/src/join.ts';
import { inviteDetails } from '../../plugin/src/remote.ts';
import type { Display } from '../../plugin/display/shape.ts';
import { animusCleanups } from '../src/cleanup.ts';
import { configFile, saveConfig, type Config } from '../src/config.ts';
import { personDirs } from '../src/container.ts';
import { beforeJob, checkSignIn, deviceCode, freshToken, githubSetup, githubUser, pollDevice, reachableRepos, refreshTokens } from '../src/github-app.ts';
import { credentialsFile, invite, type Verify } from '../src/join.ts';
import { checkInChild } from '../src/projects.ts';
import { serve } from '../src/server.ts';
import { slackNotifier } from '../src/slack.ts';
import { openStore } from '../src/store.ts';
import { supervise } from '../src/supervisor.ts';
import { fakeGitHub, type FakeGitHub } from './fake-github.ts';
import { fakeTransport, until } from './fake-slack.ts';

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
  const slack = fakeTransport();
  const verify: Verify = async (env) => ({ findings: [{ what: 'GitHub token', ok: true, detail: env.GH_TOKEN! }, { what: 'push to site', ok: false, detail: 'refused: 403', optional: true }], login: 'from-verify' });
  // Each job's variables, as it was launched with them.
  const launched: Record<string, string>[] = [];
  const supervisor = supervise({ store, config, home, launch: (_job, _dir, env) => { launched.push(env); return { command: process.execPath, args: ['-e', ''] }; }, prepare: beforeJob(store, config, github), notify: slackNotifier(slack.transport, store) });
  const h = { url: '', home, config, store, supervisor, launched, slack, approver: { code: '', login: '' }, stop: () => {} };
  // GitHub's open PRs of a project: PR 7 of acme/app, for a token the fake GitHub takes.
  const listPrs = async (_repo: string, token: string) => {
    const res = await fetch(`${github.api}/user`, { headers: { authorization: `Bearer ${token}` } });
    if (!res.ok) throw new Error(`GitHub answered ${res.status}`);
    return [{ html_url: 'https://github.com/acme/app/pull/7', number: 7, title: 'Add login', created_at: '2026-11-17T10:00:00Z' }];
  };
  const server = serve({ config, store, supervisor, verify, listPrs, github: { urls: github, holdSeconds: 0, wait: async () => { github.approve(h.approver.code, h.approver.login); } } });
  await new Promise<void>((r) => { server.listen(0, '127.0.0.1', r); });
  h.url = `http://127.0.0.1:${(server.address() as AddressInfo).port}`;
  h.stop = () => { supervisor.stop(); server.close(); store.close(); };
  return h;
}

/** The person at the terminal: what animus join said and which page it opened. */
const terminal = () => ({ said: [] as string[], opened: [] as string[], say(line = '') { this.said.push(line); }, open(url: string) { this.opened.push(url); } });

/** cleo joins as cleo-gh, with the first tokens the fake GitHub hands out (ghu_1, ghr_1). Returns her Helix token. */
async function joinCleo(h: Awaited<ReturnType<typeof helixWithApp>>): Promise<string> {
  const { code } = invite(h.store, 'cleo');
  h.approver = { code: 'WDJB-MJH1', login: 'cleo-gh' };
  return (await signInWithGitHub(h.url, code, 'sk-ant-oat01-cleo', undefined, terminal())).token;
}

const SPEC = '---\nsize: small\n---\n# Add login\n\n## Acceptance criteria\n\n1. It works.\n';

/** Submits cleo's job for a project and waits for it to end, however it ends. */
async function cleosJob(h: Awaited<ReturnType<typeof helixWithApp>>, repo: string) {
  const { id } = h.supervisor.submit('cleo', { repo, spec: SPEC });
  await until(`job ${id} to end`, () => h.store.get(id)?.state === 'ended', 5000);
  return h.store.get(id)!;
}

// Protects: criterion 4. Fails when: a job runs with the access token from join (ended after eight hours), the new refresh token is not kept with mode 600, or the refresh token reaches the job.
test('each job gets a fresh access token as GH_TOKEN, the new refresh token is kept in the credentials file, and the job never sees it', async () => {
  const github = await fakeGitHub();
  const h = await helixWithApp(github);
  await joinCleo(h);
  chmodSync(credentialsFile('cleo'), 0o644);

  await cleosJob(h, 'app');
  const kept = readFileSync(credentialsFile('cleo'), 'utf8');
  h.stop();
  await github.close();

  assert.equal(h.launched.length, 1);
  assert.equal(h.launched[0]!.GH_TOKEN, 'ghu_2');
  assert.equal(h.launched[0]!.GH_REFRESH_TOKEN, undefined);
  assert.equal(kept, 'CLAUDE_CODE_OAUTH_TOKEN=sk-ant-oat01-cleo\nGH_TOKEN=ghu_2\nGH_REFRESH_TOKEN=ghr_2\n');
  if (process.platform !== 'win32') assert.equal(statSync(credentialsFile('cleo')).mode & 0o777, 0o600);
});

// Protects: criterion 4's refusal. Fails when: a job for a repository the app cannot reach for the person starts anyway, or its reason lacks the install link.
test('a job for a project the app cannot reach for the person fails before it starts, with the app\'s install link', async () => {
  const github = await fakeGitHub();
  const h = await helixWithApp(github);
  await joinCleo(h);

  const job = await cleosJob(h, 'site');
  h.stop();
  await github.close();

  assert.equal(h.launched.length, 0);
  assert.equal(job.outcome, 'failed');
  assert.equal(job.reason, `Helix's GitHub App cannot reach AKstudios/site for you: ask its owner to install the app on it at ${github.web}/apps/animus-helix/installations/new`);
});

// Protects: criterion 5. Fails when: a refused refresh lets the job start with a stale token, the reason does not say to run animus github login, or the linked person is not told on Slack.
test('a refresh GitHub refuses fails the job before it starts with "run animus github login", and DMs the person on Slack', async () => {
  const github = await fakeGitHub();
  const h = await helixWithApp(github);
  await joinCleo(h);
  h.store.linkSlack('cleo', 'U0CLEO');
  writeFileSync(credentialsFile('cleo'), 'CLAUDE_CODE_OAUTH_TOKEN=sk-ant-oat01-cleo\nGH_TOKEN=ghu_1\nGH_REFRESH_TOKEN=ghr_revoked\n');

  const job = await cleosJob(h, 'app');
  await until('the DM', () => h.slack.sent.some((s) => s.method === 'post'));
  h.stop();
  await github.close();

  assert.equal(h.launched.length, 0);
  assert.match(job.reason!, /GitHub no longer takes your sign-in .*bad_refresh_token.*: run `animus github login`/);
  assert.deepEqual(h.slack.sent.filter((s) => s.method === 'post').map((s) => [s.channel, s.text]), [['D-U0CLEO', `Job ${job.id} failed: ${job.reason}`]]);
});

// Protects: criterion 5's relogin. Fails when: animus github login does not replace the stored tokens, drops the Claude token, or takes another GitHub account's sign-in.
test('animus github login replaces the stored tokens, and refuses a login other than the person\'s own', async () => {
  const github = await fakeGitHub();
  const h = await helixWithApp(github);
  process.env.HELIX_URL = h.url;
  process.env.HELIX_TOKEN = await joinCleo(h);

  h.approver = { code: 'WDJB-MJH2', login: 'mallory' };
  await assert.rejects(githubLogin(terminal()), /you are on Helix as the GitHub account cleo-gh, and mallory approved the sign-in/);
  h.approver = { code: 'WDJB-MJH3', login: 'cleo-gh' };
  const io = terminal();
  await githubLogin(io);
  const kept = readFileSync(credentialsFile('cleo'), 'utf8');
  delete process.env.HELIX_URL;
  delete process.env.HELIX_TOKEN;
  h.stop();
  await github.close();

  assert.match(io.said.join('\n'), /Type WDJB-MJH3 at http:\/\/127\.0\.0\.1:\d+\/login\/device/);
  assert.equal(kept, 'CLAUDE_CODE_OAUTH_TOKEN=sk-ant-oat01-cleo\nGH_TOKEN=ghu_3\nGH_REFRESH_TOKEN=ghr_3\n');
});

// Protects: criterion 4 in helix check. Fails when: helix check tries the access token from join instead of refreshing it first, or does not keep the new refresh token.
test('helix check refreshes the person\'s sign-in first and keeps the new tokens', async () => {
  const github = await fakeGitHub();
  const h = await helixWithApp(github);
  await joinCleo(h);

  const found = await checkSignIn(h.store, h.config, 'cleo', github);
  const kept = readFileSync(credentialsFile('cleo'), 'utf8');
  h.stop();
  await github.close();

  assert.deepEqual(found.map((f) => [f.what, f.ok]), [['GitHub sign-in', true]]);
  assert.match(kept, /GH_TOKEN=ghu_2\nGH_REFRESH_TOKEN=ghr_2\n/);
});

// Protects: criterion 4 before a project check. Fails when: a project is checked without refreshing its adder's sign-in, or a refused refresh leaves it checking.
test('a project check refreshes its adder\'s sign-in first, and fails the project when GitHub refuses', async () => {
  const github = await fakeGitHub();
  const h = await helixWithApp(github);
  await joinCleo(h);
  writeFileSync(credentialsFile('cleo'), 'GH_TOKEN=ghu_1\nGH_REFRESH_TOKEN=ghr_revoked\n');
  h.store.putProject({ name: 'new', url: 'https://github.com/acme/new.git', dir: join(h.home, 'new'), state: 'checking', added: '', added_by: 'cleo' });

  checkInChild(h.store, h.home, () => {}, (person) => freshToken(h.store, h.config, person, github))('new');
  await until('the check to fail', () => h.store.project('new')?.state === 'failed');
  const reason = h.store.project('new')?.reason;
  h.stop();
  await github.close();

  assert.match(reason!, /run `animus github login`/);
});

// Protects: the display's open PRs on a Helix with the app. Fails when: GitHub is asked with the access token from join after its eight hours, so the PRs drop off.
test('the display asks GitHub for open PRs with a refreshed token once the access token has expired', async () => {
  const github = await fakeGitHub();
  const h = await helixWithApp(github);
  await joinCleo(h);
  github.expire('ghu_1');
  h.store.add({ state: 'ended', person: 'cleo', repo: 'app', spec: '', title: 'Add login', draft: false, submitted: '2026-11-17T10:00:00Z', outcome: 'pr', pr: 'https://github.com/acme/app/pull/7' });

  const d = (await (await fetch(`${h.url}/display`)).json()) as Display;
  h.stop();
  await github.close();

  assert.deepEqual(d.prs?.map((p) => [p.number, p.person]), [[7, 'cleo']]);
});

// Protects: the daily animus cleanup on a Helix with the app. Fails when: it runs with the access token from join after its eight hours, so no PR's state can be read.
test('animus cleanup runs with a refreshed token once the access token has expired', async () => {
  const github = await fakeGitHub();
  const h = await helixWithApp(github);
  await joinCleo(h);
  github.expire('ghu_1');
  mkdirSync(join(personDirs(h.home, 'cleo').animus, 'jobs'), { recursive: true });

  const [run] = await animusCleanups(h.store, { home: h.home, contained: true, fresh: (person) => freshToken(h.store, h.config, person, github) });
  const user = await githubUser(run!.env!.GH_TOKEN!, github);
  h.stop();
  await github.close();

  assert.equal(user.login, 'cleo-gh');
});

// Protects: criteria 2 and 3. Fails when: join still needs a GitHub token, the person is not joined as the login that approved, their tokens are not kept, or an unreachable project is not named with the install link.
test('join shows GitHub\'s code, opens its page, waits for approval and joins as the approving login, naming the projects the app cannot reach', async () => {
  const github = await fakeGitHub();
  const h = await helixWithApp(github);
  const { code } = invite(h.store, 'cleo');
  h.approver = { code: 'WDJB-MJH1', login: 'cleo-gh' };
  const io = terminal();

  // animus join takes the GitHub sign-in over a pasted token only when the invite says the Helix has the app.
  const details = await inviteDetails(h.url, code);
  const joined = await signInWithGitHub(h.url, code, 'sk-ant-oat01-cleo', undefined, io);
  const person = h.store.person('cleo');
  h.stop();
  await github.close();

  assert.equal(details.github_app, true);
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
