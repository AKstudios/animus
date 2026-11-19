import assert from 'node:assert/strict';
import { mkdirSync, mkdtempSync } from 'node:fs';
import type { AddressInfo } from 'node:net';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { test } from 'node:test';
import * as client from '../../plugin/src/remote.ts';
import { hashToken, type Config } from '../src/config.ts';
import { serve } from '../src/server.ts';
import { slackBot, slackNotifier } from '../src/slack.ts';
import { openStore } from '../src/store.ts';
import { supervise, type Launch } from '../src/supervisor.ts';
import { fakeTransport, until, type Sent } from './fake-slack.ts';

const SPEC = (title: string) => `---\nsize: small\n---\n# ${title}\n\n## Acceptance criteria\n\n1. It works.\n`;

// Stands in for `animus run`: a title starting "ask" asks until answered, "fail" fails, anything else opens a PR.
const FAKE = `
const [title, answer] = process.argv.slice(1);
console.error('job fake-' + title.replace(/ /g, '-') + ': ' + title);
const r = title.startsWith('ask') && !answer ? { outcome: 'needs-input', question: 'which one?' }
  : title.startsWith('fail') ? { outcome: 'failed', reason: 'the gates failed' }
  : { outcome: 'pr', pr: 'https://example.test/pr/' + title.replace(/ /g, '-') };
console.log(JSON.stringify(r));
`;

/** A Helix with ana linked to U0ANA and ben unlinked, its jobs' progress going to a fake Slack. */
async function helix(links: Pick<Config, 'url' | 'lan_url'> = {}) {
  const home = mkdtempSync(join(tmpdir(), 'helix-slack-notify-'));
  process.env.HELIX_HOME = home;
  mkdirSync(join(home, 'repo'));
  const config: Config = { host: '127.0.0.1', port: 0, slots: 1, slack: { enabled: true }, ...links };
  const store = openStore(join(home, 'helix.db'));
  store.putPerson('ana', { token_sha256: hashToken('ana-token') });
  store.putPerson('ben', { token_sha256: hashToken('ben-token') });
  store.linkSlack('ana', 'U0ANA');
  store.putProject({ name: 'app', url: 'https://github.com/o/app.git', dir: join(home, 'repo'), state: 'ready', added: '' });
  const slack = fakeTransport();
  slackBot(slack.transport, { store, config });
  const launch: Launch = (job) => ({ command: process.execPath, args: ['-e', FAKE, job.title, job.answer ?? ''] });
  const supervisor = supervise({ store, config, home, launch, notify: slackNotifier(slack.transport, store, undefined, config) });
  const server = serve({ config, store, supervisor });
  await new Promise<void>((r) => { server.listen(0, '127.0.0.1', r); });
  process.env.HELIX_URL = `http://127.0.0.1:${(server.address() as AddressInfo).port}`;
  process.env.HELIX_TOKEN = 'ana-token';
  const posts = () => slack.sent.filter((s): s is Extract<Sent, { method: 'post' }> => s.method === 'post');
  const settled = async (id: number, n: number) => {
    await until(`job ${id} to end`, () => store.get(id)?.state === 'ended', 5000);
    await until(`${n} posts`, () => posts().length >= n);
  };
  const stop = () => { supervisor.stop(); server.close(); store.close(); };
  return { store, slack, supervisor, posts, settled, stop };
}

const flat = (x: unknown) => JSON.stringify(x);
const EMOJI = /\p{Extended_Pictographic}|:[a-z0-9_+-]+:/u;
const buttons = (blocks?: unknown[]) => (blocks as { type: string }[]).filter((b) => b.type === 'actions').length;

// Protects: criteria 1, 2 and 6, a job from animus submit. Fails when: the start is also a reply, the card lacks its parts, the end repeats the card, or anything holds an emoji.
test('a job from animus submit opens its DM thread with a card, updated to Pull request opened with one reply that differs from it', async () => {
  const h = await helix({ url: 'https://helix.tail.ts.net/', lan_url: 'http://10.0.0.5:7777' });

  const job = await client.submit({ repo: 'app', spec: SPEC('add login'), name: 'spec.md' });
  await h.settled(job.id, 2);
  await until('the card update', () => updates(h).length >= 1);

  h.stop();
  const [dm, card, update, reply] = h.slack.sent as Extract<Sent, { method: 'post' | 'update' }>[];
  assert.deepEqual(dm, { method: 'dm', user: 'U0ANA' } as never);
  assert.equal(card!.method, 'post');
  assert.equal((card as { thread?: string }).thread, undefined);
  assert.equal(card!.text, `Job ${job.id}: add login, Running`);
  assert.deepEqual((card!.blocks as { type: string; text?: { text: string } }[]).slice(0, 2).map((b) => b.type), ['header', 'context']);
  assert.equal((card!.blocks![0] as { text: { text: string } }).text.text, 'add login');
  assert.match(flat(card!.blocks), new RegExp(`Project app, job ${job.id}`));
  assert.match(flat(card!.blocks), /State:\* Running/);
  assert.match(flat(card!.blocks), new RegExp(`<https://helix.tail.ts.net/jobs/${job.id}\\|Tailscale>`));
  assert.match(flat(card!.blocks), new RegExp(`<http://10.0.0.5:7777/jobs/${job.id}\\|office network>`));
  assert.equal(buttons(card!.blocks), 1);
  assert.equal(h.posts().length, 2);
  assert.equal(reply!.method, 'post');
  assert.equal((reply as { thread?: string }).thread, 'ts-2');
  assert.match(reply!.text, /https:\/\/example.test\/pr\/add-login/);
  assert.equal(update!.method, 'update');
  assert.match(flat(update!.blocks), /State:\* Pull request opened/);
  assert.match(flat(update!.blocks), /example.test\/pr\/add-login/);
  assert.equal(buttons(update!.blocks), 0);
  assert.notEqual(reply!.text, update!.text);
  assert.notDeepEqual(reply!.blocks, update!.blocks);
  assert.doesNotMatch(flat(h.slack.sent), EMOJI);
});

