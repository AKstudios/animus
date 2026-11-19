import assert from 'node:assert/strict';
import { spawnSync, type ChildProcess } from 'node:child_process';
import { EventEmitter } from 'node:events';
import { mkdtempSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { test } from 'node:test';
import './helpers.ts';
import { earlierOf } from '../src/after.ts';
import { loopFindings } from '../src/doctor.ts';
import { enqueue, ensureLoop, openLocalQueue, type LocalJob } from '../src/local-queue.ts';
import { answerLocal, cancelLocal } from '../src/local-status.ts';
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

const cli = (home: string, ...args: string[]) => {
  const r = spawnSync(process.execPath, ['--disable-warning=ExperimentalWarning', join(import.meta.dirname, '../src/cli.ts'), ...args], { env: { ...process.env, ANIMUS_HOME: home, HELIX_URL: '', HELIX_TOKEN: '' }, encoding: 'utf8' });
  return { code: r.status, out: r.stdout, err: r.stderr };
};
const ended = (queue: ReturnType<typeof openLocalQueue>, fields: Partial<LocalJob>) => {
  const job = enqueue(queue, spec);
  queue.save({ ...queue.get(job.id)!, state: 'ended', ...fields });
  return job.id;
};

// Protects: criterion 5, the list of what needs you. Fails when a question is dropped once looked at, a failure or pull request shows again after it was seen, or a job that needs nothing is listed.
test('animus status lists questions, then failures and pull requests since you last looked, and marks them seen', () => {
  const home = newHome();
  const queue = openLocalQueue(home);
  const old = ended(queue, { outcome: 'failed', reason: 'old trouble', ended: '2020-01-01T00:00:00.000Z' });
  const asks = ended(queue, { outcome: 'needs-input', question: 'Which table?', ended: '2020-01-02T00:00:00.000Z' });
  const failed = ended(queue, { outcome: 'failed', reason: 'gates failed\nmore', ended: '2022-01-01T00:00:00.000Z' });
  const opened = ended(queue, { outcome: 'pr', pr: 'https://example.test/pr/7', ended: '2022-01-02T00:00:00.000Z' });
  queue.markSeen('2021-01-01T00:00:00.000Z');
  queue.close();

  const first = cli(home, 'status');
  const second = cli(home, 'status');

  assert.equal(first.code, 0);
  const lines = first.out.split('\n');
  const at = (text: string) => lines.findIndex((l) => l.includes(text));
  assert.ok(at('needs you:') === 0 && at(`job ${asks} asks: Which table?`) < at(`job ${failed} failed`) && at(`job ${failed} failed`) < at(`job ${opened} opened a pull request: https://example.test/pr/7`));
  assert.ok(first.out.includes('gates failed') && !first.out.includes('more\n  job'), 'only the first line of a reason');
  assert.ok(!first.out.slice(0, first.out.indexOf('\n\n')).includes(`job ${old} failed`), 'a failure from before you last looked is not listed as needing you');
  // The second look: the question still waits, the failure and the pull request were seen.
  assert.ok(second.out.startsWith(`needs you:\n  job ${asks} asks`) && !second.out.includes('opened a pull request') && !second.out.includes('failed:'));
});

// Protects: criterion 3 and 5, the room reason in status. Fails when a job held for room shows only "queued".
test('animus status shows why a job is held for room, in the list and for the one job', () => {
  const home = newHome();
  const queue = openLocalQueue(home);
  const job = enqueue(queue, spec);
  queue.save({ ...queue.get(job.id)!, waiting: 'waiting for memory: 5 GB free, needs 4 GB plus 2 GB kept free' });
  queue.claim('1.0.0', process.ppid);
  queue.close();

  const list = cli(home, 'status').out;
  const one = cli(home, 'status', String(job.id)).out;

  assert.match(list, /queued\s+Say done\s+waiting for memory: 5 GB free/);
  assert.ok(one.includes(`job ${job.id}: Say done`) && one.includes('  waiting for memory: 5 GB free, needs 4 GB plus 2 GB kept free'));
  assert.equal(cli(home, 'status', '99').code, 2);
});

// Protects: criterion 5, the session-start hook. Fails when it starts a loop, prints with nothing to say, or says nothing when something needs you.
test('session-start prints what needs you, and starts nothing', () => {
  const home = newHome();
  const queue = openLocalQueue(home);
  enqueue(queue, spec);
  ended(queue, { outcome: 'needs-input', question: 'Which table?', ended: '2020-01-02T00:00:00.000Z' });
  queue.close();

  const quiet = cli(newHome(), 'session-start');
  const told = cli(home, 'session-start');

  assert.deepEqual([quiet.code, quiet.out], [0, '']);
  assert.ok(told.out.startsWith('needs you:') && told.out.includes('asks: Which table?'));
  const after = openLocalQueue(home);
  assert.equal(after.loop(), undefined, 'the hook started no loop, though a job is queued');
  after.close();
});

// Protects: criterion 5, answer. Fails when an answer to a job that did not ask is taken, or the answered job is not resumed with the answer.
test('animus answer queues a job that asked again, and the loop resumes it with the answer', async () => {
  const home = newHome();
  const queue = openLocalQueue(home);
  const id = ended(queue, { outcome: 'needs-input', question: 'Which table?', animus_job: 'say-done-1', ended: '2020-01-02T00:00:00.000Z' });
  const other = ended(queue, { outcome: 'pr' });
  queue.close();

  assert.equal(cli(home, 'answer', String(other), 'x').code, 2);
  const reopened = openLocalQueue(home);
  // In this process: the command would also start a real loop.
  assert.equal(answerLocal(reopened, String(id), 'the users table').state, 'queued');
  const { launch, started } = fakeAnimus([{ stdout: JSON.stringify({ outcome: 'pr' }) }]);
  await runLoop({ queue: reopened, version: '1.0.0', launch, machine: plenty, sleep: tick, home });
  assert.deepEqual(started, [['resume', 'say-done-1', '--answer', 'the users table']]);
  assert.deepEqual([reopened.get(id)!.state, reopened.get(id)!.question], ['ended', undefined]);
  reopened.close();
});

// Protects: criterion 5, cancel. Fails when a running job is left to finish, the loop overwrites the cancellation with its end, or a finished job can be cancelled.
test('animus cancel ends a waiting job, and a running one stays cancelled when its process ends', async () => {
  const home = newHome();
  const queue = openLocalQueue(home);
  const waiting = enqueue(queue, { ...spec, after: ['/work/project/docs/specs/earlier.md'] });
  const running = enqueue(queue, spec);
  const done = ended(queue, { outcome: 'pr' });

  cancelLocal(queue, String(waiting.id));
  assert.deepEqual([queue.get(waiting.id)!.state, queue.get(waiting.id)!.ended === undefined], ['cancelled', false]);
  assert.throws(() => cancelLocal(queue, String(waiting.id)), /already been cancelled/);
  assert.throws(() => cancelLocal(queue, String(done)), /already ended/);

  // The loop starts the job; cancelled while it runs, it ends with a result the loop must not record.
  const child = new EventEmitter() as ChildProcess & { stdout: EventEmitter; stderr: EventEmitter };
  Object.assign(child, { pid: 4_000_001, stdout: new EventEmitter(), stderr: new EventEmitter() });
  const launch = (): ChildProcess => child;
  let looks = 0;
  const sleep = async () => {
    looks += 1;
    if (looks === 1) { assert.equal(queue.get(running.id)!.state, 'running'); cancelLocal(queue, String(running.id)); child.stdout.emit('data', Buffer.from(JSON.stringify({ outcome: 'pr' }))); child.emit('close', 0, null); }
    await tick();
  };
  await runLoop({ queue, version: '1.0.0', launch, machine: plenty, sleep, home });

  assert.deepEqual([queue.get(running.id)!.state, queue.get(running.id)!.outcome, queue.get(running.id)!.pid], ['cancelled', undefined, undefined]);
  queue.close();
});

/** A job's process that ends when told to, so a test decides how long the job runs. */
function heldAnimus(result: object) {
  const started: string[][] = [];
  const children: (ChildProcess & { stdout: EventEmitter; stderr: EventEmitter })[] = [];
  const launch = (_command: string, args: string[]): ChildProcess => {
    started.push(args.slice(2));
    const child = new EventEmitter() as ChildProcess & { stdout: EventEmitter; stderr: EventEmitter };
    Object.assign(child, { pid: 4_100_000 + started.length, stdout: new EventEmitter(), stderr: new EventEmitter() });
    children.push(child);
    return child;
  };
  const finish = (n: number) => { children[n]!.stdout.emit('data', Buffer.from(JSON.stringify(result))); children[n]!.emit('close', 0, null); };
  return { launch, started, finish };
}

const settle = async () => { for (let i = 0; i < 30; i += 1) await tick(); };

// Protects: criterion 7. Fails when the newer release's loop starts a job while the older one still runs jobs, does not take over once they end, or the older loop goes on starting jobs after being asked to stop.
test('a newer animus drains an older loop: it starts nothing more, its running job ends, then the newer loop runs the rest', async () => {
  const home = newHome();
  const queue = openLocalQueue(home);
  const running = enqueue(queue, spec);
  const oldAnimus = heldAnimus({ outcome: 'pr', pr: 'https://example.test/pr/1' });
  const newAnimus = heldAnimus({ outcome: 'pr', pr: 'https://example.test/pr/2' });
  const oldLoop = runLoop({ queue, version: '1.0.0', pid: process.ppid, launch: oldAnimus.launch, machine: plenty, sleep: tick, home });
  await settle();
  assert.equal(queue.get(running.id)!.state, 'running');

  const later = enqueue(queue, spec);
  let newLoop: Promise<'done' | 'held'> | undefined;
  const start = () => { newLoop = runLoop({ queue, version: '1.1.0', launch: newAnimus.launch, machine: plenty, sleep: tick, home }); };
  assert.equal(ensureLoop(queue, start, '1.1.0'), 'started');
  assert.equal(ensureLoop(queue, start, '1.1.0'), 'running', 'a second animus command started a second successor');
  await settle();

  // Draining: the older loop holds its job and starts nothing; the newer one has not taken over.
  assert.deepEqual([queue.loop()?.version, queue.draining(), queue.get(later.id)!.state, oldAnimus.started.length, newAnimus.started.length], ['1.0.0', true, 'queued', 1, 0]);

  oldAnimus.finish(0);
  await settle();

  assert.equal(await oldLoop, 'done');
  assert.deepEqual(newAnimus.started.map((a) => a[1]), [spec.spec], 'the newer loop runs only the queued job');
  assert.deepEqual([queue.get(running.id)!.state, queue.get(running.id)!.pr], ['ended', 'https://example.test/pr/1']);
  assert.equal(queue.get(later.id)!.state, 'running');
  newAnimus.finish(0);
  assert.equal(await newLoop, 'done');
  assert.deepEqual([queue.get(later.id)!.state, queue.get(later.id)!.pr], ['ended', 'https://example.test/pr/2']);
  queue.close();
});

// Protects: criterion 7, the other direction. Fails when an older animus, or one of the same release, stops a loop that is as new or newer.
test('animus does not drain a loop of its own release or a newer one', () => {
  const queue = openLocalQueue(newHome());
  enqueue(queue, spec);
  queue.claim('1.10.0', process.ppid);

  assert.equal(ensureLoop(queue, () => assert.fail('started a loop'), '1.10.0'), 'running');
  assert.equal(ensureLoop(queue, () => assert.fail('started a loop'), '1.9.0'), 'running');
  assert.equal(queue.draining(), false);
  queue.close();
});

// Protects: criterion 7, doctor. Fails when a variable the shell has and the loop lacks goes unwarned, or one the loop has (or the shell sets on its own) is warned about.
test('animus doctor warns of variables this shell has that the loop was started without', () => {
  const home = newHome();
  const queue = openLocalQueue(home);
  queue.claim('1.0.0', process.ppid, ['PATH', 'HOME']);
  queue.close();

  const warned = loopFindings({ PATH: '/bin', HOME: '/h', GH_TOKEN: 'x', PWD: '/here' }, home);
  assert.deepEqual(warned.map((f) => f.level), ['warn']);
  assert.match(warned[0]!.detail, /without GH_TOKEN,/);
  assert.doesNotMatch(warned[0]!.detail, /PWD|PATH/);
  assert.deepEqual(loopFindings({ PATH: '/bin' }, home), []);
});
