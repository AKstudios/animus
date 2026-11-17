import assert from 'node:assert/strict';
import { chmodSync, mkdtempSync, readFileSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { delimiter, join } from 'node:path';
import { test } from 'node:test';
import { publish } from '../src/pr.ts';
import { git } from '../src/proc.ts';
import { makeRepo } from './helpers.ts';

/** A repo with an origin to push to, and a `gh` on PATH that says whether the branch's PR is a draft and records every call. */
function setup(open: 'draft' | 'ready' | 'none') {
  const repo = makeRepo();
  const origin = mkdtempSync(join(tmpdir(), 'animus-origin-'));
  git(origin, ['init', '-q', '--bare']);
  git(repo, ['remote', 'add', 'origin', origin]);
  const bin = mkdtempSync(join(tmpdir(), 'animus-gh-'));
  const log = join(bin, 'calls.txt');
  writeFileSync(join(bin, 'gh'), `#!/bin/sh
echo "$*" >> "${log}"
# Read what Animus pipes in, as gh does: exiting with it unread breaks the pipe under load.
case " $* " in *" - "*) cat >/dev/null ;; esac
case "$1 $2" in
  "pr view") ${open === 'none' ? 'exit 1' : `echo "https://example.test/pr/7 ${open === 'draft'}"`} ;;
  "pr create") echo https://example.test/pr/8 ;;
esac
`);
  chmodSync(join(bin, 'gh'), 0o755);
  process.env.PATH = `${bin}${delimiter}${process.env.PATH}`;
  const calls = () => readFileSync(log, 'utf8').trim().split('\n').slice(1);
  return { repo, calls };
}

const input = (repo: string, draft: boolean) => ({ cwd: repo, branch: 'main', baseBranch: 'main', title: 't', body: 'b', draft });

test('a finished job marks the draft pull request an earlier failed attempt left as ready for review', () => {
  const { repo, calls } = setup('draft');
  assert.equal(publish(input(repo, false)), 'https://example.test/pr/7');
  assert.deepEqual(calls(), ['pr edit main --body-file -', 'pr ready main']);
});

test('a failed job turns its open, ready pull request back into a draft', () => {
  const { repo, calls } = setup('ready');
  publish(input(repo, true));
  assert.deepEqual(calls(), ['pr edit main --body-file -', 'pr ready main --undo']);
});

test('an open pull request already in the right state is only updated', () => {
  const { repo, calls } = setup('ready');
  publish(input(repo, false));
  assert.deepEqual(calls(), ['pr edit main --body-file -']);
});
