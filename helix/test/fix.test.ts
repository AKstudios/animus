import assert from 'node:assert/strict';
import { mkdirSync, mkdtempSync, writeFileSync } from 'node:fs';
import type { AddressInfo } from 'node:net';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { test } from 'node:test';
import { jobView } from '../../plugin/display/job-view.ts';
import * as client from '../../plugin/src/remote.ts';
import { hashToken, type Config } from '../src/config.ts';
import { deviceCode, keepTokens, pollDevice } from '../src/github-app.ts';
import { serve } from '../src/server.ts';
import { openStore } from '../src/store.ts';
import { animusArgs, supervise, type Launch } from '../src/supervisor.ts';
import { ANIMUS_BODY, fakeGitHub } from './fake-github.ts';

const PR = 'https://github.com/o/app/pull/4';
const PR_5 = 'https://github.com/o/app/pull/5';

// Stands in for `animus fix`: says its job id, then ends as a fix that updated the pull request; an ask of "x" keeps running until Helix stops it.
const FAKE = `console.error('job fake-fix: fix'); if (process.argv[2] === 'x') setInterval(() => {}, 1000); else console.log(JSON.stringify({ outcome: 'pr', pr: process.argv[1] }));`;

/**
 * A Helix with ana, ben and olly (the owner), each signed in to GitHub as <name>-gh, and the project app of o.
 * On GitHub: pull request 4, by ana-gh, which ana's Helix job 1 opened; 5, an Animus one by ben-gh that no job on Helix
 * opened; 6, by ana-gh by hand (no spec block); 7, an Animus one by someone not on Helix.
 */
async function helix() {
  const home = mkdtempSync(join(tmpdir(), 'helix-fix-'));
  process.env.HELIX_HOME = home;
  const repo = join(home, 'repo');
  mkdirSync(repo, { recursive: true });
  const github = await fakeGitHub();
  const config: Config = { host: '127.0.0.1', port: 0, slots: 1, owner: 'olly', github: { client_id: 'Iv23liGood' } };
  const argsSeen: string[][] = [];
  const launch: Launch = (job, dir) => { argsSeen.push(animusArgs(job, dir)); return { command: process.execPath, args: ['-e', FAKE, job.pr ?? '', job.ask ?? ''] }; };
  const store = openStore(join(home, 'helix.db'));
  for (const who of ['ana', 'ben', 'olly']) {
    const envFile = join(home, `${who}.env`);
    writeFileSync(envFile, '');
    store.putPerson(who, { token_sha256: hashToken(`${who}-token`), env_file: envFile, github: `${who}-gh` });
    const code = await deviceCode('Iv23liGood', github);
    github.approve(code.user_code, `${who}-gh`);
    keepTokens(who, envFile, await pollDevice('Iv23liGood', code, github, async () => {}));
  }
  store.putProject({ name: 'app', url: 'https://github.com/o/app.git', dir: repo, state: 'ready', added: '' });
  github.addIssue('o/app', 4, { title: 'Add a button', body: ANIMUS_BODY, pull: true, author: 'ana-gh' });
  github.addIssue('o/app', 5, { title: 'Add a list', body: ANIMUS_BODY, pull: true, author: 'ben-gh' });
  github.addIssue('o/app', 6, { title: 'By hand', body: 'A change made by hand', pull: true, author: 'ana-gh' });
  github.addIssue('o/app', 7, { title: 'Add a menu', body: ANIMUS_BODY, pull: true, author: 'stranger-gh' });
  store.add({ state: 'ended', person: 'ana', repo: 'app', spec: '', title: 'Add a button', draft: false, outcome: 'pr', pr: PR, submitted: '2026-11-17T10:00:00Z' });
  const supervisor = supervise({ store, config, home, launch, github });
  const server = serve({ config, store, supervisor, home });
  await new Promise<void>((r) => { server.listen(0, '127.0.0.1', r); });
  process.env.HELIX_URL = `http://127.0.0.1:${(server.address() as AddressInfo).port}`;
  const as = (who: 'ana' | 'ben' | 'olly') => { process.env.HELIX_TOKEN = `${who}-token`; };
  as('ana');
  return { repo, argsSeen, as, store, github, stop: async () => { supervisor.stop(); server.close(); store.close(); await github.close(); } };
}

const until = async <T>(read: () => T, ok: (v: T) => boolean): Promise<T> => {
  for (let i = 0; i < 500; i++) { if (ok(read())) return read(); await new Promise((r) => { setTimeout(r, 20); }); }
  throw new Error('timed out waiting');
};

