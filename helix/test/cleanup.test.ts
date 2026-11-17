import assert from 'node:assert/strict';
import { existsSync, mkdirSync, mkdtempSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { test } from 'node:test';
import { animusCleanups, helixCleanup, staleImages } from '../src/cleanup.ts';
import { personDirs } from '../src/container.ts';
import { openStore, type HelixJob } from '../src/store.ts';

const DAY = 24 * 60 * 60 * 1000;
const NOW = Date.parse('2026-11-30T00:00:00Z');
const ago = (days: number) => new Date(NOW - days * DAY).toISOString();

function helix() {
  const home = mkdtempSync(join(tmpdir(), 'helix-'));
  const store = openStore(join(home, 'helix.db'));
  const add = (over: Partial<HelixJob>) => {
    const job = store.add({ state: 'ended', person: 'ana', repo: 'app', spec: '', title: 't', draft: false, submitted: ago(30), ...over });
    mkdirSync(join(home, 'jobs', String(job.id)), { recursive: true });
    return job.id;
  };
  return { home, store, add };
}

test('Helix keeps every job\'s folder and removes only the job images of other releases', async () => {
  const { home, store, add } = helix();
  const ids = [add({ outcome: 'pr', ended: ago(200) }), add({ state: 'cancelled', ended: ago(200) })];
  const lines: string[] = [];
  const docker: string[][] = [];
  await helixCleanup(store, {
    home, contained: true, days: 30, dryRun: false, version: '0.3.4',
    docker: (args) => { docker.push(args); return { status: 0, stdout: args[1] === 'ls' ? '0.3.3\n0.3.4\n' : '' }; },
  }, (l) => lines.push(l));
  assert.deepEqual(docker.slice(1), [['image', 'rm', 'animus-job:0.3.3']]);
  assert.deepEqual(lines, ['removed animus-job:0.3.3']);
  for (const id of ids) assert.equal(existsSync(join(home, 'jobs', String(id))), true);
});

test('animus cleanup runs in each person\'s Animus home with their credentials, or once as the machine without containers', async () => {
  const { home, store } = helix();
  const envFile = join(home, 'ana.env');
  writeFileSync(envFile, 'GH_TOKEN=ghp_ana\nCLAUDE_CODE_OAUTH_TOKEN=sk-ana\n');
  store.putPerson('ana', { token_sha256: 'a', env_file: envFile });
  store.putPerson('bo', { token_sha256: 'b', env_file: join(home, 'gone.env') });
  store.putPerson('cy', { token_sha256: 'c' });
  for (const name of ['ana', 'bo']) mkdirSync(join(personDirs(home, name).animus, 'jobs'), { recursive: true });

  const runs = await animusCleanups(store, { home, contained: true });
  assert.deepEqual(runs.map((r) => r.who), ['ana', 'bo']);
  const ana = personDirs(home, 'ana');
  assert.equal(runs[0]!.env!.GH_TOKEN, 'ghp_ana');
  assert.equal(runs[0]!.env!.ANIMUS_HOME, ana.animus);
  assert.equal(runs[0]!.env!.CLAUDE_CONFIG_DIR, ana.claude);
  assert.ok(runs[0]!.env!.GIT_CONFIG_COUNT);
  assert.match(runs[1]!.why!, /credentials file .* is gone/);

  assert.deepEqual(await animusCleanups(store, { home, contained: false }), [{ who: 'this machine' }]);
});

test('only the job images of other releases are removed', () => {
  assert.deepEqual(staleImages(['0.3.3', '0.3.4', '<none>', '', '0.3.1'], '0.3.4'), ['animus-job:0.3.3', 'animus-job:0.3.1']);
});
