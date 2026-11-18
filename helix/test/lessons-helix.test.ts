import assert from 'node:assert/strict';
import { execFile, spawnSync } from 'node:child_process';
import { mkdirSync, mkdtempSync } from 'node:fs';
import type { AddressInfo } from 'node:net';
import { tmpdir } from 'node:os';
import { dirname, join } from 'node:path';
import { test } from 'node:test';
import { fileURLToPath } from 'node:url';
import { promisify } from 'node:util';
import { addProposals, readLessons } from '../../plugin/src/lessons.ts';
import * as client from '../../plugin/src/remote.ts';
import { hashToken, type Config } from '../src/config.ts';
import { RETRO_EVERY_MS, weeklyRetros } from '../src/retro.ts';
import { serve } from '../src/server.ts';
import { openStore } from '../src/store.ts';
import { supervise } from '../src/supervisor.ts';
import { fakeTransport } from './fake-slack.ts';

const CLI = join(dirname(fileURLToPath(import.meta.url)), '..', '..', 'plugin', 'src', 'cli.ts');
const NOW = Date.parse('2026-11-18T12:00:00Z');
const proposal = (text: string, over = {}) => ({ text, scope: 'project' as const, project: 'app', agent: 'implementer' as const, cites: ['a', 'b'], ...over });

/** A Helix with ana on it, a ready project `app`, and its own empty Animus home. */
async function helix() {
  const home = mkdtempSync(join(tmpdir(), 'helix-lessons-'));
  process.env.HELIX_HOME = home;
  process.env.ANIMUS_HOME = join(home, 'animus');
  mkdirSync(join(home, 'repo'));
  const config: Config = { host: '127.0.0.1', port: 0, slots: 1 };
  const store = openStore(join(home, 'helix.db'));
  store.putPerson('ana', { token_sha256: hashToken('ana-token') });
  store.putProject({ name: 'app', url: 'https://github.com/o/app.git', dir: join(home, 'repo'), state: 'ready', added: '' });
  const supervisor = supervise({ store, config, home });
  const server = serve({ config, store, supervisor, home });
  await new Promise<void>((r) => { server.listen(0, '127.0.0.1', r); });
  process.env.HELIX_URL = `http://127.0.0.1:${(server.address() as AddressInfo).port}`;
  process.env.HELIX_TOKEN = 'ana-token';
  const stop = () => { supervisor.stop(); server.close(); store.close(); };
  return { home, store, stop };
}

// Protects: criterion 5, GET /lessons and POST /lessons/<id>. Fails when: Helix reads or keeps lessons somewhere but its own Animus home, hides another project's from a project filter wrongly, or lets accept and dismiss through for no token or a missing lesson.
test('lessons are listed for a project, kept and dropped through Helix with a person\'s token', async () => {
  const h = await helix();
  addProposals([proposal('Close servers tests start.'), proposal('Other project only.', { project: 'other' }), proposal('Every project.', { scope: 'factory', project: 'other' })], NOW);

  const forApp = (await client.lessons('app')).lessons.map((l) => l.text);
  assert.deepEqual(forApp, ['Close servers tests start.', 'Every project.']);
  assert.equal((await client.lessons()).lessons.length, 3);

  assert.equal((await client.decideLesson(1, 'accept')).status, 'kept');
  assert.equal((await client.decideLesson(2, 'dismiss')).status, 'dismissed');
  assert.deepEqual(readLessons().map((l) => l.status), ['kept', 'dismissed', 'proposed']);
  await assert.rejects(client.decideLesson(1, 'accept'), /already kept/);
  await assert.rejects(client.decideLesson(9, 'accept'), /no lesson 9/);

  const bare = await fetch(`${process.env.HELIX_URL}/lessons`);
  assert.equal(bare.status, 401);
  h.stop();
});

// Protects: criterion 5, `animus lessons` for a project on Helix. Fails when: the CLI reads this machine's own lessons.json instead of Helix's for a checkout of a Helix project, or accept does not reach Helix.
test('animus lessons and accept go to Helix from a checkout of a Helix project', async () => {
  const h = await helix();
  addProposals([proposal('Close servers tests start.')], NOW);
  const checkout = mkdtempSync(join(tmpdir(), 'helix-lessons-checkout-'));
  for (const args of [['init', '-q'], ['remote', 'add', 'origin', 'https://github.com/o/app.git']]) spawnSync('git', args, { cwd: checkout });
  // This machine's own home is empty: whatever the CLI lists came from Helix.
  const env = { ...process.env, ANIMUS_HOME: mkdtempSync(join(tmpdir(), 'laptop-home-')) };
  const run = (...args: string[]) => promisify(execFile)(process.execPath, ['--disable-warning=ExperimentalWarning', CLI, 'lessons', ...args], { cwd: checkout, env });

  assert.match((await run()).stdout, /1  Close servers tests start\.[\s\S]*animus lessons accept 1/);
  assert.match((await run('accept', '1')).stdout, /lesson 1 is kept/);
  assert.equal(readLessons()[0]!.status, 'kept');
  h.stop();
});

// Protects: criterion 5, the weekly retro and its Slack notice. Fails when: a project is retro'd more than once a week or never, its channel is not told the count and the command, or a retro that proposed nothing or failed posts anyway.
test('a retro runs for each ready project once a week and its channel is told how many lessons it proposed', async () => {
  const h = await helix();
  h.store.putProject({ name: 'quiet', url: 'https://github.com/o/quiet.git', dir: join(h.home, 'repo'), state: 'ready', added: '' });
  h.store.putProject({ name: 'broken', url: 'https://github.com/o/broken.git', dir: join(h.home, 'repo'), state: 'ready', added: '' });
  h.store.putProject({ name: 'new', url: 'https://github.com/o/new.git', dir: join(h.home, 'repo'), state: 'checking', added: '' });
  h.store.setChannelProject('C-APP', 'app');
  h.store.setChannelProject('C-QUIET', 'quiet');
  const slack = fakeTransport();
  const ran: string[] = [];
  const say: string[] = [];
  const run = async (project: string) => {
    ran.push(project);
    if (project === 'broken') throw new Error('no run in the last 7 days');
    return { proposed: project === 'app' ? 3 : 0 };
  };

  await weeklyRetros({ store: h.store, run, slack: slack.transport, say: (l) => say.push(l), now: NOW });
  assert.deepEqual(ran, ['app', 'broken', 'quiet']);
  assert.deepEqual(slack.sent.map((s) => s.method === 'post' && [s.channel, s.text]), [['C-APP', 'The weekly retro of app proposed 3 lessons. See them with `animus lessons`, then `animus lessons accept <id>` or `animus lessons dismiss <id>`.']]);
  assert.match(say.join('\n'), /retro of broken did not run: no run in the last 7 days/);

  // A day later nothing is due, not even the project that failed; eight days later all are.
  await weeklyRetros({ store: h.store, run, slack: slack.transport, now: NOW + 24 * 60 * 60 * 1000 });
  assert.equal(ran.length, 3);
  await weeklyRetros({ store: h.store, run, slack: slack.transport, now: NOW + RETRO_EVERY_MS + 1000 });
  assert.equal(ran.length, 6);
  h.stop();
});
