import assert from 'node:assert/strict';
import { existsSync, mkdtempSync, readFileSync, statSync, writeFileSync } from 'node:fs';
import { createServer } from 'node:http';
import type { AddressInfo } from 'node:net';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { test } from 'node:test';
import { parse } from 'yaml';
import { configFile, hashToken } from '../src/config.ts';
import { slackEnvFile, slackSetup } from '../src/slack-api.ts';
import { openStore } from '../src/store.ts';

/** Slack's Web API as far as setup uses it: these tokens work, any other is refused. */
async function fakeSlack() {
  const works: Record<string, string> = { 'auth.test': 'xoxb-good', 'apps.connections.open': 'xapp-good' };
  const asked: string[] = [];
  const server = createServer((req, res) => {
    const method = req.url!.replace('/api/', '');
    const token = req.headers.authorization?.replace('Bearer ', '');
    asked.push(`${method} ${token}`);
    res.setHeader('content-type', 'application/json');
    res.end(JSON.stringify(works[method] === token
      ? { ok: true, team: 'Acme', user: 'helix', url: 'wss://example.invalid/link' }
      : { ok: false, error: 'invalid_auth' }));
  });
  await new Promise<void>((r) => { server.listen(0, '127.0.0.1', r); });
  return { api: `http://127.0.0.1:${(server.address() as AddressInfo).port}/api`, asked, close: () => server.close() };
}

/** A Helix whose owner is ajmal, not yet linked to Slack. */
function home() {
  process.env.HELIX_HOME = mkdtempSync(join(tmpdir(), 'helix-slack-'));
  writeFileSync(configFile(), 'slots: 3\nowner: ajmal\n');
  const store = openStore(join(process.env.HELIX_HOME, 'helix.db'));
  store.putPerson('ajmal', { token_sha256: hashToken('ajmal-token') });
  return store;
}

// Protects: criterion 1's happy path. Fails when: a token is not tried, is stored where others can read it, or config.yaml loses what it had.
test('setup tries both tokens against Slack, keeps them in slack.env (600) and turns Slack on in config.yaml', async () => {
  const store = home();
  const slack = await fakeSlack();
  const done = await slackSetup(store, { bot: 'xoxb-good', app: 'xapp-good', user: 'U0123ABCD' }, slack.api);
  slack.close();
  store.close();

  assert.equal(done.team, 'Acme');
  assert.deepEqual(slack.asked, ['auth.test xoxb-good', 'apps.connections.open xapp-good']);
  assert.equal(slackEnvFile(), join(process.env.HELIX_HOME!, 'credentials', 'slack.env'));
  assert.equal(readFileSync(slackEnvFile(), 'utf8'), 'SLACK_BOT_TOKEN=xoxb-good\nSLACK_APP_TOKEN=xapp-good\n');
  if (process.platform !== 'win32') assert.equal(statSync(slackEnvFile()).mode & 0o777, 0o600);
  assert.deepEqual(parse(readFileSync(configFile(), 'utf8')), { slots: 3, owner: 'ajmal', slack: { enabled: true } });
});

// Protects: nothing is written unless both tokens work. Fails when: a refusal is swallowed, its reason lost, or a half setup is left.
for (const [what, answers, refusal] of [
  ['the bot token', { bot: 'xoxb-revoked', app: 'xapp-good', user: 'U0123ABCD' }, /Slack refused the bot token: invalid_auth/],
  ['the app token', { bot: 'xoxb-good', app: 'xapp-revoked', user: 'U0123ABCD' }, /Slack refused the app token: invalid_auth/],
  ['the owner\'s Slack user', { bot: 'xoxb-good', app: 'xapp-good', user: '@alex' }, /@alex is not a Slack user id/],
] as const) {
  test(`when ${what} is refused, setup says why and writes nothing`, async () => {
    const store = home();
    const slack = await fakeSlack();
    await assert.rejects(slackSetup(store, answers, slack.api), refusal);
    slack.close();
    assert.ok(!existsSync(slackEnvFile()));
    assert.equal(readFileSync(configFile(), 'utf8'), 'slots: 3\nowner: ajmal\n');
    assert.equal(store.slackOf('ajmal'), undefined);
    store.close();
  });
}
