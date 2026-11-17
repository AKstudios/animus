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
async function helix() {
  const home = mkdtempSync(join(tmpdir(), 'helix-slack-notify-'));
  process.env.HELIX_HOME = home;
  mkdirSync(join(home, 'repo'));
  const config: Config = { host: '127.0.0.1', port: 0, slots: 1, slack: { enabled: true, owner: 'U0OWNER' } };
  const store = openStore(join(home, 'helix.db'));
  store.putPerson('ana', { token_sha256: hashToken('ana-token') });
  store.putPerson('ben', { token_sha256: hashToken('ben-token') });
  store.linkSlack('ana', 'U0ANA');
  store.putProject({ name: 'app', url: 'https://github.com/o/app.git', dir: join(home, 'repo'), state: 'ready', added: '' });
  const slack = fakeTransport();
  slackBot(slack.transport, { store, config });
  const launch: Launch = (job) => ({ command: process.execPath, args: ['-e', FAKE, job.title, job.answer ?? ''] });
  const supervisor = supervise({ store, config, home, launch, notify: slackNotifier(slack.transport, store) });
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

// Protects: criterion 6, a job submitted with animus submit. Fails when: a linked person's job posts nothing, its PR link is missing, or its posts open a second thread instead of replying in the first.
test('a linked person\'s job from animus submit posts started, then its pull request, in one DM thread', async () => {
  const h = await helix();

  const job = await client.submit({ repo: 'app', spec: SPEC('add login'), name: 'spec.md' });
  await h.settled(job.id, 2);

  h.stop();
  assert.deepEqual(h.slack.sent, [
    { method: 'dm', user: 'U0ANA' },
    { method: 'post', channel: 'D-U0ANA', text: `Job ${job.id} started: add login (app)` },
    { method: 'post', channel: 'D-U0ANA', thread: 'ts-2', text: `Job ${job.id} opened a pull request: https://example.test/pr/add-login` },
  ]);
});

// Protects: criterion 6, needs input and failed, for a job however it reached the supervisor. Fails when: the question or the reason is left out, or an answered job's later posts leave its thread.
test('a job that asks posts its question and, once answered, carries on in its thread; one that fails posts why', async () => {
  const h = await helix();

  const asked = h.supervisor.submit('ana', { repo: 'app', spec: SPEC('ask me'), name: 'spec.md' });
  await h.settled(asked.id, 2);
  h.supervisor.answer('ana', asked.id, 'the second');
  await h.settled(asked.id, 4);
  const failed = h.supervisor.submit('ana', { repo: 'app', spec: SPEC('fail hard'), name: 'spec.md' });
  await h.settled(failed.id, 6);

  h.stop();
  assert.deepEqual(h.posts().map(({ thread, text }) => [thread, text]), [
    [undefined, `Job ${asked.id} started: ask me (app)`],
    ['ts-2', `Job ${asked.id} needs input: which one?\nAnswer it with animus answer ${asked.id} "<your answer>"`],
    ['ts-2', `Job ${asked.id} resumed`],
    ['ts-2', `Job ${asked.id} opened a pull request: https://example.test/pr/ask-me`],
    [undefined, `Job ${failed.id} started: fail hard (app)`],
    ['ts-7', `Job ${failed.id} failed: the gates failed`],
  ]);
});

// Protects: criterion 6, notify off and on. Fails when: /helix notify off does not stop a person's posts, on does not bring them back, or an unlinked person's job posts anywhere.
test('/helix notify off stops a person\'s job posts and /helix notify on starts them again; an unlinked person\'s job posts nothing', async () => {
  const h = await helix();

  await h.slack.deliver({ kind: 'command', user: 'U0ANA', channel: 'D0ANA', text: 'notify off' });
  const quiet = h.supervisor.submit('ana', { repo: 'app', spec: SPEC('quiet'), name: 'spec.md' });
  const bens = h.supervisor.submit('ben', { repo: 'app', spec: SPEC('bens'), name: 'spec.md' });
  await until('both jobs to end', () => h.store.get(bens.id)?.state === 'ended' && h.store.get(quiet.id)?.state === 'ended', 5000);
  await h.slack.deliver({ kind: 'command', user: 'U0ANA', channel: 'D0ANA', text: 'notify on' });
  const loud = h.supervisor.submit('ana', { repo: 'app', spec: SPEC('loud'), name: 'spec.md' });
  await h.settled(loud.id, 2);

  h.stop();
  assert.deepEqual(h.slack.sent.filter((s) => s.method === 'ephemeral'), [
    { method: 'ephemeral', channel: 'D0ANA', user: 'U0ANA', text: 'Job notifications are off. /helix notify on starts them again.' },
    { method: 'ephemeral', channel: 'D0ANA', user: 'U0ANA', text: 'Job notifications are on: each of your jobs posts its progress to a thread in our DM.' },
  ]);
  assert.deepEqual(h.posts().map((p) => p.text), [`Job ${loud.id} started: loud (app)`, `Job ${loud.id} opened a pull request: https://example.test/pr/loud`]);
});
