import assert from 'node:assert/strict';
import { mkdirSync, mkdtempSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { basename, join } from 'node:path';
import { test } from 'node:test';
import { hashToken, type Config } from '../src/config.ts';
import { draftRunner, type DraftLaunch } from '../src/drafts.ts';
import { deviceCode, keepTokens, pollDevice } from '../src/github-app.ts';
import type { SlackEvent } from '../src/slack-api.ts';
import { slackBot } from '../src/slack.ts';
import { openStore } from '../src/store.ts';
import { pauseFile, supervise } from '../src/supervisor.ts';
import { fakeGitHub, type FakeGitHub } from './fake-github.ts';
import { fakeTransport, until, type Sent } from './fake-slack.ts';

const URL = 'https://hooks.slack.com/commands/T0/1/x';

// Stands in for `animus draft <folder>`: writes draft.md from the message it was given, and the reply to revise it with when there is one.
const FAKE = `
const fs = process.getBuiltinModule('fs');
const [folder] = process.argv.slice(1);
const reply = fs.existsSync(folder + '/reply.md') ? '\\nRevised: ' + fs.readFileSync(folder + '/reply.md', 'utf8') : '';
fs.writeFileSync(folder + '/draft.md', '# Draft\\n\\n' + fs.readFileSync(folder + '/message.md', 'utf8') + reply);
`;

/**
 * A Helix with ana (U0ANA) and ben (U0BEN) linked and the projects app, web
 * and api of o, and docs of p, the bot's core with drafts behind it and a
 * paused queue, so a submitted job stays queued. With github, Helix has the
 * app and ana signed in with it as ana-gh. ran: the project each draft session
 * read, by its clone's folder.
 */
async function helix(github?: FakeGitHub, more: Partial<Config> = {}) {
  const home = mkdtempSync(join(tmpdir(), 'helix-slack-draft-'));
  process.env.HELIX_HOME = home;
  const config: Config = { host: '127.0.0.1', port: 0, slots: 1, owner: 'ana', slack: { enabled: true }, ...(github ? { github: { client_id: 'Iv23liGood' } } : {}), ...more };
  const store = openStore(join(home, 'helix.db'));
  const envFile = join(home, 'ana.env');
  writeFileSync(envFile, '');
  store.putPerson('ana', { token_sha256: hashToken('ana-token'), env_file: envFile });
  store.linkSlack('ana', 'U0ANA');
  store.putPerson('ben', { token_sha256: hashToken('ben-token'), env_file: envFile });
  store.linkSlack('ben', 'U0BEN');
  writeFileSync(pauseFile(home), '');
  if (github) {
    const code = await deviceCode('Iv23liGood', github);
    github.approve(code.user_code, 'ana-gh');
    keepTokens('ana', envFile, await pollDevice('Iv23liGood', code, github, async () => {}));
  }
  for (const [owner, name] of [['o', 'app'], ['o', 'web'], ['o', 'api'], ['p', 'docs']] as const) {
    mkdirSync(join(home, name));
    store.putProject({ name, url: `https://github.com/${owner}/${name}.git`, dir: join(home, name), state: 'ready', added: '' });
  }
  const slack = fakeTransport();
  const ran: string[] = [];
  const launch: DraftLaunch = (draft, repoDir) => { ran.push(basename(repoDir)); return { command: process.execPath, args: ['-e', FAKE, draft.folder] }; };
  // No test reaches GitHub or the web: every reference answers 404.
  const fetch = async () => new Response('{}', { status: 404 });
  const drafts = draftRunner(slack.transport, { store, config, home, launch, fetch, ...(github ? { github } : {}) });
  slackBot(slack.transport, { store, config, drafts, supervisor: supervise({ store, config, home }) });
  const uploads = () => slack.sent.filter((s) => s.method === 'upload').length;
  const posted = () => uploads() > 0;
  return { store, slack, ran, posted, uploads, drafts };
}

const command = (text: string): SlackEvent => ({ kind: 'command', user: 'U0ANA', channel: 'C0TEAM', text, responseUrl: URL });
type Post = Extract<Sent, { method: 'post' }>;
type Button = { action_id: string; value: string; text: { text: string } };
const buttons = (p: Post) => (p.blocks?.at(-1) as { elements: Button[] }).elements;

const STARTS: [string, SlackEvent][] = [
  ['/helix draft', command('draft Add a login page')],
  ['@Helix', { kind: 'message', user: 'U0ANA', channel: 'C0TEAM', text: '<@U0HELIX> Add a login page', mentioned: true }],
];

for (const [how, event] of STARTS) {
  // Protects: criterion 1. Fails when: the message does not reach a draft session, or the draft is not posted in a thread as text and as a .md file with Submit and Discard.
  test(`${how} from a linked person drafts a spec and posts it in a thread as text and a .md file, with Submit and Discard`, async () => {
    const h = await helix();
    h.store.setChannelProject('C0TEAM', 'app');

    await h.slack.deliver(event);
    await until('the draft is posted', h.posted);

    const opener = h.slack.sent[0] as Post;
    assert.equal(opener.channel, 'C0TEAM');
    assert.equal(opener.thread, undefined);
    const thread = 'ts-1';
    const draft = h.slack.sent.find((s): s is Post => s.method === 'post' && s.thread === thread && Boolean(s.blocks))!;
    assert.equal(draft.text, '# Draft\n\nAdd a login page\n');
    assert.deepEqual(buttons(draft).map((b) => b.text.text), ['Submit', 'Discard']);
    assert.deepEqual(h.slack.sent.find((s) => s.method === 'upload'), { method: 'upload', channel: 'C0TEAM', thread, filename: 'draft.md', content: '# Draft\n\nAdd a login page\n' });
    assert.equal(h.store.activity('ana')[0]?.kind, 'drafted');
  });
}

const DEFAULTS = [
  { from: 'the linked issue\'s repository, over the channel\'s default', text: 'draft Fix https://github.com/o/api/issues/7', ran: 'api' },
  { from: 'the channel\'s default, set with /helix project', text: 'draft Fix the footer', ran: 'web' },
];

for (const c of DEFAULTS) {
  // Protects: criterion 3. Fails when: a linked issue does not pick its repository's project, or the channel's default is not kept or used.
  test(`a draft's project is ${c.from}`, async () => {
    const h = await helix();

    await h.slack.deliver(command('project web'));
    await h.slack.deliver(command(c.text));
    await until('the draft is posted', h.posted);

    assert.deepEqual(h.ran, [c.ran]);
  });
}

// Protects: criterion 3. Fails when: the list offers a project the GitHub App does not let the person push to, or the one picked is not the one drafted on.
test('with no linked issue and no channel default, the person picks the project from those the GitHub App lets them push to', async () => {
  const github = await fakeGitHub();
  github.installed = { o: ['app', 'web', 'api'], p: ['docs'] };
  github.access = { 'ana-gh': ['o/app', 'o/web', 'p/docs'] };
  github.permissions = { p: { contents: 'read', pull_requests: 'read' } };
  const h = await helix(github);

  await h.slack.deliver(command('draft Fix the footer'));
  await until('the list is posted', () => h.slack.sent.some((s) => s.method === 'post' && Boolean(s.blocks)));
  const list = h.slack.sent.find((s): s is Post => s.method === 'post' && Boolean(s.blocks))!;
  assert.deepEqual(buttons(list).map((b) => b.text.text), ['app', 'web']);
  const web = buttons(list)[1]!;
  await h.slack.deliver({ kind: 'action', user: 'U0ANA', channel: 'C0TEAM', action: web.action_id, value: web.value, responseUrl: URL });
  await until('the draft is posted', h.posted);
  await github.close();

  assert.deepEqual(h.ran, ['web']);
});

/** Starts a draft in a channel whose default project is app, and waits for it to be posted; the draft's post. */
async function posted(h: Awaited<ReturnType<typeof helix>>, channel: string, text: string): Promise<{ post: Post; ts: string }> {
  h.store.setChannelProject(channel, 'app');
  await h.slack.deliver({ ...command(`draft ${text}`), channel });
  await until('the draft is posted', h.posted);
  const at = h.slack.sent.findIndex((s) => s.method === 'post' && Boolean(s.blocks));
  return { post: h.slack.sent[at] as Post, ts: `ts-${at + 1}` };
}

const press = (b: Button): SlackEvent => ({ kind: 'action', user: 'U0ANA', channel: 'C0TEAM', action: b.action_id, value: b.value, responseUrl: URL });

const REVISIONS = [
  { where: 'any reply in a DM', channel: 'D0ANA', text: 'Use email too' },
  { where: 'a reply mentioning @Helix in a channel', channel: 'C0TEAM', text: '<@U0HELIX> Use email too', mentioned: true as const },
];

for (const r of REVISIONS) {
  // Protects: criterion 4. Fails when: a reply does not run the session again with it, or the revised draft is posted beside the old one instead of replacing it.
  test(`${r.where} from the draft's person revises the draft in place`, async () => {
    const h = await helix();
    const { ts } = await posted(h, r.channel, 'Add a login page');
    const firstFile = `F-${h.slack.sent.findIndex((s) => s.method === 'upload') + 1}`;

    await h.slack.deliver({ kind: 'message', user: 'U0ANA', channel: r.channel, text: r.text, thread: 'ts-1', ...(r.mentioned ? { mentioned: r.mentioned } : {}) });
    await until('the revision is posted', () => h.uploads() === 2);

    const revised = '# Draft\n\nAdd a login page\n\nRevised: Use email too\n';
    const update = h.slack.sent.find((s) => s.method === 'update');
    assert.deepEqual(update && { ...update, blocks: undefined }, { method: 'update', channel: r.channel, ts, text: revised, blocks: undefined });
    assert.deepEqual(h.slack.sent.filter((s) => s.method === 'deleteFile'), [{ method: 'deleteFile', file: firstFile }]);
    assert.equal((h.slack.sent.findLast((s) => s.method === 'upload') as { content: string }).content, revised);
  });
}

const IGNORED: [string, SlackEvent][] = [
  ['a channel reply that does not mention @Helix', { kind: 'message', user: 'U0ANA', channel: 'C0TEAM', text: 'Use email too', thread: 'ts-1' }],
  ['someone else\'s reply', { kind: 'message', user: 'U0BEN', channel: 'C0TEAM', text: '<@U0HELIX> Use email too', thread: 'ts-1', mentioned: true }],
];

for (const [what, event] of IGNORED) {
  // Protects: criterion 4's "from its person" and "mentioning @Helix". Fails when: a teammate's reply or channel chatter starts a revision.
  test(`${what} does not revise the draft`, async () => {
    const h = await helix();
    await posted(h, 'C0TEAM', 'Add a login page');

    await h.slack.deliver(event);

    assert.equal(h.store.draft(1)?.state, 'ready');
  });
}

const INCOMPLETE = [
  { missing: 'acceptance criteria', text: 'Add a login page', why: /Acceptance criteria/ },
  { missing: 'a check under a criterion', text: 'Add a login page\n\n## Acceptance criteria\n\n1. A login page.\n   $ npm test\n2. A logout link.\n', why: /criterion 2 has no check/ },
];

for (const c of INCOMPLETE) {
  // Protects: criterion 5's refusal. Fails when: a draft the spec check refuses is queued, or the reason is not said in the thread.
  test(`Submit refuses a draft missing ${c.missing}, in the thread with the reason`, async () => {
    const h = await helix();
    const { post } = await posted(h, 'C0TEAM', c.text);

    await h.slack.deliver(press(buttons(post)[0]!));

    const said = h.slack.sent.findLast((s): s is Post => s.method === 'post' && s.thread === 'ts-1')!;
    assert.match(said.text, c.why);
    assert.deepEqual(h.store.list(), []);
  });
}

// Protects: criterion 5's queueing. Fails when: a complete draft is not queued as its person's job for its project, or the job's progress would not post to the draft's thread.
test('Submit queues a complete draft as the person\'s job, and the thread becomes the job\'s thread', async () => {
  const h = await helix();
  const { post } = await posted(h, 'C0TEAM', 'Add a login page\n\n## Acceptance criteria\n\n1. A login page.\n   $ npm test\n');

  await h.slack.deliver(press(buttons(post)[0]!));

  const [job] = h.store.list();
  assert.deepEqual([job?.person, job?.repo, job?.state, job?.title], ['ana', 'app', 'queued', 'Draft']);
  assert.deepEqual({ ...h.store.slackThread(job!.id) }, { channel: 'C0TEAM', ts: 'ts-1' });
  assert.match((h.slack.sent.at(-1) as Post).text, new RegExp(`job ${job!.id}`, 'i'));
});

// Protects: Discard. Fails when: a discarded draft stays open, or its thread is not told.
test('Discard closes the draft and says so in its thread', async () => {
  const h = await helix();
  const { post } = await posted(h, 'C0TEAM', 'Add a login page');

  await h.slack.deliver(press(buttons(post)[1]!));

  assert.equal(h.store.draft(1)?.state, 'discarded');
  assert.match((h.slack.sent.at(-1) as Post).text, /discarded/i);
});

// Protects: criterion 6's cap. Fails when: a person's fourth open draft starts.
test('a person\'s fourth open draft is refused', async () => {
  const h = await helix();
  h.store.setChannelProject('C0TEAM', 'app');
  for (const n of [1, 2, 3]) await h.slack.deliver(command(`draft Thing ${n}`));

  await h.slack.deliver(command('draft Thing 4'));

  assert.match((h.slack.sent.at(-1) as { text: string }).text, /3 open drafts/);
  assert.equal(h.store.draft(4), undefined);
  await until('the drafts are posted', () => h.uploads() === 3);
});

// Protects: criterion 6's draft_slots and its notice. Fails when: more drafts run than draft_slots, or a waiting draft's thread is not told how many are ahead.
test('a draft waiting for one of draft_slots says in its thread how many are ahead', async () => {
  const h = await helix(undefined, { draft_slots: 1 });
  h.store.setChannelProject('C0TEAM', 'app');
  await h.slack.deliver(command('draft First'));

  await h.slack.deliver(command('draft Second'));

  const second = h.slack.sent.findIndex((s) => s.method === 'post' && s.text.includes('Second'));
  assert.ok(h.slack.sent.some((s) => s.method === 'post' && s.thread === `ts-${second + 1}` && /1 draft is ahead/.test(s.text)));
  await until('both drafts are posted', () => h.uploads() === 2);
});

// Protects: criterion 6's expiry. Fails when: a draft is discarded before 7 days untouched, or kept after, or its thread is not told.
test('a draft untouched for 7 days is discarded with a note in its thread', async () => {
  const h = await helix();
  await posted(h, 'C0TEAM', 'Add a login page');
  const day = 24 * 60 * 60 * 1000;

  await h.drafts.expire(new Date(Date.now() + 6 * day));
  assert.equal(h.store.draft(1)?.state, 'ready');
  await h.drafts.expire(new Date(Date.now() + 8 * day));

  assert.equal(h.store.draft(1)?.state, 'discarded');
  const note = h.slack.sent.at(-1) as Post;
  assert.equal(note.thread, 'ts-1');
  assert.match(note.text, /7 days/);
});
