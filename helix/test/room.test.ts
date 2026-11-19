import assert from 'node:assert/strict';
import { execFileSync } from 'node:child_process';
import { mkdirSync, mkdtempSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { test } from 'node:test';
import { loadConfig, parseMemory, type Config } from '../src/config.ts';
import type { Reading } from '../../plugin/src/room.ts';
import { openStore } from '../src/store.ts';
import { supervise, type Launch } from '../src/supervisor.ts';

const GB = 1024 ** 3;
const spec = (difficulty: string, title: string) => `---\nsize: small\ndifficulty: ${difficulty}\n---\n# ${title}\n\n## Acceptance criteria\n\n1. It works.\n`;

/** A supervisor whose jobs hold until stop(), on a machine the test sets. */
function setup(extra: Partial<Config> = {}) {
  const home = mkdtempSync(join(tmpdir(), 'helix-room-'));
  const repo = join(home, 'repo');
  mkdirSync(repo);
  execFileSync('git', ['init', '-q'], { cwd: repo });
  const config: Config = { host: '', port: 0, slots: 3, ...extra };
  const machine: Reading = { freeBytes: 30 * GB, load: 0.5, cores: 8 };
  const store = openStore(join(home, 'helix.db'));
  store.putPerson('ana', { token_sha256: 'x' });
  store.putProject({ name: 'app', url: '', dir: repo, state: 'ready', added: '' });
  const launch: Launch = () => ({ command: process.execPath, args: ['-e', 'setInterval(() => {}, 1000)'] });
  const supervisor = supervise({ store, config, home, launch, machine: () => machine });
  const submit = (title: string, difficulty = 'routine') => supervisor.submit('ana', { repo: 'app', spec: spec(difficulty, title) });
  const state = (id: number) => store.get(id)!;
  return { config, machine, supervisor, submit, state, done: () => { supervisor.stop(); store.close(); } };
}

test('holds a job for memory or load, with the reason, and starts it once both fit', () => {
  const h = setup();
  const first = h.submit('first');
  h.machine.freeBytes = 3.1 * GB;
  const second = h.submit('second');
  assert.equal(h.state(second.id).state, 'queued');
  assert.equal(h.state(second.id).waiting, 'waiting for memory: 3.1 GB free, needs 4 GB plus 2 GB kept free');

  h.machine.freeBytes = 30 * GB;
  h.machine.load = 8;
  h.supervisor.wake();
  assert.equal(h.state(second.id).state, 'queued');
  assert.equal(h.state(second.id).waiting, 'waiting for CPU: load 8 on 8 cores');

  h.machine.load = 7.9;
  h.supervisor.wake();
  assert.equal(h.state(second.id).state, 'running');
  assert.equal(h.state(second.id).waiting, undefined);
  assert.equal(h.state(first.id).state, 'running');
  h.done();
});

test('a job at its tier limit waits while a later job on another tier starts', () => {
  const h = setup({ tier_limits: { deep: 1 } });
  const a = h.submit('a', 'risky');
  const b = h.submit('b', 'risky');
  const c = h.submit('c');
  assert.deepEqual([a, b, c].map((j) => h.state(j.id).state), ['running', 'queued', 'running']);
  assert.equal(h.state(b.id).waiting, 'waiting for the deep tier: 1 of 1 running');
  h.done();
});

test('with nothing running the first job starts without room, and slots stay a ceiling', () => {
  const h = setup({ slots: 2 });
  h.machine.freeBytes = 0;
  h.machine.load = 50;
  const a = h.submit('a');
  const b = h.submit('b');
  assert.deepEqual([a, b].map((j) => h.state(j.id).state), ['running', 'queued']);

  h.machine.freeBytes = 30 * GB;
  h.machine.load = 0;
  const c = h.submit('c');
  const d = h.submit('d');
  assert.deepEqual([b, c, d].map((j) => h.state(j.id).state), ['running', 'queued', 'queued']);
  assert.equal(h.state(d.id).waiting, undefined);
  h.done();
});

test('config.yaml reads the room keys, with defaults, and refuses a wrong one by name', () => {
  const dir = mkdtempSync(join(tmpdir(), 'helix-room-cfg-'));
  const file = join(dir, 'config.yaml');
  const load = (yaml: string) => { writeFileSync(file, yaml); return loadConfig(file); };

  const plain = load('slots: 2\n');
  assert.deepEqual([plain.reserve_memory, plain.job_memory, plain.tier_limits], ['2g', '4g', {}]);
  const set = load('reserve_memory: 512m\njob_memory: 6g\ntier_limits: { deep: 1 }\n');
  assert.deepEqual([set.reserve_memory, set.job_memory, set.tier_limits], ['512m', '6g', { deep: 1 }]);

  assert.throws(() => load('reserve_memory: lots\n'), /reserve_memory/);
  assert.throws(() => load('job_memory: 0g\n'), /job_memory/);
  assert.throws(() => load('tier_limits: { deep: 0 }\n'), /tier_limits\.deep/);
  assert.throws(() => load('tier_limits: { huge: 1 }\n'), /tier_limits.*huge/);
  assert.throws(() => load('container: { memory: big }\n'), /container\.memory/);
  assert.equal(parseMemory('512m'), 512 * 1024 ** 2);
});
