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

const SPEC = parseSpec(`# Say done\n\n## Acceptance criteria\n\n1. It says done.\n   $ true\n2. ${'It is long. '.repeat(20)}\n   $ false\n3. A judged one.\n`);
const base = () => ({
  job: 'j', spec: SPEC, plan: resolvePlan(loadFactory(), SPEC), summary: 'It says done.', gates: [], gateAttempts: 1, fixRounds: 0, reviewRounds: 1, open: [],
  protectedTouched: [], escalations: [], models: 'fake', cost_usd: 0,
});
const gate = (criterion: number, ok: boolean, command: string) => ({ name: `c${criterion}`, command, ok, criterion, ms: 1000, output: 'raw output', skipped: false });

// Protects: criteria 3 and 4. Fails when: the Breaking section is missing or sinks below a folded block, or a block is not folded.
test('a pull request with a breaking report says it above every folded block', () => {
  const body = prBody({ ...base(), breaking: 'Profiles lose `x`.' });

  assert.ok(body.indexOf('## Breaking\n\nProfiles lose `x`.') > 0);
  assert.ok(body.indexOf('## Breaking') < body.indexOf('<details>'));
  for (const s of ['Evidence: the output of 0 checks', 'How it was built', 'Run', 'The spec this job ran from']) assert.match(body, new RegExp(`<details>\\n<summary>${s}|<details><summary>${s}`));
});

// Protects: criteria 1 and 2. Fails when: a needs-you item is missing, the table carries a command or a proof, or a long criterion fills more than a line.
test('the description opens with the summary and what needs the person, then one short line per criterion', () => {
  const finding = { severity: 'blocker' as const, problem: 'Wrong total', file: 'a.ts', line: 3 };
  const body = prBody({
    ...base(), gates: [gate(1, true, 'npm run proof-one'), gate(2, false, 'npm run proof-two')], open: [finding], protectedTouched: ['.github/ci.yml'],
    review: { status: 'reviewed', summary: 'ok', criteria: [{ criterion: 1, met: true, proof: 'PROOF-TEXT' }, { criterion: 2, met: false, proof: 'x' }], findings: [{ severity: 'should-fix', problem: 'Rename it', file: 'b.ts', line: 9 }, { severity: 'question', problem: 'Which one?', for_person: true }] },
  } as Parameters<typeof prBody>[0]);
  const top = body.slice(0, body.indexOf('<details>'));

  assert.match(top, /^It says done\.\n/);
  assert.match(top, /- 1 blocker still open: `a\.ts:3` Wrong total/);
  assert.match(top, /- The reviewer asks: Which one\?/);
  assert.match(top, /- Criterion 3 has no check: only the reviewer judged it/);
  assert.match(top, /- Should fix: `b\.ts:9` Rename it/);
  assert.match(top, /- Changes under protected paths: `\.github\/ci\.yml`/);
  assert.match(top, /\| 1 \| It says done\. \| passed \| met \|/);
  assert.match(top, /\| 2 \| It is long\..{0,90}… \| \*\*failed\*\* \| \*\*not met\*\* \|/);
  assert.match(top, /\| 3 \| A judged one\. \| none \| no verdict \|/);
  assert.doesNotMatch(top, /proof-one|PROOF-TEXT/);
  assert.match(body, /<details>\n<summary>Evidence: the output of 2 checks[^]*npm run proof-one[^]*PROOF-TEXT/);
});

// Protects: criterion 1. Fails when: blockers or unchecked criteria share one bullet, a failure lands in Needs you, or a multi-line problem breaks a bullet.
test('each open blocker and each unchecked criterion is its own line, and a failure stays out of Needs you', () => {
  const body = prBody({
    ...base(), failure: 'It broke\nin detail', open: [{ severity: 'blocker', problem: 'One\nsplit', file: 'a.ts', line: 1 }, { severity: 'blocker', problem: 'Two', file: 'b.ts', line: 2 }],
    spec: parseSpec('# T\n\n## Acceptance criteria\n\n1. A.\n2. B.\n'),
  } as Parameters<typeof prBody>[0]);
  const needs = body.slice(body.indexOf('## Needs you'), body.indexOf('## Acceptance criteria'));

  assert.deepEqual(needs.split('\n').filter((l) => l.startsWith('- ')), [
    '- Blocker still open: `a.ts:1` One split', '- Blocker still open: `b.ts:2` Two',
    '- Criterion 1 has no check: nothing checked it', '- Criterion 2 has no check: nothing checked it',
  ]);
  assert.doesNotMatch(needs, /in detail/);
});

// Protects: criterion 1. Fails when: an empty "Needs you" section is written.
test('there is no Needs you section when nothing needs the person', () => {
  assert.doesNotMatch(prBody({ ...base(), spec: parseSpec('# T\n\n## Acceptance criteria\n\n1. A.\n   $ true\n'), gates: [gate(1, true, 'true')] }), /Needs you/);
});

// Protects: criterion 2. Fails when: a skipped gate (ok: true, never run) makes its criterion read as passed.
test('a criterion whose only check was skipped has no check mark', () => {
  const body = prBody({ ...base(), gates: [{ ...gate(2, true, 'npm run skipped-one'), skipped: true }] });

  assert.match(body, /\| 2 \| It is long\..{0,90}… \| none \|/);
  assert.match(body, /2\. It is long[^]*Check: not run/);
  assert.doesNotMatch(body, /passed/);
});

// Protects: criterion 3. Fails when: a screenshot is shown outside its fold, or the heading lacks the count.
test('screenshots are inside a folded block that counts them', () => {
  const body = prBody({ ...base(), shots: { dir: '/d', files: ['a@390x844.png', 'b@1280x800.png'], urls: { 'a@390x844.png': 'https://x/a.png', 'b@1280x800.png': 'https://x/b.png' }, branch: 'ev' } });
  const open = body.indexOf('<summary>Screenshots (2)</summary>');

  assert.ok(open > 0);
  assert.ok(body.indexOf('https://x/a.png') > open && body.indexOf('https://x/b.png') < body.indexOf('</details>', open));
  assert.equal(body.indexOf('https://x/a.png'), body.lastIndexOf('https://x/a.png'));
  assert.doesNotMatch(body.slice(0, open), /https:\/\/x\//);
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
