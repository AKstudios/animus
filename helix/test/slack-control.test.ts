import assert from 'node:assert/strict';
import { mkdirSync, mkdtempSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { test } from 'node:test';
import { animusVersion } from '../../plugin/src/version.ts';
import { hashToken, type Config } from '../src/config.ts';
import { helpText, slackBot } from '../src/slack.ts';
import { openStore, type HelixJob } from '../src/store.ts';
import { pauseFile, supervise, type Launch } from '../src/supervisor.ts';
import { fakeTransport, until } from './fake-slack.ts';

const SPEC = (title: string) => `---\nsize: small\n---\n# ${title}\n\n## Acceptance criteria\n\n1. It works.\n`;
const URL = 'https://hooks.slack.com/commands/T0/1/x';

// Stands in for `animus run`: asks until it has an answer, then opens a PR.
const FAKE = `
const [title, answer] = process.argv.slice(1);
console.error('job fake-x: ' + title);
console.log(JSON.stringify(answer ? { outcome: 'pr', pr: 'https://example.test/pr/' + answer } : { outcome: 'needs-input', question: 'which one?' }));
`;

/** A Helix with ana (U0ANA), ben (U0BEN) and ajmal (U0OWNER), the owner, linked, and a real supervisor behind the bot. */
function helix(opts: { slots?: number; paused?: boolean } = {}) {
  const home = mkdtempSync(join(tmpdir(), 'helix-slack-control-'));
  process.env.HELIX_HOME = home;
  mkdirSync(join(home, 'repo'));
  if (opts.paused) writeFileSync(pauseFile(home), '');
  const config: Config = { host: '127.0.0.1', port: 0, slots: opts.slots ?? 2, owner: 'ajmal', slack: { enabled: true } };
  const store = openStore(join(home, 'helix.db'));
  for (const [name, user] of [['ana', 'U0ANA'], ['ben', 'U0BEN'], ['ajmal', 'U0OWNER']] as const) {
    store.putPerson(name, { token_sha256: hashToken(`${name}-token`) });
    store.linkSlack(name, user);
  }
  store.putProject({ name: 'app', url: 'https://github.com/o/app.git', dir: join(home, 'repo'), state: 'ready', added: '' });
  const slack = fakeTransport();
  const launch: Launch = (job) => ({ command: process.execPath, args: ['-e', FAKE, job.title, job.answer ?? ''] });
  const supervisor = supervise({ store, config, home, launch });
  slackBot(slack.transport, { store, config, supervisor });
  const submit = (person: string, title: string) => supervisor.submit(person, { repo: 'app', spec: SPEC(title), name: 'spec.md' });
  const respondedTo = () => slack.sent.filter((s) => s.method === 'respond').map((s) => s.text);
  return { store, config, slack, supervisor, submit, respondedTo, stop: () => { supervisor.stop(); } };
}

const command = (user: string, text: string) => ({ kind: 'command' as const, user, channel: 'C0TEAM', text, responseUrl: URL });

// Protects: criterion 1. Fails when: /helix jobs lists another person's jobs or finished ones, drops the thread or PR link, or answers where others see it.
test('/helix jobs privately lists the sender\'s queued, running and waiting jobs with their links, and no one else\'s', async () => {
  const h = helix();
  const base = { person: 'ana', repo: 'app', spec: '', draft: false, submitted: '' };
  const add = (j: Partial<HelixJob>) => h.store.add({ ...base, state: 'queued', title: 't', ...j });
  const running = add({ state: 'running', title: 'runs' });
  h.store.putSlackThread(running.id, { channel: 'D0ANA', ts: '1.5' });
  const queued = add({ title: 'waits' });
  const asking = add({ state: 'ended', outcome: 'needs-input', title: 'asks', pr: 'https://example.test/pr/1' });
  add({ state: 'ended', outcome: 'pr', title: 'done', pr: 'https://example.test/pr/2' });
  add({ person: 'ben', title: 'bens' });

  await h.slack.deliver(command('U0ANA', 'jobs'));
  h.stop();

  assert.deepEqual(h.respondedTo(), [[
    `Job ${running.id} running: runs (app) https://slack.com/app_redirect?channel=D0ANA&message_ts=1.5`,
    `Job ${queued.id} queued: waits (app)`,
    `Job ${asking.id} needs input: asks (app) https://example.test/pr/1`,
  ].join('\n')]);
});

// Protects: criterion 2. Fails when: slots in use, the queue length or the version is wrong or missing.
test('/helix status privately says the slots in use, the queue length and the version', async () => {
  const h = helix({ slots: 3 });
  const base = { person: 'ben', repo: 'app', spec: '', draft: false, submitted: '', title: 't' };
  h.store.add({ ...base, state: 'running' });
  h.store.add({ ...base, state: 'queued' });
  h.store.add({ ...base, state: 'queued' });

  await h.slack.deliver(command('U0OWNER', 'status'));
  h.stop();

  assert.deepEqual(h.respondedTo(), [`Helix ${animusVersion()}: 1 of 3 slots in use, 2 queued.`]);
});

// Protects: jobs held by after: in /animus status. Fails when: waiting jobs are left out, so two of them read "0 queued".
test('/animus status counts jobs waiting for an earlier pull request apart from the queue', async () => {
  const h = helix({ slots: 3 });
  const base = { person: 'ben', repo: 'app', spec: '', draft: false, submitted: '', title: 't' };
  h.store.add({ ...base, state: 'waiting' });
  h.store.add({ ...base, state: 'waiting' });

  await h.slack.deliver(command('U0OWNER', 'status'));
  h.stop();

  assert.deepEqual(h.respondedTo(), [`Helix ${animusVersion()}: 0 of 3 slots in use, 0 queued, 2 waiting for an earlier pull request.`]);
});

const reply = (user: string, channel: string, thread: string, text: string, mentioned = false) =>
  ({ kind: 'message' as const, user, channel, text, thread, ...(mentioned ? { mentioned: true as const } : {}) });

// Protects: criterion 3. Fails when: a DM reply or a mentioning channel reply does not resume the job, or the thread is not told.
for (const [where, channel, mentioned, text] of [
  ['a DM reply', 'D0ANA', false, 'the second'],
  ['a channel reply that mentions @Helix', 'C0TEAM', true, '<@U0HELIX> the second'],
] as const) {
  test(`${where} in the job's thread answers it, and the thread says so`, async () => {
    const h = helix();
    const job = h.submit('ana', 'ask me');
    await until('the question', () => h.store.get(job.id)?.outcome === 'needs-input', 5000);
    h.store.putSlackThread(job.id, { channel, ts: '9.1' });

    await h.slack.deliver(reply('U0ANA', channel, '9.1', text, mentioned));
    await until('the job to finish', () => h.store.get(job.id)?.pr !== undefined, 5000);
    h.stop();

    assert.equal(h.store.get(job.id)?.pr, 'https://example.test/pr/the second');
    assert.deepEqual(h.slack.sent, [{ method: 'post', channel, thread: '9.1', text: `Got your answer: job ${job.id} resumes.` }]);
  });
}

// Protects: criterion 3, what is ignored. Fails when: someone else's reply, a channel reply without the mention, or a reply outside the thread answers the job.
for (const [why, event] of [
  ['another person\'s reply', reply('U0BEN', 'D0ANA', '9.1', 'mine')],
  ['the owner\'s reply', reply('U0OWNER', 'D0ANA', '9.1', 'mine')],
  ['a channel reply without the mention', reply('U0ANA', 'C0TEAM', '9.1', 'the second')],
  ['a reply outside the job\'s thread', reply('U0ANA', 'D0ANA', '8.8', 'the second')],
] as const) {
  test(`${why} leaves the job waiting`, async () => {
    const h = helix();
    const job = h.submit('ana', 'ask me');
    await until('the question', () => h.store.get(job.id)?.outcome === 'needs-input', 5000);
    h.store.putSlackThread(job.id, { channel: event.channel === 'C0TEAM' ? 'C0TEAM' : 'D0ANA', ts: '9.1' });

    await h.slack.deliver(event);
    h.stop();

    assert.equal(h.store.get(job.id)?.outcome, 'needs-input');
    assert.equal(h.store.get(job.id)?.state, 'ended');
    assert.equal(h.slack.sent.filter((s) => s.method === 'post').length, 0);
  });
}

const press = (user: string, id: number) => ({ kind: 'action' as const, user, channel: 'D0ANA', action: 'cancel_job', value: String(id), responseUrl: URL });

// Protects: criterion 4. Fails when: the job's person or the owner cannot cancel, or anyone else can, or the refusal is public.
for (const [who, user, cancels] of [['the job\'s person', 'U0ANA', true], ['the owner', 'U0OWNER', true], ['someone else', 'U0BEN', false]] as const) {
  test(`${who} pressing Cancel job ${cancels ? 'cancels it' : 'is refused privately'}`, async () => {
    const h = helix({ paused: true });
    const job = h.submit('ana', 'cancel me');
    h.store.putSlackThread(job.id, { channel: 'D0ANA', ts: '9.1' });

    await h.slack.deliver(press(user, job.id));
    h.stop();

    assert.equal(h.store.get(job.id)?.state, cancels ? 'cancelled' : 'queued');
    assert.deepEqual(h.slack.sent, cancels
      ? [{ method: 'post', channel: 'D0ANA', thread: '9.1', text: `Job ${job.id} was cancelled by <@${user}>.` }]
      : [{ method: 'respond', url: URL, text: `Only ana or <@U0OWNER> may cancel job ${job.id}.` }]);
  });
}

const add = (h: ReturnType<typeof helix>, j: Partial<HelixJob>) =>
  h.store.add({ person: 'ana', repo: 'app', spec: '', draft: false, submitted: '', state: 'queued', title: 't', ...j });

// Protects: criterion 1. Fails when: a state's details, or the thread and PR links, are missing.
test('/helix job shows the title, project, person, state and links, and what is particular to its state', async () => {
  const h = helix();
  const waiting = add(h, { title: 'waits', waiting: 'waiting for memory: 1 GB free' });
  const done = add(h, { state: 'ended', outcome: 'pr', title: 'done', pr: 'https://example.test/pr/2' });
  const failed = add(h, { state: 'ended', outcome: 'failed', title: 'broke', reason: 'gates failed' });
  const asking = add(h, { state: 'ended', outcome: 'needs-input', title: 'asks', question: 'which one?' });
  h.store.putSlackThread(done.id, { channel: 'D0ANA', ts: '1.5' });

  for (const j of [waiting, done, failed, asking]) await h.slack.deliver(command('U0ANA', `job #${j.id}`));
  h.stop();

  const [w, d, f, a] = h.respondedTo();
  assert.equal(w, `Job ${waiting.id}: waits\nProject app, person ana\nState: queued\nWaiting: waiting for memory: 1 GB free`);
  assert.equal(d, `Job ${done.id}: done\nProject app, person ana\nState: ended\nOutcome: pr\nPull request: https://example.test/pr/2\nThread: https://slack.com/app_redirect?channel=D0ANA&message_ts=1.5`);
  assert.match(f!, /Outcome: failed\nReason: gates failed/);
  assert.match(a!, /Outcome: needs-input\nQuestion: which one\?/);
});

// Protects: criterion 1, a running job. Fails when: the stage and who is working are missing, or shown from before the job started.
test('/helix job shows a running job\'s stage and who is working, only from progress written since it started', async () => {
  const h = helix();
  const home = h.supervisor.animusHome('ana');
  const running = (animus_job: string, at: string) => {
    mkdirSync(join(home, 'jobs', animus_job), { recursive: true });
    writeFileSync(join(home, 'jobs', animus_job, 'progress.json'), JSON.stringify({ stage: 'review', who: 'the reviewer', at }));
    return add(h, { state: 'running', animus_job, started: '2026-01-01T00:00:10.000Z' });
  };
  const fresh = running('fresh', '2026-01-01T00:00:20.000Z');
  const stale = running('stale', '2026-01-01T00:00:05.000Z');

  await h.slack.deliver(command('U0ANA', `job ${fresh.id}`));
  await h.slack.deliver(command('U0ANA', `job ${stale.id}`));
  h.stop();

  const [shown, hidden] = h.respondedTo();
  assert.match(shown!, /State: running\nStage review, the reviewer working/);
  assert.doesNotMatch(hidden!, /Stage/);
});

// Protects: criterion 2. Fails when: another person's or a missing job is shown to someone not the owner.
test('/helix job says there is no such job for a missing one or another person\'s, and shows the owner any', async () => {
  const h = helix();
  const bens = add(h, { person: 'ben', title: 'secret' });

  await h.slack.deliver(command('U0ANA', `job ${bens.id}`));
  await h.slack.deliver(command('U0ANA', 'job 999'));
  await h.slack.deliver(command('U0OWNER', `job ${bens.id}`));
  h.stop();

  const [other, missing, owners] = h.respondedTo();
  assert.equal(other, `There is no such job of yours: ${bens.id}`);
  assert.equal(missing, 'There is no such job of yours: 999');
  assert.match(owners!, /secret/);
});

// Protects: criteria 3 and 4. Fails when: the command differs from the button, or acts on an ended, missing or non-numeric job.
test('/helix cancel cancels like the button, and refuses others, ended, missing and non-numeric jobs without changing anything', async () => {
  const h = helix({ paused: true });
  const mine = h.submit('ana', 'cancel me');
  h.store.putSlackThread(mine.id, { channel: 'D0ANA', ts: '9.1' });
  const bens = h.submit('ben', 'not yours');
  const ended = add(h, { state: 'ended', outcome: 'pr' });

  await h.slack.deliver(command('U0ANA', `cancel #${mine.id}`));
  await h.slack.deliver(command('U0ANA', `cancel ${bens.id}`));
  await h.slack.deliver(command('U0ANA', `cancel ${ended.id}`));
  await h.slack.deliver(command('U0ANA', 'cancel 999'));
  await h.slack.deliver(command('U0ANA', 'cancel soon'));
  await h.slack.deliver(command('U0OWNER', `cancel ${bens.id}`));
  h.stop();

  assert.equal(h.store.get(mine.id)?.state, 'cancelled');
  assert.equal(h.store.get(bens.id)?.state, 'cancelled');
  assert.equal(h.store.get(ended.id)?.state, 'ended');
  assert.deepEqual(h.slack.sent[0], { method: 'post', channel: 'D0ANA', thread: '9.1', text: `Job ${mine.id} was cancelled by <@U0ANA>.` });
  assert.deepEqual(h.slack.sent.map((s) => 'text' in s ? s.text : ''), [
    `Job ${mine.id} was cancelled by <@U0ANA>.`,
    `Job ${mine.id} was cancelled.`,
    `Only ben or <@U0OWNER> may cancel job ${bens.id}.`,
    `Job ${ended.id} has already ended.`,
    'There is no job 999.',
    'There is no job soon.',
    `Job ${bens.id} was cancelled.`,
  ]);
});

// Fails when: help, an empty command or an unknown one does not list the commands, or shows the owner's commands to someone else.
test('/helix help, an empty command and an unknown one list the commands, the owner\'s only to the owner', async () => {
  const h = helix();
  await h.slack.deliver(command('U0ANA', 'help'));
  await h.slack.deliver(command('U0ANA', ''));
  await h.slack.deliver(command('U0ANA', 'frobnicate'));
  await h.slack.deliver(command('U0OWNER', 'help'));
  h.stop();

  const [help, empty, unknown, owners] = h.respondedTo();
  assert.equal(help, helpText(false));
  assert.deepEqual([empty, unknown], [help, help]);
  for (const c of ['draft', 'jobs', 'job <id>', 'cancel <id>', 'me', 'status', 'project', 'notify', 'help']) assert.match(help!, new RegExp('/animus ' + c));
  assert.doesNotMatch(help!, /invite|\/animus link/);
  assert.match(owners!, /\/animus invite @user <github-login>.*owner only/);
  assert.match(owners!, /\/animus link @user <person>.*owner only/);
  assert.match(help!, /^\*Animus\* turns a written request/);
  assert.doesNotMatch(owners!, /\/helix|@Helix/);
});

// Protects: criterion 3. Fails when: an old Cancel button on a finished job errors in public, or leaves its button on the message.
test('pressing Cancel job on a job that is already over replies privately and removes the button', async () => {
  const h = helix({ paused: true });
  const job = h.submit('ana', 'too late');
  h.store.putSlackThread(job.id, { channel: 'D0ANA', ts: '9.1' });
  h.supervisor.cancel('ana', job.id);

  await h.slack.deliver(press('U0ANA', job.id));
  h.stop();

  const text = `Job ${job.id} was cancelled`;
  assert.deepEqual(h.slack.sent, [
    { method: 'update', channel: 'D0ANA', ts: '9.1', text, blocks: [{ type: 'section', text: { type: 'mrkdwn', text } }] },
    { method: 'respond', url: URL, text: `Job ${job.id} has already ended.` },
  ]);
});

// Protects: criterion 4. Fails when: /helix me omits a part of the profile, lists another person's or more than five ended jobs, links the wrong page, or shows a token hash.
test('/helix me privately shows the sender\'s profile, jobs, last five ended jobs and people pages, and no secret', async () => {
  const h = helix();
  h.config.url = 'http://helix.ts:8080/';
  h.config.lan_url = 'http://helix.lan:8080';
  h.store.putPerson('ana', { token_sha256: hashToken('ana-token'), github: 'anagh', joined: '2026-01-02T03:04:05Z' });
  h.store.setNotify('ana', false);
  const base = { person: 'ana', repo: 'app', spec: '', draft: false, submitted: '' };
  h.store.add({ ...base, state: 'running', title: 'runs' });
  for (let i = 1; i <= 6; i++) h.store.add({ ...base, state: 'ended', outcome: 'pr', title: `done${i}`, pr: `https://example.test/pr/${i}` });
  h.store.add({ ...base, person: 'ben', state: 'ended', outcome: 'pr', title: 'bens', pr: 'https://example.test/pr/ben' });

  await h.slack.deliver(command('U0ANA', 'me'));
  h.stop();

  const [me] = h.respondedTo();
  assert.match(me!, /\*ana\*, GitHub anagh\n/);
  assert.doesNotMatch(me!, /owner/);
  assert.match(me!, /Joined: 2026-01-02T03:04:05Z/);
  assert.match(me!, /Job notifications: off/);
  assert.match(me!, /Projects you may submit to: app/);
  assert.match(me!, /Job \d+ running: runs \(app\)/);
  for (const i of [2, 3, 4, 5, 6]) assert.match(me!, new RegExp(`opened https://example.test/pr/${i}\\b`));
  assert.doesNotMatch(me!, /pr\/1\b|pr\/ben/);
  assert.match(me!, /Tailscale: http:\/\/helix\.ts:8080\/people\/ana/);
  assert.match(me!, /office network: http:\/\/helix\.lan:8080\/people\/ana/);
  assert.doesNotMatch(me!, new RegExp(hashToken('ana-token')));
  assert.match(await (async () => { const o = helix(); await o.slack.deliver(command('U0OWNER', 'me')); o.stop(); return o.respondedTo()[0]!; })(), /\*ajmal\*, the owner/);
});
