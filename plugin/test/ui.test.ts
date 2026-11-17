import assert from 'node:assert/strict';
import { spawn } from 'node:child_process';
import { existsSync, mkdirSync, utimesSync } from 'node:fs';
import { join } from 'node:path';
import { test } from 'node:test';
import { installsRoot, pruneInstalls } from '../src/installs.ts';
import { git } from '../src/proc.ts';
import { JOB_PID, uiDown, uiUp } from '../src/ui.ts';
import { makeRepo } from './helpers.ts';
import type { UiTarget } from '../src/profile.ts';

const target: UiTarget = { name: 'web', kind: 'web', paths: [], serve: 'sleep 300', ready: 'true', pages: [] } as unknown as UiTarget;

const alive = (pid: number) => { try { process.kill(pid, 0); return true; } catch { return false; } };

async function until(ok: () => boolean, ms = 8_000): Promise<boolean> {
  for (const end = Date.now() + ms; Date.now() < end; await new Promise((r) => setTimeout(r, 200))) if (ok()) return true;
  return ok();
}

/** Runs fn with ANIMUS_JOB_PID set as given (or unset), restoring it after. */
async function withJobPid<T>(pid: number | undefined, fn: () => Promise<T>): Promise<T> {
  const before = process.env[JOB_PID];
  if (pid === undefined) delete process.env[JOB_PID]; else process.env[JOB_PID] = String(pid);
  try { return await fn(); } finally { if (before === undefined) delete process.env[JOB_PID]; else process.env[JOB_PID] = before; }
}

test('what a job serves stops once the job\'s process is gone, however it ended', async () => {
  const repo = makeRepo();
  const job = spawn('sleep', ['300'], { stdio: 'ignore' });
  const up = await withJobPid(job.pid!, () => uiUp(repo, target));
  assert.ok(alive(up.pid));

  job.kill('SIGKILL');
  assert.ok(await until(() => !alive(up.pid)), 'the serve command outlived its job');
  assert.equal(existsSync(join(git(repo, ['rev-parse', '--absolute-git-dir']), 'animus-ui.json')), false);
});

test('outside a job nothing watches: what animus ui up starts runs until animus ui down', async () => {
  const repo = makeRepo();
  const up = await withJobPid(undefined, () => uiUp(repo, target));
  await new Promise((r) => setTimeout(r, 2_500));
  assert.ok(alive(up.pid));
  assert.equal(uiDown(repo), true);
  assert.ok(await until(() => !alive(up.pid)));
});

test('the install cache keeps the two saves used last and any used in the last hour, and drops abandoned partial saves', () => {
  const repo = makeRepo();
  const dir = join(installsRoot(repo), 'node_modules');
  const now = Date.now();
  // Minutes since each was last used.
  const ages: Record<string, number> = { a: 10, b: 20, c: 40, d: 120, e: 3000, 'f.tmp-1': 300, 'g.tmp-2': 5 };
  for (const [name, minutes] of Object.entries(ages)) {
    mkdirSync(join(dir, name), { recursive: true });
    const at = new Date(now - minutes * 60_000);
    utimesSync(join(dir, name), at, at);
  }
  assert.equal(pruneInstalls(repo, now), 3);
  assert.deepEqual(Object.keys(ages).filter((n) => existsSync(join(dir, n))), ['a', 'b', 'c', 'g.tmp-2']);
});
