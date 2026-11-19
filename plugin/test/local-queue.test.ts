import assert from 'node:assert/strict';
import { spawnSync, type ChildProcess } from 'node:child_process';
import { EventEmitter } from 'node:events';
import { mkdtempSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { test } from 'node:test';
import './helpers.ts';
import { enqueue, ensureLoop, openLocalQueue } from '../src/local-queue.ts';
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
