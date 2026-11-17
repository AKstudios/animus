import assert from 'node:assert/strict';
import { mkdtempSync, readFileSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { test } from 'node:test';
import { parse } from 'yaml';
import { configFile } from '../src/config.ts';
import { deviceCode, githubSetup, githubUser, pollDevice, reachableRepos, refreshTokens } from '../src/github-app.ts';
import { fakeGitHub } from './fake-github.ts';

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
