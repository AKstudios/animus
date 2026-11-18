import assert from 'node:assert/strict';
import { mkdirSync, mkdtempSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { test } from 'node:test';
import { hashToken, type Config } from '../src/config.ts';
import { draftRunner, type DraftLaunch } from '../src/drafts.ts';
import { commentWatcher, MARKER } from '../src/github-comments.ts';
import { deviceCode, keepTokens, pollDevice } from '../src/github-app.ts';
import { openStore } from '../src/store.ts';
import { pauseFile } from '../src/supervisor.ts';
import { fakeGitHub, type FakeGitHub } from './fake-github.ts';
import { until } from './fake-slack.ts';

// Stands in for `animus draft <folder>`: draft.md is the message, the issue fetched as a reference, and the reply when revising.
const FAKE = `
const fs = process.getBuiltinModule('fs');
const [folder] = process.argv.slice(1);
const read = (f) => fs.existsSync(f) ? fs.readFileSync(f, 'utf8') : '';
const refs = fs.existsSync(folder + '/references') ? fs.readdirSync(folder + '/references').sort().map((f) => read(folder + '/references/' + f)).join('\\n') : '';
const reply = fs.existsSync(folder + '/reply.md') ? '\\nRevised: ' + read(folder + '/reply.md') : '';
fs.writeFileSync(folder + '/draft.md', '# Draft\\n\\n' + read(folder + '/message.md') + '\\nIssue: ' + refs + reply);
`;

const T0 = Date.parse('2030-01-01T10:00:00Z');
const at = (seconds: number) => new Date(T0 + seconds * 1000).toISOString().replace('.000Z', 'Z');
const HOUR = 3600;

/**
 * A Helix with ana (GitHub login ana-gh, signed in through the app) and the
 * project app of o. The comment watcher's clock is T0 and moves with
 * clock.at; the first poll starts watching at T0. Issue 7 on o/app is open,
 * 8 is a pull request.
 */
async function helix() {
  const home = mkdtempSync(join(tmpdir(), 'helix-github-comments-'));
  process.env.HELIX_HOME = home;
  const github: FakeGitHub = await fakeGitHub();
  const config: Config = { host: '127.0.0.1', port: 0, slots: 1, owner: 'ana', github: { client_id: 'Iv23liGood' } };
  const store = openStore(join(home, 'helix.db'));
  const envFile = join(home, 'ana.env');
  writeFileSync(envFile, '');
  store.putPerson('ana', { token_sha256: hashToken('ana-token'), env_file: envFile, github: 'ana-gh' });
  writeFileSync(pauseFile(home), '');
  const code = await deviceCode('Iv23liGood', github);
  github.approve(code.user_code, 'ana-gh');
  keepTokens('ana', envFile, await pollDevice('Iv23liGood', code, github, async () => {}));
  mkdirSync(join(home, 'app'));
  store.putProject({ name: 'app', url: 'https://github.com/o/app.git', dir: join(home, 'app'), state: 'ready', added: '', added_by: 'ana' });
  github.addIssue('o/app', 7, { title: 'Login', body: 'Users cannot sign in with a passkey' });
  github.addIssue('o/app', 8, { title: 'Fix login', body: 'A pull request', pull: true });
  github.addIssue('o/other', 1, { title: 'Not a project', body: 'x' });
  let clock = T0;
  const launch: DraftLaunch = (draft) => ({ command: process.execPath, args: ['-e', FAKE, draft.folder] });
  const drafts = draftRunner(undefined, { store, config, home, launch, github });
  const lines: string[] = [];
  const watcher = commentWatcher({ store, config, drafts, github, now: () => clock, say: (l) => lines.push(l) });
  await watcher.poll();
  return { github, store, lines, poll: () => watcher.poll(), clock: { at: (s: number) => { clock = T0 + s * 1000; } } };
}

// Protects: criterion 1. Fails when: the person gets no 👀, or the draft is not a marked comment with the spec in a markdown fence and the replies.
test('answers a person\'s /animus comment with 👀 and a draft comment written from the issue and the comment', async () => {
  const h = await helix();
  h.github.addComment('o/app', 7, 'ana-gh', '/animus add passkey sign-in', at(30));

  await h.poll();
  await until('the draft comment', () => h.github.posted.length > 0);

  assert.deepEqual(h.github.reactions, [{ repo: 'o/app', comment: 1, login: 'ana-gh', content: 'eyes' }]);
  const [post] = h.github.posted;
  assert.equal(post!.login, 'ana-gh');
  assert.equal(post!.number, 7);
  assert.match(post!.body, /^Animus drafted this spec/);
  assert.match(post!.body, /```markdown\n# Draft\n\nadd passkey sign-in\n/);
  assert.match(post!.body, /Users cannot sign in with a passkey/);
  assert.match(post!.body, /`\/animus submit`/);
  assert.match(post!.body, /`\/animus discard`/);
  assert.ok(post!.body.endsWith(MARKER));
  assert.equal(h.store.draftsIn('ready').length + h.store.draftsIn('queued').length + h.store.draftsIn('running').length, 1);
});

const IGNORED = [
  { why: 'its author is not a person on this Helix', login: 'stranger', repo: 'o/app', body: '/animus add passkeys', created: 30 },
  { why: 'Animus posted it', login: 'ana-gh', repo: 'o/app', body: `/animus add passkeys\n\n${MARKER}`, created: 30 },
  { why: 'its repository is not a project', login: 'ana-gh', repo: 'o/other', body: '/animus add passkeys', created: 30 },
  { why: 'it was written before Helix started watching, though edited since', login: 'ana-gh', repo: 'o/app', body: '/animus add passkeys', created: -HOUR },
];

for (const c of IGNORED) {
  // Protects: criterion 2. Fails when: Helix reacts to or answers a comment it must not act on.
  test(`posts nothing and adds no reaction when ${c.why}`, async () => {
    const h = await helix();
    const id = h.github.addComment(c.repo, c.repo === 'o/app' ? 7 : 1, c.login, c.body, at(c.created));
    h.github.edit(id, at(60));

    await h.poll();
    await new Promise((r) => setTimeout(r, 100));

    assert.deepEqual(h.github.posted, []);
    assert.deepEqual(h.github.reactions, []);
    assert.deepEqual(h.store.draftsIn('queued').concat(h.store.draftsIn('running'), h.store.draftsIn('ready')), []);
  });
}

// Protects: criterion 2. Fails when: a comment already handled, then edited, is acted on again.
test('does not act again on a comment it handled, edited since', async () => {
  const h = await helix();
  const id = h.github.addComment('o/app', 7, 'ana-gh', '/animus add passkey sign-in', at(30));
  await h.poll();
  await until('the draft comment', () => h.github.posted.length === 1);

  h.github.edit(id, at(120));
  await h.poll();
  await new Promise((r) => setTimeout(r, 100));

  assert.equal(h.github.reactions.length, 1);
  assert.equal(h.github.posted.length, 1);
});

// Protects: criterion 3. Fails when: a comment first seen over a day after it was written starts a draft.
test('replies that a /animus comment first seen more than a day old is too old to act on, and starts no draft', async () => {
  const h = await helix();
  h.github.addComment('o/app', 7, 'ana-gh', '/animus add passkey sign-in', at(30));
  h.clock.at(25 * HOUR);

  await h.poll();

  assert.equal(h.github.posted.length, 1);
  assert.match(h.github.posted[0]!.body, /too old to act on/);
  assert.deepEqual(h.github.reactions, []);
  assert.deepEqual(h.store.draftsIn('queued').concat(h.store.draftsIn('running'), h.store.draftsIn('ready')), []);
});

// Protects: criterion 4. Fails when: a second /animus on the issue starts a second draft or edits the first comment instead of posting a new one.
test('posts the revised draft as a new comment when the author has an open draft', async () => {
  const h = await helix();
  h.github.addComment('o/app', 7, 'ana-gh', '/animus add passkey sign-in', at(30));
  await h.poll();
  await until('the first draft', () => h.store.draftsIn('ready').length === 1 && h.github.posted.length === 1);

  h.github.addComment('o/app', 7, 'ana-gh', '/animus also support recovery codes', at(90));
  h.clock.at(120);
  await h.poll();
  await until('the revised draft', () => h.github.posted.length === 2);

  assert.match(h.github.posted[1]!.body, /Revised: also support recovery codes/);
  assert.equal(h.store.draftsIn('ready').length, 1);
  assert.equal(h.store.draftsIn('queued').length + h.store.draftsIn('running').length, 0);
});

// Protects: criterion 10. Fails when: /animus on a pull request starts a draft or is left unanswered.
test('replies that fix on pull requests is not available yet, and starts nothing', async () => {
  const h = await helix();
  h.github.addComment('o/app', 8, 'ana-gh', '/animus fix the failing test', at(30));

  await h.poll();

  assert.equal(h.github.posted.length, 1);
  assert.equal(h.github.posted[0]!.number, 8);
  assert.match(h.github.posted[0]!.body, /`fix` on pull requests is not available yet/);
  assert.deepEqual(h.github.reactions, []);
  assert.deepEqual(h.store.draftsIn('queued').concat(h.store.draftsIn('running'), h.store.draftsIn('ready')), []);
});
