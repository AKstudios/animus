import assert from 'node:assert/strict';
import { chmodSync, mkdtempSync, readFileSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { delimiter, join } from 'node:path';
import { test } from 'node:test';
import { prBody, publish } from '../src/pr.ts';
import { loadFactory, resolvePlan } from '../src/profiles.ts';
import { parseSpec } from '../src/spec.ts';
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
echo "$GH_TOKEN" >> "${log}.tokens"
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
  const tokens = () => readFileSync(`${log}.tokens`, 'utf8').trim().split('\n');
  return { repo, calls, tokens };
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

// Protects: a Helix job whose GitHub token was renewed while it ran. Fails when: gh is called with the token the job started with rather than the one in its live token file now.
test('on Helix, each gh call uses the token in the live token file as it is at that moment', (t) => {
  const { repo, tokens } = setup('none');
  const live = join(mkdtempSync(join(tmpdir(), 'animus-live-')), 'gh-token');
  writeFileSync(live, 'ghu_renewed\n');
  const before = { file: process.env.ANIMUS_GH_TOKEN_FILE, token: process.env.GH_TOKEN };
  process.env.ANIMUS_GH_TOKEN_FILE = live;
  process.env.GH_TOKEN = 'ghu_from_the_start';
  t.after(() => {
    if (before.file === undefined) delete process.env.ANIMUS_GH_TOKEN_FILE; else process.env.ANIMUS_GH_TOKEN_FILE = before.file;
    if (before.token === undefined) delete process.env.GH_TOKEN; else process.env.GH_TOKEN = before.token;
  });

  publish(input(repo, false));

  assert.deepEqual([...new Set(tokens())], ['ghu_renewed']);
});

// Protects: criterion 2. Fails when: the Breaking section is missing or sinks below the review notes.
test('a pull request with a breaking report says it under Breaking, above Review here', () => {
  const spec = parseSpec('# Say done\n\n## Acceptance criteria\n\n1. It says done.\n   $ true\n');
  const body = prBody({
    job: 'j', spec, plan: resolvePlan(loadFactory(), spec), summary: 's', gates: [], gateAttempts: 1, fixRounds: 0, reviewRounds: 0, open: [],
    protectedTouched: [], escalations: [], models: 'fake', cost_usd: 0, breaking: 'Profiles lose `x`.',
  });

  assert.ok(body.indexOf('## Breaking\n\nProfiles lose `x`.') > 0 && body.indexOf('## Breaking') < body.indexOf('## Review here'));
});

// Protects: criterion 9 of the admit spec. Fails when: issue_link: refs is ignored and merging the PR closes an issue a person wanted to close, or the default stops closing.
test('a pull request names its issue as Refs when the profile says refs, as Closes otherwise', () => {
  const spec = parseSpec('# Say done\n\n## Acceptance criteria\n\n1. It says done.\n   $ true\n');
  const body = (issueLink?: 'closes' | 'refs') => prBody({
    job: 'j', spec, plan: resolvePlan(loadFactory(), spec), summary: 's', gates: [], gateAttempts: 1, fixRounds: 0, reviewRounds: 0, open: [],
    protectedTouched: [], escalations: [], models: 'fake', cost_usd: 0, closes: 7, ...(issueLink ? { issueLink } : {}),
  });

  assert.match(body('refs'), /^Refs #7$/m);
  assert.doesNotMatch(body('refs'), /Closes #7/);
  assert.match(body(), /^Closes #7$/m);
});
