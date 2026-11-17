import assert from 'node:assert/strict';
import { mkdtempSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { test } from 'node:test';
import { hashToken, type Config } from '../src/config.ts';
import { invite, joinHelix, takeOff, type Verify } from '../src/join.ts';
import { slackBot, slackInvite } from '../src/slack.ts';
import { openStore } from '../src/store.ts';
import { fakeTransport } from './fake-slack.ts';

const CONFIG: Config = { host: '127.0.0.1', port: 0, slots: 1, url: 'https://helix.example.ts.net', owner: 'ajmal', slack: { enabled: true } };
const NOT_ON = 'You\'re not on this Helix. Ask <@U0OWNER> for an invite.';
const URL = 'https://hooks.slack.com/commands/T0/1/x';

/** A Helix with ana on it and ajmal its owner, linked to U0OWNER, and the bot's core listening on a fake transport. */
function helix() {
  process.env.HELIX_HOME = mkdtempSync(join(tmpdir(), 'helix-slack-invite-'));
  const store = openStore(join(process.env.HELIX_HOME, 'helix.db'));
  store.putPerson('ana', { token_sha256: hashToken('ana-token') });
  store.putPerson('ajmal', { token_sha256: hashToken('ajmal-token') });
  store.linkSlack('ajmal', 'U0OWNER');
  const slack = fakeTransport();
  slackBot(slack.transport, { store, config: CONFIG });
  return { store, slack };
}

const works: Verify = async () => ({ findings: [{ what: 'GitHub token', ok: true, detail: 'signs in as alex-gh' }], login: 'alex-gh' });
const TOKENS = { claude_token: 'sk-ant-oat01-alex', github_token: 'github_pat_alex' };

const JOIN_LINE = /^curl -fsSL https:\/\/raw\.githubusercontent\.com\/AKstudios\/animus\/stable\/install\.sh \| bash -s -- join https:\/\/helix\.example\.ts\.net ([a-z0-9-]{19})$/m;

// Protects: criterion 2, the owner's Slack invite. Fails when: no DM goes to the user, it does not say Tailscale first, its line is not the install.sh join, or its code does not let them in as the person named by the mention.
test('the owner\'s /helix invite @user <login> DMs them Tailscale first and one install.sh join line whose code lets them in', async () => {
  const { store, slack } = helix();

  await slack.deliver({ kind: 'command', user: 'U0OWNER', channel: 'C0TEAM', text: 'invite <@U0ALEX|alex> alex-gh', responseUrl: URL });

  assert.deepEqual(slack.sent.slice(0, 1), [{ method: 'dm', user: 'U0ALEX' }]);
  const dm = slack.sent[1] as { method: string; channel: string; text: string };
  assert.equal(dm.channel, 'D-U0ALEX');
  assert.match(dm.text, /Tailscale first/);
  const code = JOIN_LINE.exec(dm.text)?.[1];
  assert.ok(code, dm.text);
  assert.deepEqual(slack.sent.slice(2), [{ method: 'respond', url: URL, text: 'Sent <@U0ALEX> an invite to join as alex with the GitHub login alex-gh.' }]);
  const joined = await joinHelix({ store, verify: works }, { code, ...TOKENS });
  assert.equal(joined.name, 'alex');
  assert.equal(store.personBySlack('U0ALEX'), 'alex');
  store.close();
});

// Protects: criterion 2, the CLI's invite. Fails when: helix invite --slack makes the code but does not DM it, or DMs a line that does not join.
test('helix invite <name> --github --slack DMs that Slack user the join line', async () => {
  const { store, slack } = helix();

  const made = await slackInvite(slack.transport, { store, config: CONFIG }, 'alex', { github: 'alex-gh', slack: 'U123' });

  store.close();
  assert.deepEqual(slack.sent[0], { method: 'dm', user: 'U123' });
  assert.equal(JOIN_LINE.exec((slack.sent[1] as { text: string }).text)?.[1], made.code);
});

// Protects: criterion 2, the refusals. Fails when: an invite without a GitHub login, or one from anyone but the owner, is made or DMed instead of refused privately.
test('a /helix invite without a GitHub login, or from anyone but the owner, is refused privately and nothing is sent', async () => {
  const { store, slack } = helix();
  store.linkSlack('ana', 'U0ANA');

  await slack.deliver({ kind: 'command', user: 'U0OWNER', channel: 'C0TEAM', text: 'invite <@U0ALEX|alex>', responseUrl: URL });
  await slack.deliver({ kind: 'command', user: 'U0ANA', channel: 'C0TEAM', text: 'invite <@U0ALEX|alex> alex-gh', responseUrl: URL });
  await assert.rejects(slackInvite(slack.transport, { store, config: CONFIG }, 'alex', { slack: 'U123' }), /GitHub login/);

  store.close();
  assert.deepEqual(slack.sent, [
    { method: 'respond', url: URL, text: 'An invite sent on Slack names their GitHub login, so only a token that signs in as it is taken: /helix invite @user <github-login>' },
    { method: 'respond', url: URL, text: 'Only <@U0OWNER> invites people to this Helix.' },
  ]);
});

// Protects: criterion 3, joining links. Fails when: the invite's Slack user is lost, or joining does not link it.
test('joining with an invite that carries a Slack user links that user to the person', async () => {
  const { store, slack } = helix();
  const { code } = invite(store, 'alex', { github: 'alex-gh', slack: 'U0ALEX' });

  await joinHelix({ store, verify: works }, { code, ...TOKENS });
  await slack.deliver({ kind: 'command', user: 'U0ALEX', channel: 'D0ALEX', text: 'nonsense', responseUrl: URL });

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

  await slack.deliver({ kind: 'command', user: 'U0ALEX', channel: 'C0TEAM', text: 'link <@U0SAM|sam> ana', responseUrl: URL });
  await slack.deliver({ kind: 'command', user: 'U0OWNER', channel: 'C0TEAM', text: 'link <@U0ANA|ana> nobody', responseUrl: URL });
  await slack.deliver({ kind: 'command', user: 'U0OWNER', channel: 'C0TEAM', text: 'link <@U0ANA|ana> ana', responseUrl: URL });

  assert.equal(store.personBySlack('U0SAM'), undefined);
  assert.equal(store.personBySlack('U0ANA'), 'ana');
  store.close();
  assert.deepEqual(slack.sent, [
    { method: 'respond', url: URL, text: 'Only <@U0OWNER> links Slack users to people on this Helix.' },
    { method: 'respond', url: URL, text: 'Helix has no person named nobody.' },
    { method: 'respond', url: URL, text: 'Linked <@U0ANA> to ana.' },
  ]);
});

// Protects: criterion 3, leaving unlinks. Fails when: a person taken off Helix (animus leave and helix remove-person both take them off with takeOff) keeps their Slack user, which the bot then still treats as on Helix.
test('a person taken off Helix loses their Slack link, and the bot then treats them as a stranger', async () => {
  const { store, slack } = helix();
  store.linkSlack('ana', 'U0ANA');

  takeOff('ana', store, {});
  await slack.deliver({ kind: 'message', user: 'U0ANA', channel: 'D0ANA', text: 'hello' });

  assert.equal(store.personBySlack('U0ANA'), undefined);
  store.close();
  assert.deepEqual(slack.sent, [{ method: 'ephemeral', channel: 'D0ANA', user: 'U0ANA', text: NOT_ON }]);
});

// Protects: the office-network join line. Fails when: a Helix with lan_url DMs only the Tailscale line, or the LAN line's code differs; or one without lan_url gains a second line.
test('with lan_url set, the invite DM also has a join line for the office network with the same code', async () => {
  const { store, slack } = helix();

  const made = await slackInvite(slack.transport, { store, config: { ...CONFIG, lan_url: 'http://helix.local:7420' } }, 'alex', { github: 'alex-gh', slack: 'U123' });
  await slackInvite(slack.transport, { store, config: CONFIG }, 'bea', { github: 'bea-gh', slack: 'U456' });

  store.close();
  const [withLan, without] = [(slack.sent[1] as { text: string }).text, (slack.sent[3] as { text: string }).text];
  assert.equal(JOIN_LINE.exec(withLan)?.[1], made.code);
  assert.match(withLan, new RegExp(`Tailscale off, paste this instead:\\n\`\`\`\\ncurl -fsSL \\S+ \\| bash -s -- join http://helix\\.local:7420 ${made.code}\\n`));
  assert.doesNotMatch(without, /Tailscale off/);
});