// Protects: criterion 1, a pull request a Helix job opened. Fails when: the fix is not queued as its own job naming the one it resumes, does not run as `animus fix` for that pull request with the ask, or carries the ask to the shell as an option.
test('a fix of a pull request a Helix job opened queues its own job that runs animus fix with the ask', async () => {
  const h = await helix();
  const queued = await client.fix({ repo: 'app', pr: '#4', ask: '--make the button blue' });
  const ended = await until(() => h.store.get(queued.id)!, (j) => j.state === 'ended');
  await h.stop();
  assert.deepEqual([queued.id, ended.person, ended.fix_of, ended.pr, ended.outcome, queued.links?.length], [2, 'ana', 1, PR, 'pr', 0]);
  assert.deepEqual(h.argsSeen, [['fix', '--repo', h.repo, '--', PR, '--make the button blue']]);
});

// Protects: criterion 1, a pull request no job on Helix opened. Fails when: Helix refuses an Animus pull request it has no row for, runs it as someone other than its author's person, or names a Helix job for it to continue.
test('a fix of an Animus pull request no job on Helix opened runs as its author\'s person, from the pull request alone', async () => {
  const h = await helix();
  h.as('ben');
  const queued = await client.fix({ repo: 'app', pr: PR_5, ask: 'sort the list' });
  const ended = await until(() => h.store.get(queued.id)!, (j) => j.state === 'ended');
  await h.stop();
  assert.deepEqual([ended.person, ended.fix_of, ended.pr, ended.title, ended.outcome], ['ben', undefined, PR_5, 'fix: Add a list', 'pr']);
  assert.deepEqual(h.argsSeen, [['fix', '--repo', h.repo, '--', PR_5, 'sort the list']]);
});

// Protects: criterion 1, who may ask and which pull requests are Animus's. Fails when: someone other than the author's person or the owner can fix, a pull request without the spec block or by someone not on Helix is accepted, the owner's fix runs as the owner, or a second fix queues beside an active one.
test('a fix is refused with one line for another person, a pull request without the spec block, one by someone not on Helix, one GitHub lacks and one with a fix active; the owner may fix anyone\'s', async () => {
  const h = await helix();
  h.as('ben');
  const stranger = await client.fix({ repo: 'app', pr: '4', ask: 'x' }).catch((e: Error) => e.message);
  h.as('ana');
  const byHand = await client.fix({ repo: 'app', pr: '6', ask: 'x' }).catch((e: Error) => e.message);
  const notOnHelix = await client.fix({ repo: 'app', pr: '7', ask: 'x' }).catch((e: Error) => e.message);
  const missing = await client.fix({ repo: 'app', pr: '9', ask: 'x' }).catch((e: Error) => e.message);
  h.as('olly');
  const byOwner = await client.fix({ repo: 'app', pr: '4', ask: 'x' });
  h.as('ana');
  const second = await client.fix({ repo: 'app', pr: PR, ask: 'y' }).catch((e: Error) => e.message);
  await h.stop();
  assert.equal(stranger, 'Helix refused: pull request 4 was opened by ana: only ana or the owner may fix it');
  assert.equal(byHand, 'Helix refused: pull request 6 holds no Animus spec block, so no Animus job opened it and there is nothing to fix');
  assert.equal(notOnHelix, 'Helix refused: pull request 7 was opened by stranger-gh, who is not a person on this Helix, so Helix cannot fix it');
  assert.equal(missing, 'Helix refused: GitHub has no pull request 9 on o/app');
  assert.equal(byOwner.person, 'ana');
  assert.match(second as string, /^Helix refused: pull request .* has a fix (queued|running): job 2$/);
});

// Protects: criterion 4 on Helix. Fails when: a fix asked by someone other than the pull request's author runs with the asker's skills, or the author's own are dropped.
test('a fix takes the skills sent with it only when the person asking is the pull request\'s author', async () => {
  const h = await helix();
  const skills = [{ name: 'house-style', roles: ['implementer'], text: 'Use tabs.' }];
  h.as('olly');
  const byOwner = await client.fix({ repo: 'app', pr: '4', ask: 'x', skills });
  await client.cancel(String(byOwner.id));
  h.as('ana');
  await client.fix({ repo: 'app', pr: '4', ask: 'y', skills });
  await until(() => h.argsSeen.length, (n) => n === 2);
  await h.stop();
  assert.deepEqual(h.argsSeen.map((a) => a.includes('--skills')), [false, true]);
});

// Protects: criterion 8, the job page naming the job it fixes. Fails when: a fix's page has no link to the earlier job.
test('the job page of a fix names the job it fixes and links to its page', () => {
  const v = jobView({ at: '2026-11-17T12:00:00Z', stages: [], log: '', job: { id: 2, state: 'queued', person: 'ana', repo: 'app', title: 'fix: Add a button', submitted: '2026-11-17T11:00:00Z', fix_of: 1 } }, Date.parse('2026-11-17T12:00:00Z'));
  assert.deepEqual(v.facts.find((f) => f.k === 'fixes'), { k: 'fixes', v: 'job #1', page: '/jobs/1' });
});
