import assert from 'node:assert/strict';
import { mkdirSync, mkdtempSync } from 'node:fs';
import type { AddressInfo } from 'node:net';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { test } from 'node:test';
import { jobView } from '../../plugin/display/job-view.ts';
import * as client from '../../plugin/src/remote.ts';
import { hashToken, type Config } from '../src/config.ts';
import { serve } from '../src/server.ts';
import { openStore } from '../src/store.ts';
import { animusArgs, supervise, type Launch } from '../src/supervisor.ts';

const PR = 'https://github.com/o/app/pull/4';

// Stands in for `animus fix`: says its job id, then ends as a fix that updated the pull request; an ask of "x" keeps running until Helix stops it.
const FAKE = `console.error('job fake-fix: fix'); if (process.argv[2] === 'x') setInterval(() => {}, 1000); else console.log(JSON.stringify({ outcome: 'pr', pr: process.argv[1] }));`;

/** A Helix with ana, ben and olly (the owner), and ana's job 1 ended in pull request 4 of the project app. */
async function helix() {
  const home = mkdtempSync(join(tmpdir(), 'helix-fix-'));
  const repo = join(home, 'repo');
  mkdirSync(repo, { recursive: true });
  const config: Config = { host: '127.0.0.1', port: 0, slots: 1, owner: 'olly' };
  const argsSeen: string[][] = [];
  const launch: Launch = (job, dir) => { argsSeen.push(animusArgs(job, dir)); return { command: process.execPath, args: ['-e', FAKE, job.pr ?? '', job.ask ?? ''] }; };
  const store = openStore(join(home, 'helix.db'));
  for (const who of ['ana', 'ben', 'olly']) store.putPerson(who, { token_sha256: hashToken(`${who}-token`) });
  store.putProject({ name: 'app', url: 'https://github.com/o/app.git', dir: repo, state: 'ready', added: '' });
  store.add({ state: 'ended', person: 'ana', repo: 'app', spec: '', title: 'Add a button', draft: false, outcome: 'pr', pr: PR, submitted: '2026-11-17T10:00:00Z' });
  const supervisor = supervise({ store, config, home, launch });
  const server = serve({ config, store, supervisor, home });
  await new Promise<void>((r) => { server.listen(0, '127.0.0.1', r); });
  process.env.HELIX_URL = `http://127.0.0.1:${(server.address() as AddressInfo).port}`;
  const as = (who: 'ana' | 'ben' | 'olly') => { process.env.HELIX_TOKEN = `${who}-token`; };
  as('ana');
  return { repo, argsSeen, as, store, stop: () => { supervisor.stop(); server.close(); store.close(); } };
}

const until = async <T>(read: () => T, ok: (v: T) => boolean): Promise<T> => {
  for (let i = 0; i < 500; i++) { if (ok(read())) return read(); await new Promise((r) => { setTimeout(r, 20); }); }
  throw new Error('timed out waiting');
};

// Protects: criterion 8, the fix endpoint. Fails when: the fix is not queued as its own job naming the one it fixes, does not run as `animus fix` for that pull request with the ask, or carries the ask to the shell as an option.
test('a fix of a pull request a Helix job opened queues its own job that runs animus fix with the ask', async () => {
  const h = await helix();
  const queued = await client.fix({ repo: 'app', pr: '#4', ask: '--make the button blue' });
  const ended = await until(() => h.store.get(queued.id)!, (j) => j.state === 'ended');
  h.stop();
  assert.deepEqual([queued.id, ended.person, ended.fix_of, ended.pr, ended.outcome, queued.links?.length], [2, 'ana', 1, PR, 'pr', 0]);
  assert.deepEqual(h.argsSeen, [['fix', '--repo', h.repo, '--', PR, '--make the button blue']]);
});

// Protects: criterion 8, person-or-owner and the refusals. Fails when: someone other than the opener or the owner can fix, a pull request no job opened is accepted, or a second fix queues beside an active one.
test('a fix is refused with one line for another person, for a pull request no job opened and for one with a fix active; the owner may fix anyone\'s', async () => {
  const h = await helix();
  h.as('ben');
  const stranger = await client.fix({ repo: 'app', pr: '4', ask: 'x' }).catch((e: Error) => e.message);
  h.as('ana');
  const unknown = await client.fix({ repo: 'app', pr: '9', ask: 'x' }).catch((e: Error) => e.message);
  h.as('olly');
  const byOwner = await client.fix({ repo: 'app', pr: '4', ask: 'x' });
  h.as('ana');
  const second = await client.fix({ repo: 'app', pr: PR, ask: 'y' }).catch((e: Error) => e.message);
  h.stop();
  assert.equal(stranger, "Helix refused: pull request 4 was opened by ana's job 1: only ana or the owner may fix it");
  assert.equal(unknown, 'Helix refused: no job on Helix opened pull request 9 of app, so there is nothing to fix');
  assert.equal(byOwner.person, 'ana');
  assert.match(second as string, /^Helix refused: pull request .* has a fix (queued|running): job 2$/);
});

// Protects: criterion 8, the job page naming the job it fixes. Fails when: a fix's page has no link to the earlier job.
test('the job page of a fix names the job it fixes and links to its page', () => {
  const v = jobView({ at: '2026-11-17T12:00:00Z', stages: [], log: '', job: { id: 2, state: 'queued', person: 'ana', repo: 'app', title: 'fix: Add a button', submitted: '2026-11-17T11:00:00Z', fix_of: 1 } }, Date.parse('2026-11-17T12:00:00Z'));
  assert.deepEqual(v.facts.find((f) => f.k === 'fixes'), { k: 'fixes', v: 'job #1', page: '/jobs/1' });
});
