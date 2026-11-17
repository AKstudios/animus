import assert from 'node:assert/strict';
import { mkdirSync, mkdtempSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { test } from 'node:test';
import { animusCleanups, helixCleanup, oldJobFolders, staleImages } from '../src/cleanup.ts';
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

test('Helix\'s folder of a job goes once it ended long enough ago, unless it waits for an answer or has not ended', () => {
  const { home, store, add } = helix();
  const ids = {
    old: add({ outcome: 'pr', ended: ago(20) }),
    cancelled: add({ state: 'cancelled', ended: ago(20) }),
    recent: add({ outcome: 'failed', ended: ago(2) }),
    asking: add({ outcome: 'needs-input', ended: ago(40) }),
    running: add({ state: 'running', started: ago(20) }),
    queued: add({ state: 'queued' }),
  };
  const dirs = oldJobFolders(store, { home, days: 14, now: NOW });
  assert.deepEqual(dirs, [join(home, 'jobs', String(ids.old)), join(home, 'jobs', String(ids.cancelled))]);

  const lines: string[] = [];
  const docker: string[][] = [];
  helixCleanup(store, {
    home, contained: true, days: 14, dryRun: false, now: NOW, version: '0.3.4',
    docker: (args) => { docker.push(args); return { status: 0, stdout: args[1] === 'ls' ? '0.3.3\n0.3.4\n' : '' }; },
  }, (l) => lines.push(l));
  assert.deepEqual(docker.slice(1), [['image', 'rm', 'animus-job:0.3.3']]);
  assert.ok(lines.includes('removed animus-job:0.3.3'));
  assert.deepEqual(oldJobFolders(store, { home, days: 0, now: NOW }).map((d) => d.split('/').pop()), [String(ids.recent)]);
  assert.ok(lines.includes(`removed ${dirs[0]}`));
});

test('animus cleanup runs in each person\'s Animus home with their credentials, or once as the machine without containers', () => {
  const { home, store } = helix();
  const envFile = join(home, 'ana.env');
  writeFileSync(envFile, 'GH_TOKEN=ghp_ana\nCLAUDE_CODE_OAUTH_TOKEN=sk-ana\n');
  store.putPerson('ana', { token_sha256: 'a', env_file: envFile });
  store.putPerson('bo', { token_sha256: 'b', env_file: join(home, 'gone.env') });
  store.putPerson('cy', { token_sha256: 'c' });
  for (const name of ['ana', 'bo']) mkdirSync(join(personDirs(home, name).animus, 'jobs'), { recursive: true });

  const runs = animusCleanups(store, { home, contained: true });
  assert.deepEqual(runs.map((r) => r.who), ['ana', 'bo']);
  const ana = personDirs(home, 'ana');
  assert.equal(runs[0]!.env!.GH_TOKEN, 'ghp_ana');
  assert.equal(runs[0]!.env!.ANIMUS_HOME, ana.animus);
  assert.equal(runs[0]!.env!.CLAUDE_CONFIG_DIR, ana.claude);
  assert.ok(runs[0]!.env!.GIT_CONFIG_COUNT);
  assert.match(runs[1]!.why!, /credentials file .* is gone/);

  assert.deepEqual(animusCleanups(store, { home, contained: false }), [{ who: 'this machine' }]);
});

test('only the job images of other releases are removed', () => {
  assert.deepEqual(staleImages(['0.3.3', '0.3.4', '<none>', '', '0.3.1'], '0.3.4'), ['animus-job:0.3.3', 'animus-job:0.3.1']);
});
