import assert from 'node:assert/strict';
import { mkdirSync, mkdtempSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { dirname, join } from 'node:path';
import { test } from 'node:test';
import type { Config } from '../src/config.ts';
import { slackEnvFile, type SlackEvent } from '../src/slack-api.ts';
import { startSlack } from '../src/slack-socket.ts';
import { slackBot } from '../src/slack.ts';
import { openStore } from '../src/store.ts';
import { fakeSlack, until } from './fake-slack.ts';

const ON: Config = { host: '127.0.0.1', port: 0, slots: 1, slack: { enabled: true } };

function home() {
  process.env.HELIX_HOME = mkdtempSync(join(tmpdir(), 'helix-socket-'));
  mkdirSync(dirname(slackEnvFile()), { recursive: true });
  writeFileSync(slackEnvFile(), 'SLACK_BOT_TOKEN=xoxb-good\nSLACK_APP_TOKEN=xapp-good\n', { mode: 0o600 });
}

const URL = 'https://hooks.slack.com/commands/T0/1/x';
const command = (id: string, text: string, url = URL) => ({ envelope_id: id, type: 'slash_commands', accepts_response_payload: true, payload: { command: '/helix', text, user_id: 'U0ALEX', channel_id: 'D0ALEX', response_url: url } });
const acks = (slack: { received: Record<string, unknown>[] }) => slack.received.map((m) => m.envelope_id);

// Protects: criterion 7, off means off. Fails when: serve opens a Slack connection the owner did not turn on.
for (const [what, slack] of [['no slack key', undefined], ['slack.enabled false', { enabled: false }]] as const) {
  test(`with ${what} in config.yaml, Helix opens no connection to Slack`, async () => {
    home();
    const fake = await fakeSlack();
    const bot = startSlack({ ...ON, ...(slack ? { slack } : { slack: undefined }) }, { api: fake.api, say: () => {} });
    await new Promise((r) => setTimeout(r, 100));
    await fake.close();
    assert.equal(bot, undefined);
    assert.deepEqual(fake.calls, []);
    assert.equal(fake.connections(), 0);
  });
}

// Protects: criterion 7, every envelope acked at once and its event handed on. Fails when: the ack waits for the work (Slack shows the user an error after 3 s), or an event is lost or mangled.
test('with Slack on, the bot connects with the app token, acks each envelope before its work is done, and hands the events on', async () => {
  home();
  const fake = await fakeSlack();
  const bot = startSlack(ON, { api: fake.api, say: () => {} })!;
  const events: SlackEvent[] = [];
  // Work that never ends: the ack must not wait for it.
  bot.onEvent((event) => { events.push(event); return new Promise(() => {}); });
  await until('a socket', () => fake.connections() === 1);

  fake.send(command('e1', 'invite <@U0SAM|sam> sam-gh'));
  fake.send({ envelope_id: 'e2', type: 'events_api', payload: { event: { type: 'message', channel_type: 'im', user: 'U0ALEX', channel: 'D0ALEX', text: 'hello' } } });
  // The bot's own post in the DM comes back as an event too; answering it would never end.
  fake.send({ envelope_id: 'e3', type: 'events_api', payload: { event: { type: 'message', channel_type: 'im', user: 'U0BOT', bot_id: 'B0BOT', channel: 'D0ALEX', text: 'started' } } });
  await until('three acks', () => fake.received.length === 3);
  bot.close();
  await fake.close();

  assert.deepEqual(fake.calls, ['apps.connections.open xapp-good']);
  assert.deepEqual(acks(fake), ['e1', 'e2', 'e3']);
  assert.deepEqual(events, [
    { kind: 'command', user: 'U0ALEX', channel: 'D0ALEX', text: 'invite <@U0SAM|sam> sam-gh', responseUrl: URL },
    { kind: 'message', user: 'U0ALEX', channel: 'D0ALEX', text: 'hello' },
  ]);
});

// Protects: criteria 3 and 4 of the control spec, what a thread reply, an @Helix mention and a button press become. Fails when: thread_ts is dropped, a mention is not marked, or a button press is not an action.
test('a threaded DM, an app mention and a Cancel job press reach the bot as events', async () => {
  home();
  const fake = await fakeSlack();
  const bot = startSlack(ON, { api: fake.api, say: () => {} })!;
  const events: SlackEvent[] = [];
  bot.onEvent(async (event) => { events.push(event); });
  await until('a socket', () => fake.connections() === 1);

  fake.send({ envelope_id: 'e1', type: 'events_api', payload: { event: { type: 'message', channel_type: 'im', user: 'U0ANA', channel: 'D0ANA', text: 'the second', thread_ts: '9.1' } } });
  fake.send({ envelope_id: 'e2', type: 'events_api', payload: { event: { type: 'app_mention', user: 'U0ANA', channel: 'C0TEAM', text: '<@U0HELIX> the first', thread_ts: '9.2' } } });
  fake.send({ envelope_id: 'e3', type: 'interactive', payload: { type: 'block_actions', user: { id: 'U0ANA' }, channel: { id: 'D0ANA' }, response_url: URL, actions: [{ action_id: 'cancel_job', value: '7' }] } });
  await until('three events', () => events.length === 3);
  bot.close();
  await fake.close();

  assert.deepEqual(events, [
    { kind: 'message', user: 'U0ANA', channel: 'D0ANA', text: 'the second', thread: '9.1' },
    { kind: 'message', user: 'U0ANA', channel: 'C0TEAM', text: '<@U0HELIX> the first', mentioned: true, thread: '9.2' },
    { kind: 'action', user: 'U0ANA', channel: 'D0ANA', action: 'cancel_job', value: '7', responseUrl: URL },
  ]);
});

// Protects: criterion 7, the bot survives Slack ending its socket. Fails when: a dropped or refreshed socket leaves Helix deaf to Slack until a restart.
for (const [what, end] of [
  ['drops the socket', (fake: Awaited<ReturnType<typeof fakeSlack>>) => fake.drop()],
  ['asks for a refresh', (fake: Awaited<ReturnType<typeof fakeSlack>>) => fake.send({ type: 'disconnect', reason: 'refresh_requested' })],
] as const) {
  test(`when Slack ${what}, the bot opens a new socket and goes on acking`, async () => {
    home();
    const fake = await fakeSlack();
    const bot = startSlack(ON, { api: fake.api, say: () => {} })!;
    const events: SlackEvent[] = [];
    bot.onEvent(async (event) => { events.push(event); });
    await until('a socket', () => fake.connections() === 1);

    end(fake);
    await until('a second socket', () => fake.connections() === 2);
    fake.send(command('after', 'notify off'));
    await until('the ack', () => acks(fake).includes('after'));
    bot.close();
    await fake.close();

    assert.deepEqual(fake.calls, ['apps.connections.open xapp-good', 'apps.connections.open xapp-good']);
    assert.deepEqual(events, [{ kind: 'command', user: 'U0ALEX', channel: 'D0ALEX', text: 'notify off', responseUrl: URL }]);
  });
}

// Protects: criteria 2 and 5, a command's reply reaches its sender wherever they sent it. Fails when: the reply goes out as chat.postEphemeral,
// which Slack refuses in a DM between two people or a channel the bot is not in, so the sender hears nothing.
test('a /helix command is answered privately at its response_url, not with chat.postEphemeral', async (t) => {
  home();
  const fake = await fakeSlack();
  const store = openStore(join(process.env.HELIX_HOME!, 'helix.db'));
  const bot = startSlack(ON, { api: fake.api, say: () => {} })!;
  t.after(async () => { bot.close(); store.close(); await fake.close(); });
  slackBot(bot, { store, config: ON });
  await until('a socket', () => fake.connections() === 1);

  fake.send(command('e1', 'notify off', fake.responseUrl));
  // A reply at the response_url, or a Web API call besides the connect.
  await until('a reply', () => fake.responses.length + fake.calls.length > 1);

  assert.deepEqual(fake.responses, [{ response_type: 'ephemeral', text: 'You\'re not on this Helix. Ask the owner for an invite.' }]);
  assert.deepEqual(fake.calls, ['apps.connections.open xapp-good']);
});