// Protects: criterion 3. Fails when: the question is on the card, is not a quote, the answer is announced twice, or a failure's reason is not set apart.
test('a job that asks quotes its question in a reply, not on the card, and once answered the card is Running again; a failure replies with its reason apart', async () => {
  const h = await helix();

  const asked = h.supervisor.submit('ana', { repo: 'app', spec: SPEC('ask me'), name: 'spec.md' });
  await h.settled(asked.id, 2);
  await until('the needs-input update', () => updates(h).length >= 1);
  h.supervisor.answer('ana', asked.id, 'the second');
  await h.settled(asked.id, 3);
  await until('three updates', () => updates(h).length >= 3);
  const failed = h.supervisor.submit('ana', { repo: 'app', spec: SPEC('fail hard'), name: 'spec.md' });
  await h.settled(failed.id, 5);
  await until('the failure card', () => updates(h).length >= 4);

  h.stop();
  const [, ask, , ...rest] = h.posts();
  assert.match(ask!.text, /> which one\?/);
  assert.match(ask!.text, new RegExp(`animus answer ${asked.id}`));
  assert.match(ask!.text, /Reply in this thread/);
  assert.doesNotMatch(flat(updates(h)[0]!.blocks), /which one/);
  assert.match(flat(updates(h)[0]!.blocks), /State:\* Needs input/);
  assert.deepEqual(updates(h).slice(0, 3).map((u) => [/Running/.test(flat(u.blocks)), buttons(u.blocks)]), [[false, 0], [true, 1], [false, 0]]);
  // The resume posts no reply of its own: the thread holds the card, the question, then the pull request.
  assert.equal(h.posts().filter((p) => p.thread === 'ts-2').length, 2);
  const reason = h.posts().find((p) => /failed/.test(p.text))!;
  assert.match(reason.text, /```the gates failed```/);
  assert.match(flat(updates(h).at(-1)!.blocks), /State:\* Failed/);
  assert.doesNotMatch(flat(updates(h).at(-1)!.blocks), /gates failed/);
  assert.equal(rest.length, 2);
  assert.doesNotMatch(flat(h.slack.sent), EMOJI);
});

// Protects: notify off and on. Fails when: /helix notify off does not stop a person's posts, on does not bring them back, or an unlinked person's job posts anywhere.
test('/helix notify off stops a person\'s job posts and /helix notify on starts them again; an unlinked person\'s job posts nothing', async () => {
  const h = await helix();

  await h.slack.deliver({ kind: 'command', user: 'U0ANA', channel: 'D0ANA', text: 'notify off', responseUrl: 'https://hooks.slack.com/commands/T0/1/x' });
  const quiet = h.supervisor.submit('ana', { repo: 'app', spec: SPEC('quiet'), name: 'spec.md' });
  const bens = h.supervisor.submit('ben', { repo: 'app', spec: SPEC('bens'), name: 'spec.md' });
  await until('both jobs to end', () => h.store.get(bens.id)?.state === 'ended' && h.store.get(quiet.id)?.state === 'ended', 5000);
  await h.slack.deliver({ kind: 'command', user: 'U0ANA', channel: 'D0ANA', text: 'notify on', responseUrl: 'https://hooks.slack.com/commands/T0/1/y' });
  const loud = h.supervisor.submit('ana', { repo: 'app', spec: SPEC('loud'), name: 'spec.md' });
  await h.settled(loud.id, 2);

  h.stop();
  assert.deepEqual(h.slack.sent.filter((s) => s.method === 'respond'), [
    { method: 'respond', url: 'https://hooks.slack.com/commands/T0/1/x', text: 'Job notifications are off. /animus notify on starts them again.' },
    { method: 'respond', url: 'https://hooks.slack.com/commands/T0/1/y', text: 'Job notifications are on: each of your jobs posts its progress to a thread in our DM.' },
  ]);
  assert.deepEqual(h.posts().map((p) => p.text), [`Job ${loud.id}: loud, Running`, `Job ${loud.id} opened a pull request: <https://example.test/pr/loud|Open pull request>`]);
});

const updates = (h: Awaited<ReturnType<typeof helix>>) => h.slack.sent.filter((s): s is Extract<Sent, { method: 'update' }> => s.method === 'update');

// Protects: criterion 4, a cancel with no thread reply from the notifier. Fails when: a cancelled job's card keeps its button or says anything but Cancelled, or the notifier adds a reply of its own.
test('with no address set the card has no job page; cancelling a running job updates the card to Cancelled without the button and replies nothing', async () => {
  const h = await helix();

  const job = h.supervisor.submit('ana', { repo: 'app', spec: SPEC('ask me'), name: 'spec.md' });
  await until('the start post', () => h.posts().length >= 1);
  await until('the thread', () => h.store.slackThread(job.id) !== undefined);
  h.store.save({ ...h.store.get(job.id)!, state: 'running', ended: undefined, outcome: undefined });
  h.supervisor.cancel('ana', job.id);
  await until('the cancel update', () => updates(h).some((u) => /Cancelled/.test(flat(u.blocks))));

  h.stop();
  assert.doesNotMatch(flat(h.posts()[0]!.blocks), /Job page/);
  assert.equal(buttons(updates(h).at(-1)!.blocks), 0);
  assert.equal(updates(h).at(-1)!.text, `Job ${job.id}: ask me, Cancelled`);
  assert.equal(h.posts().filter((p) => /cancel/i.test(p.text) && p.thread).length, 0);
});
