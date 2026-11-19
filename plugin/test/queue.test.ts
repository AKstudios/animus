import assert from 'node:assert/strict';
import { test } from 'node:test';
import { createQueue, MAX_INTERRUPTIONS, type QueueJob, type QueueOptions } from '../src/queue.ts';

const plenty = () => ({ freeBytes: 64 * 1024 ** 3, load: 0, cores: 8 });

/** An in-memory store and a start that marks the job running, as a supervisor does. */
function rig(jobs: Partial<QueueJob>[], opts: Partial<QueueOptions<QueueJob>> = {}) {
  const rows = new Map<number, QueueJob>(jobs.map((j, i) => [i + 1, { id: i + 1, state: 'queued', ...j }]));
  const killed: number[] = [];
  const queue = createQueue<QueueJob>({
    store: { get: (id) => rows.get(id), inState: (s) => [...rows.values()].filter((j) => j.state === s), save: (j) => { rows.set(j.id, j); } },
    config: { slots: 2 },
    machine: plenty,
    start: (j) => { rows.set(j.id, { ...j, state: 'running', pid: 100 + j.id }); return true; },
    end: (j) => { rows.set(j.id, j); },
    kill: (j) => { killed.push(j.id); },
    ...opts,
  });
  return { rows, queue, killed };
}

// Protects: the slot limit. Fails when more jobs run than slots, or a freed slot is not given to the next job.
test('starts jobs up to the slots and the next when one is released', () => {
  const { rows, queue } = rig([{}, {}, {}]);
  queue.begin();
  assert.deepEqual([...rows.values()].map((j) => j.state), ['running', 'running', 'queued']);
  rows.set(1, { ...rows.get(1)!, state: 'ended' });
  queue.release(1);
  assert.equal(rows.get(3)!.state, 'running');
});

// Protects: the tier limit and its reason. Fails when a job over its tier's limit starts, or is not told why it waits.
test('holds a job whose tier is at its limit and says why', () => {
  const { rows, queue } = rig([{ tier: 'deep' }, { tier: 'deep' }], { config: { slots: 2, tier_limits: { deep: 1 } } });
  queue.begin();
  assert.equal(rows.get(2)!.state, 'queued');
  assert.equal(rows.get(2)!.waiting, 'waiting for the deep tier: 1 of 1 running');
});

// Protects: resuming after a restart and the cap. Fails when a job that was running is lost, or one that keeps taking the supervisor down is started forever.
test('queues a job that was running again, and ends one interrupted too often', () => {
  const { rows, queue } = rig([{ state: 'running', animus_job: 'a' }, { state: 'running', interrupted: MAX_INTERRUPTIONS - 1 }], { paused: () => true });
  queue.begin();
  assert.deepEqual([rows.get(1)!.state, rows.get(1)!.interrupted, rows.get(1)!.pid], ['queued', 1, undefined]);
  assert.deepEqual([rows.get(2)!.state, rows.get(2)!.outcome], ['ended', 'failed']);
});

// Protects: cancel and answer. Fails when a cancelled job keeps its process, or an answered job loses its question state or does not queue again.
test('cancels a running job and ends its process, and queues an answered job with its answer', () => {
  const { rows, queue, killed } = rig([{ state: 'running', pid: 5 }, { state: 'ended', outcome: 'needs-input', question: 'which?', ended: 'x' }], { paused: () => true });
  queue.cancel(rows.get(1)!);
  assert.deepEqual([rows.get(1)!.state, rows.get(1)!.pid, killed], ['cancelled', undefined, [1]]);
  queue.answer(rows.get(2)!, 'this one');
  const answered = rows.get(2)!;
  assert.deepEqual([answered.state, answered.answer, answered.outcome, answered.question], ['queued', 'this one', undefined, undefined]);
});
