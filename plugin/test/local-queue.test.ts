import assert from 'node:assert/strict';
import { spawnSync, type ChildProcess } from 'node:child_process';
import { EventEmitter } from 'node:events';
import { mkdtempSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { test } from 'node:test';
import './helpers.ts';
import { earlierOf } from '../src/after.ts';
import { enqueue, ensureLoop, openLocalQueue } from '../src/local-queue.ts';
import { loopConfig } from '../src/personal.ts';
import type { Earlier } from '../src/queue.ts';
import { runLoop } from '../src/local-loop.ts';

const plenty = () => ({ freeBytes: 64 * 1024 ** 3, load: 0, cores: 8 });
const tick = () => new Promise<void>((done) => { setImmediate(done); });
const newHome = () => mkdtempSync(join(tmpdir(), 'animus-queue-'));
/** A pid that no process has: one that ran and ended. */
const deadPid = () => spawnSync(process.execPath, ['-e', '']).pid;

/** What `animus run` does: a job line on stderr, the result on stdout, then it ends. Records how it was started. */
function fakeAnimus(results: { stderr?: string; stdout: string }[]) {
  const started: string[][] = [];
  const launch = (_command: string, args: string[]): ChildProcess => {
    started.push(args.slice(2));
    const step = results.shift()!;
    const child = new EventEmitter() as ChildProcess & { stdout: EventEmitter; stderr: EventEmitter };
    Object.assign(child, { pid: 4_000_000 + started.length, stdout: new EventEmitter(), stderr: new EventEmitter() });
    setImmediate(() => {
      if (step.stderr) child.stderr.emit('data', Buffer.from(step.stderr));
      child.stdout.emit('data', Buffer.from(step.stdout));
      child.emit('close', 0, null);
    });
    return child;
  };
  return { launch, started };
}

const spec = { repo: '/work/project', spec: '/work/project/docs/specs/a.md', title: 'Say done' };

// Protects: criterion 1. Fails when the job does not run to its end by the loop alone, loses its result, or the loop keeps running with nothing left.
test('the loop runs a queued job to its end, records its result and exits', async () => {
  const home = newHome();
  const queue = openLocalQueue(home);
  const job = enqueue(queue, { ...spec, flags: ['--draft'] });
  const { launch, started } = fakeAnimus([{ stderr: 'job say-done-1: started\n', stdout: JSON.stringify({ outcome: 'pr', pr: 'https://example.test/pr/1', cost_usd: 1.5 }) }]);

  const ended = await runLoop({ queue, version: '1.0.0', launch, machine: plenty, sleep: tick, home });

  assert.equal(ended, 'done');
  assert.deepEqual(started, [['run', '/work/project/docs/specs/a.md', '--repo', '/work/project', '--draft']]);
  const done = queue.get(job.id)!;
  assert.deepEqual([done.state, done.outcome, done.pr, done.animus_job, done.cost_usd, done.pid], ['ended', 'pr', 'https://example.test/pr/1', 'say-done-1', 1.5, undefined]);
  assert.equal(queue.loop(), undefined);
  assert.equal(queue.hasWork(), false);
  queue.close();
});

// Protects: a job whose process dies with no result. Fails when it stays running forever, or ends with no reason.
test('a job whose process ends with no result ends failed, saying how', async () => {
  const home = newHome();
  const queue = openLocalQueue(home);
  const job = enqueue(queue, spec);
  const { launch } = fakeAnimus([{ stdout: '' }]);

  await runLoop({ queue, version: '1.0.0', launch, machine: plenty, sleep: tick, home });

  assert.deepEqual([queue.get(job.id)!.outcome, queue.get(job.id)!.reason], ['failed', 'animus ended with exit 0 and no result']);
  queue.close();
});

// Protects: criterion 4, one loop per machine. Fails when two loops can hold the lock, or a dead loop's lock keeps the next one out.
test('only one loop holds the lock; a dead loop\'s lock is taken over', () => {
  const queue = openLocalQueue(newHome());
  enqueue(queue, spec);
  const other = process.ppid; // alive, and not this process

  assert.equal(queue.claim('1.0.0', other), true);
  assert.equal(queue.claim('1.0.0', process.pid), false);
  assert.deepEqual([queue.loop()?.pid, queue.loop()?.version], [other, '1.0.0']);

  const dead = deadPid()!;
  const stale = openLocalQueue(newHome());
  stale.claim('0.9.0', dead);
  assert.equal(stale.loop(), undefined);
  assert.equal(stale.claim('1.0.0', process.pid), true);
  assert.equal(stale.loop()?.pid, process.pid);
  queue.close();
  stale.close();
});

// Protects: criterion 4, a loop started while another runs. Fails when it runs jobs beside the holder.
test('a loop that finds another holding the lock does nothing', async () => {
  const home = newHome();
  const queue = openLocalQueue(home);
  const job = enqueue(queue, spec);
  queue.claim('1.0.0', process.ppid);
  const { launch, started } = fakeAnimus([]);

  const ended = await runLoop({ queue, version: '1.0.0', launch, machine: plenty, sleep: tick, home });

  assert.deepEqual([ended, started, queue.get(job.id)!.state], ['held', [], 'queued']);
  queue.close();
});

// Protects: criteria 1 and 4, starting a loop. Fails when a start with no loop starts none, two starts with a loop start another, or an empty queue starts a loop.
test('animus starts a loop while work is left and none runs, and not otherwise', () => {
  const queue = openLocalQueue(newHome());
  let starts = 0;
  const start = () => { starts += 1; };

  assert.equal(ensureLoop(queue, start), 'idle');
  enqueue(queue, spec);
  assert.equal(ensureLoop(queue, start), 'started');
  queue.claim('1.0.0', process.ppid);
  assert.equal(ensureLoop(queue, start), 'running');
  assert.equal(ensureLoop(queue, start), 'running');
  assert.equal(starts, 1);
  queue.close();
});

// Protects: criterion 4, a job added as the loop finishes. Fails when the loop lets go of its lock with a job queued, so nothing runs it.
test('a loop keeps its lock while a job is left, and lets go when none is', () => {
  const queue = openLocalQueue(newHome());
  queue.claim('1.0.0');
  const job = enqueue(queue, spec);

  assert.equal(queue.releaseIfIdle(), false);
  assert.equal(queue.loop()?.pid, process.pid);
  queue.save({ ...job, state: 'ended', outcome: 'pr' });
  assert.equal(queue.releaseIfIdle(), true);
  assert.equal(queue.loop(), undefined);
  queue.close();
});

// Protects: criterion 4, a stop mid-job (sleep, crash, reboot). Fails when the job that was running is lost, or started over instead of resumed.
test('a job that was running when the loop stopped is resumed', async () => {
  const home = newHome();
  const queue = openLocalQueue(home);
  const job = enqueue(queue, spec);
  // As a loop that died left it: running, with the Animus job it had said, and no loop holding the lock.
  queue.save({ ...job, state: 'running', animus_job: 'say-done-1' });
  const { launch, started } = fakeAnimus([{ stdout: JSON.stringify({ outcome: 'pr', pr: 'https://example.test/pr/2' }) }]);

  await runLoop({ queue, version: '1.0.0', launch, machine: plenty, sleep: tick, home });

  assert.deepEqual(started, [['resume', 'say-done-1']]);
  assert.deepEqual([queue.get(job.id)!.state, queue.get(job.id)!.interrupted, queue.get(job.id)!.pr], ['ended', 1, 'https://example.test/pr/2']);
  queue.close();
});

// ---- waiting on earlier specs (criterion 2) and the room check (criterion 3)

const earlierFile = '/work/project/docs/specs/earlier.md';
const waitingSpec = { ...spec, after: [earlierFile] };

/** Looks at an earlier pull request as the test says it stands now. */
const earlierNow = (now: { state: 'open' | 'merged' | 'closed' }) => async (): Promise<Earlier> =>
  now.state === 'merged' ? { state: 'merged' } : now.state === 'closed' ? { state: 'closed', reason: 'its earlier pull request was closed' } : { state: 'open', waiting: "waiting for docs/specs/earlier.md's pull request" };

// Protects: criterion 2. Fails when a job waits with a process, never starts once the earlier pull request merges, or starts without --after-merged (and waits again in animus run).
test('a job whose earlier pull request is open waits with no process, and starts by itself once it merges', async () => {
  const home = newHome();
  const queue = openLocalQueue(home);
  const job = enqueue(queue, waitingSpec);
  const earlier = { state: 'open' as 'open' | 'merged' };
  const { launch, started } = fakeAnimus([{ stdout: JSON.stringify({ outcome: 'pr', pr: 'https://example.test/pr/3' }) }]);
  let looks = 0;
  const sleep = async () => {
    await tick();
    looks += 1;
    if (looks === 2) assert.deepEqual([queue.get(job.id)!.state, queue.get(job.id)!.waiting, started.length], ['waiting', "waiting for docs/specs/earlier.md's pull request", 0]);
    if (looks === 3) earlier.state = 'merged';
  };

  await runLoop({ queue, version: '1.0.0', launch, machine: plenty, sleep, home, earlier: earlierNow(earlier), pollEvery: 1 });

  assert.equal(looks >= 3, true);
  assert.deepEqual(started, [['run', '/work/project/docs/specs/a.md', '--repo', '/work/project', '--after-merged']]);
  assert.deepEqual([queue.get(job.id)!.state, queue.get(job.id)!.pr], ['ended', 'https://example.test/pr/3']);
  queue.close();
});

// Protects: criterion 2. Fails when a job whose earlier pull request was closed unmerged keeps waiting or starts.
test('a job whose earlier pull request was closed unmerged ends failed with that reason', async () => {
  const home = newHome();
  const queue = openLocalQueue(home);
  const job = enqueue(queue, waitingSpec);
  const { launch, started } = fakeAnimus([]);

  await runLoop({ queue, version: '1.0.0', launch, machine: plenty, sleep: tick, home, earlier: earlierNow({ state: 'closed' }) });

  const ended = queue.get(job.id)!;
  assert.deepEqual([ended.state, ended.outcome, ended.reason, started.length], ['ended', 'failed', 'its earlier pull request was closed', 0]);
  queue.close();
});

// Protects: where each earlier pull request stands, found as animus run finds it. Fails when a merged one holds the job, a closed one is missed, or an unmerged one lets it through.
test('earlierOf says merged, open or closed from the pull request GitHub finds for the spec', () => {
  const dir = mkdtempSync(join(tmpdir(), 'animus-after-'));
  const file = join(dir, 'earlier.md');
  writeFileSync(file, '---\nsize: small\n---\n# Earlier work\n\nx\n\n## Acceptance criteria\n\n1. a\n   $ true\n');
  const find = (state: 'OPEN' | 'MERGED' | 'CLOSED' | undefined) => (title: string) => (state && title === 'Earlier work' ? { url: 'https://example.test/pr/9', state } : undefined);
  const look = (state: Parameters<typeof find>[0]) => earlierOf({ repo: dir, files: [file], lookup: () => undefined, find: find(state) });

  assert.deepEqual(look('MERGED'), { state: 'merged' });
  assert.deepEqual(look('OPEN'), { state: 'open', waiting: "waiting for earlier.md's pull request" });
  assert.deepEqual(look(undefined), { state: 'open', waiting: "waiting for earlier.md's pull request" });
  assert.deepEqual(look('CLOSED'), { state: 'closed', reason: `this spec runs after ${file}, whose pull request https://example.test/pr/9 was closed without merging` });
});

// Protects: criterion 3. Fails when jobs start past the slots, or a job held for room says nothing about why.
test('the loop starts a second job only when the machine has room, and says why a job is held', async () => {
  const home = newHome();
  const queue = openLocalQueue(home);
  const first = enqueue(queue, spec);
  const second = enqueue(queue, { ...spec, spec: '/work/project/docs/specs/b.md' });
  const { launch, started } = fakeAnimus([{ stdout: JSON.stringify({ outcome: 'pr' }) }, { stdout: JSON.stringify({ outcome: 'pr' }) }]);
  const small = () => ({ freeBytes: 5 * 1024 ** 3, load: 0, cores: 8 });
  let looks = 0;
  const sleep = async () => {
    looks += 1;
    // With the first job running the machine has 5 GB free: 4g plus the 2g kept does not fit.
    if (looks === 1) assert.deepEqual([queue.get(second.id)!.state, queue.get(second.id)!.waiting], ['queued', 'waiting for memory: 5 GB free, needs 4 GB plus 2 GB kept free']);
    await tick();
  };

  await runLoop({ queue, version: '1.0.0', launch, machine: small, sleep, home, earlier: earlierNow({ state: 'merged' }), config: { slots: 2, job_memory: '4g', reserve_memory: '2g' } });

  assert.deepEqual(started.map((a) => a[1]), ['/work/project/docs/specs/a.md', '/work/project/docs/specs/b.md']);
  assert.equal(queue.get(first.id)!.state, 'ended');
  assert.deepEqual([queue.get(second.id)!.state, queue.get(second.id)!.waiting], ['ended', undefined]);
  queue.close();
});

// Protects: criterion 3, run: in config.yaml. Fails when the loop ignores slots, job_memory, reserve_memory or tier_limits, or takes a bad value.
test('loopConfig reads the room settings from run: and refuses bad ones', () => {
  const file = (text: string) => { const f = join(mkdtempSync(join(tmpdir(), 'animus-cfg-')), 'config.yaml'); writeFileSync(f, text); return f; };

  assert.deepEqual(loopConfig(join(tmpdir(), 'animus-no-such-config.yaml')), { slots: 2, job_memory: '4g', reserve_memory: '2g', tier_limits: {} });
  assert.deepEqual(loopConfig(file('run: helix\n')), { slots: 2, job_memory: '4g', reserve_memory: '2g', tier_limits: {} });
  assert.deepEqual(loopConfig(file('run:\n  where: local\n  slots: 3\n  job_memory: 6g\n  reserve_memory: 1g\n  tier_limits: { deep: 1 }\n')),
    { slots: 3, job_memory: '6g', reserve_memory: '1g', tier_limits: { deep: 1 } });
  assert.throws(() => loopConfig(file('run:\n  slots: 0\n')), /slots must be a whole number/);
  assert.throws(() => loopConfig(file('run:\n  job_memory: lots\n')), /job_memory must be a memory size/);
  assert.throws(() => loopConfig(file('run:\n  tier_limits: { huge: 1 }\n')), /tier_limits has huge/);
});
