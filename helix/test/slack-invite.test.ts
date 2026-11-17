import assert from 'node:assert/strict';
import { mkdtempSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { test } from 'node:test';
import { hashToken, type Config } from '../src/config.ts';
import { invite, joinHelix, takeOff, type Verify } from '../src/join.ts';
import { slackBot } from '../src/slack.ts';
import { openStore } from '../src/store.ts';
import { fakeTransport } from './fake-slack.ts';

const CONFIG: Config = { host: '127.0.0.1', port: 0, slots: 1, slack: { enabled: true, owner: 'U0OWNER' } };
const NOT_ON = 'You\'re not on this Helix. Ask <@U0OWNER> for an invite.';

/** A Helix with ana on it, and the bot's core listening on a fake transport. */
function helix() {
  process.env.HELIX_HOME = mkdtempSync(join(tmpdir(), 'helix-slack-invite-'));
  const store = openStore(join(process.env.HELIX_HOME, 'helix.db'));
  store.putPerson('ana', { token_sha256: hashToken('ana-token') });
  const slack = fakeTransport();
  slackBot(slack.transport, { store, config: CONFIG });
  return { store, slack };
}

const works: Verify = async () => ({ findings: [{ what: 'GitHub token', ok: true, detail: 'signs in as alex-gh' }], login: 'alex-gh' });
const TOKENS = { claude_token: 'sk-ant-oat01-alex', github_token: 'github_pat_alex' };

// Protects: criterion 3, joining links. Fails when: the invite's Slack user is lost, or joining does not link it.
test('joining with an invite that carries a Slack user links that user to the person', async () => {
  const { store, slack } = helix();
  const { code } = invite(store, 'alex', { github: 'alex-gh', slack: 'U0ALEX' });

  await joinHelix({ store, verify: works }, { code, ...TOKENS });
  await slack.deliver({ kind: 'command', user: 'U0ALEX', channel: 'D0ALEX', text: 'nonsense' });

  assert.equal(store.personBySlack('U0ALEX'), 'alex');
  store.close();
  // The bot knows alex now: not the stranger's reply.
  assert.equal(slack.sent.length, 1);
  assert.notEqual((slack.sent[0] as { text: string }).text, NOT_ON);
});

// Protects: criterion 3, the owner links an earlier joiner. Fails when: /helix link does not link, or links for someone but the owner, or to a person who is not there.
test('the owner\'s /helix link @user <person> links someone who joined before; anyone else, or an unknown person, is refused privately', async () => {
  const { store, slack } = helix();
  store.putPerson('alex', { token_sha256: hashToken('alex-token') });
  store.linkSlack('alex', 'U0ALEX');

  await slack.deliver({ kind: 'command', user: 'U0ALEX', channel: 'C0TEAM', text: 'link <@U0SAM|sam> ana' });
  await slack.deliver({ kind: 'command', user: 'U0OWNER', channel: 'C0TEAM', text: 'link <@U0ANA|ana> nobody' });
  await slack.deliver({ kind: 'command', user: 'U0OWNER', channel: 'C0TEAM', text: 'link <@U0ANA|ana> ana' });

  assert.equal(store.personBySlack('U0SAM'), undefined);
  assert.equal(store.personBySlack('U0ANA'), 'ana');
  store.close();
  assert.deepEqual(slack.sent, [
    { method: 'ephemeral', channel: 'C0TEAM', user: 'U0ALEX', text: 'Only <@U0OWNER> links Slack users to people on this Helix.' },
    { method: 'ephemeral', channel: 'C0TEAM', user: 'U0OWNER', text: 'Helix has no person named nobody.' },
    { method: 'ephemeral', channel: 'C0TEAM', user: 'U0OWNER', text: 'Linked <@U0ANA> to ana.' },
  ]);
});

// Protects: criterion 3, leaving unlinks. Fails when: a person taken off Helix (animus leave and helix remove-person both take them off with takeOff) keeps their Slack user, which the bot then still treats as on Helix.
test('a person taken off Helix loses their Slack link, and the bot then treats them as a stranger', async () => {
  const { store, slack } = helix();
  store.linkSlack('ana', 'U0ANA');

  takeOff('ana', store);
  await slack.deliver({ kind: 'message', user: 'U0ANA', channel: 'D0ANA', text: 'hello' });

  assert.equal(store.personBySlack('U0ANA'), undefined);
  store.close();
  assert.deepEqual(slack.sent, [{ method: 'ephemeral', channel: 'D0ANA', user: 'U0ANA', text: NOT_ON }]);
});
