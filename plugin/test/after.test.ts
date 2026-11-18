import assert from 'node:assert/strict';
import { test } from 'node:test';
import { waitForMerged } from '../src/after.ts';
import type { PrFind } from '../src/pr.ts';
import { mkdtempSync, mkdirSync, readFileSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { appendRun, type Run } from '../src/log.ts';
import { writeSpec } from './helpers.ts';

const TITLE = 'Say done';
const run = (file: string, find: PrFind, sleeps: { n: number }, stop?: () => void) => {
  const lines: string[] = [];
  const done = waitForMerged({
    repo: '/repo', files: [file], lookup: () => undefined, find, log: (l) => lines.push(l),
    sleep: async () => { sleeps.n += 1; stop?.(); },
  });
  return { lines, done };
};

test('starts at once when GitHub has a merged pull request titled as the earlier spec and the run log has none', async () => {
  const asked: string[] = [];
  const sleeps = { n: 0 };
  const { done } = run(writeSpec('size: small'), (title) => { asked.push(title); return { url: 'https://example.test/pr/9', state: 'MERGED' }; }, sleeps);
  await done;
  assert.deepEqual([asked, sleeps.n], [[TITLE], 0]);
});

test('fails naming a pull request GitHub has closed unmerged, and keeps waiting on an open one', async () => {
  const file = writeSpec('size: small');
  await assert.rejects(run(file, () => ({ url: 'https://example.test/pr/3', state: 'CLOSED' }), { n: 0 }).done, /whose pull request https:\/\/example\.test\/pr\/3 was closed without merging/);

  const states = ['OPEN', 'MERGED'] as const;
  let i = 0;
  const sleeps = { n: 0 };
  const { lines, done } = run(file, () => ({ url: 'https://example.test/pr/4', state: states[i++]! }), sleeps);
  await done;
  assert.equal(sleeps.n, 1);
  assert.match(lines.join('\n'), /waiting: .*https:\/\/example\.test\/pr\/4 is open/);
});

test('says it found nothing in the run log or on GitHub, names the title, and how to stop waiting', async () => {
  const results = [undefined, { url: 'https://example.test/pr/5', state: 'MERGED' as const }];
  let i = 0;
  const { lines, done } = run(writeSpec('size: small'), () => results[i++], { n: 0 });
  await done;
  assert.match(lines[0]!, /run log has no pull request for it and GitHub has none titled "Say done"\. Remove the `after:` line or cancel the job/);
});

test('keeps waiting on an earlier spec it cannot read, names it and why, and reads it again once fixed', async () => {
  const good = writeSpec('size: small');
  const file = writeSpec('size: small', 'no criteria here\n');
  const asked: string[] = [];
  const sleeps = { n: 0 };
  const { lines, done } = run(file, (title) => { asked.push(title); return { url: 'https://example.test/pr/6', state: 'MERGED' }; }, sleeps, () => { writeFileSync(file, readFileSync(good, 'utf8')); });
  await done;
  assert.match(lines[0]!, new RegExp(`waiting: .*${file.replace(/\W/g, '.')} could not be read.*acceptance criteria`, 'i'));
  assert.deepEqual([asked, sleeps.n], [[TITLE], 1]);
});

test('lets a logged pull request through without reading the earlier spec', async () => {
  // A directory where the spec should be: reading it throws a plain error, which would end the wait, so passing shows it was never read.
  const file = join(mkdtempSync(join(tmpdir(), 'animus-after-')), 'spec.md');
  mkdirSync(file);
  appendRun({ job: 'j', repo: '/repo', spec_file: file, pr: 'https://example.test/pr/8' } as Run);
  const sleeps = { n: 0 };
  const lines: string[] = [];
  await waitForMerged({ repo: '/repo', files: [file], lookup: () => 'MERGED', find: () => { throw new Error('not asked'); }, log: (l) => lines.push(l), sleep: async () => { sleeps.n += 1; } });
  assert.deepEqual([sleeps.n, lines.length], [0, 1]);
});
