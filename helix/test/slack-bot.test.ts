import assert from 'node:assert/strict';
import { mkdtempSync, readFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { test } from 'node:test';
import { hashToken, type Config } from '../src/config.ts';
import { slackBot } from '../src/slack.ts';
import { openStore } from '../src/store.ts';
import type { SlackEvent } from '../src/slack-api.ts';
import { fakeTransport, type Sent } from './fake-slack.ts';

const CONFIG: Config = { host: '127.0.0.1', port: 0, slots: 1, slack: { enabled: true, owner: 'U0OWNER' } };
const NOT_ON = 'You\'re not on this Helix. Ask <@U0OWNER> for an invite.';
const URL = 'https://hooks.slack.com/commands/T0/1/x';

// Protects: criterion 5. Fails when: a stranger's DM or /helix command is acted on, answered where others see it, or leaves anything in helix.db,
// or a command is answered with chat.postEphemeral, which Slack refuses in a channel the bot is not in, so the stranger hears nothing.
for (const [event, reply] of [
  [{ kind: 'message', user: 'U0EVE', channel: 'D0EVE', text: 'hello' }, { method: 'ephemeral', channel: 'D0EVE', user: 'U0EVE', text: NOT_ON }],
  [{ kind: 'command', user: 'U0EVE', channel: 'C0TEAM', text: 'invite <@U0MAL|mal> mal-gh', responseUrl: URL }, { method: 'respond', url: URL, text: NOT_ON }],
  [{ kind: 'command', user: 'U0EVE', channel: 'C0TEAM', text: 'link <@U0EVE|eve> ana', responseUrl: URL }, { method: 'respond', url: URL, text: NOT_ON }],
  [{ kind: 'command', user: 'U0EVE', channel: 'C0TEAM', text: 'notify off', responseUrl: URL }, { method: 'respond', url: URL, text: NOT_ON }],
  [{ kind: 'command', user: 'U0EVE', channel: 'C0TEAM', text: '', responseUrl: URL }, { method: 'respond', url: URL, text: NOT_ON }],
] as [SlackEvent, Sent][]) {
  test(`an unlinked Slack user's ${event.kind} "${event.text}" gets the private not-on-this-Helix reply and nothing is stored`, async () => {
    const db = join(mkdtempSync(join(tmpdir(), 'helix-bot-')), 'helix.db');
    const store = openStore(db);
    store.putPerson('ana', { token_sha256: hashToken('ana-token') });
    store.linkSlack('ana', 'U0ANA');
    const before = readFileSync(db);
    const slack = fakeTransport();
    slackBot(slack.transport, { store, config: CONFIG });

    await slack.deliver(event);
    store.close();

    assert.deepEqual(slack.sent, [reply]);
    assert.deepEqual(readFileSync(db), before);
  });
}
