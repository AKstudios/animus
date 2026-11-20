import assert from 'node:assert/strict';
import test from 'node:test';
import { breakingOf, breakingRefusal, collect, cut, type Pull } from '../release-notes.ts';

const pulls: Record<number, Pull> = {
  1: { number: 1, title: 'Add a thing', body: 'Details.\n\n## Review here\n\nNothing.', url: 'https://x/pull/1' },
  2: { number: 2, title: 'Rename a field', body: 'Intro\n\n## Breaking\n\nThe field `a` is now `b`.\nRename it in your specs.\n\n## Review here\n\nx', url: 'https://x/pull/2' },
};
// A git that fails where real git does. release.ts's helper exits the process on any failure, so a
// failing call here throws an error collect() does not catch: a try/catch around git would not save it.
const fake = (log: string, tag = 'v0.1.0') => ({
  git: (...args: string[]) => {
    if (args[0] === 'tag') return tag;
    const range = args.find((a) => a.endsWith('..HEAD'));
    if (range && (!tag || range !== `${tag}..HEAD`)) throw new Error(`git log ${range}: unknown revision`);
    return log;
  },
  pull: (n: number) => pulls[n]!,
});
const LOG = 'Merge pull request #1 from a/b\nFix typo on main\nMerge pull request #2 from a/c';

// Protects: criterion 3. Fails when: breaking pull requests are not sorted first, a direct commit is dropped, or hand-written lines are lost.
test('writes the release from merged pull requests, breaking first, keeping hand-written lines', () => {
  const changelog = '# Changelog\n\nintro\n\n## Unreleased\n\n- Written by hand.\n\n## 0.1.0 (2026-01-01)\n\n- Old.\n';

  const out = cut(changelog, collect(fake(LOG)), '0.2.0', '2026-02-02');

  assert.equal(out, `# Changelog

intro

## Unreleased

## 0.2.0 (2026-02-02)

- Written by hand.
- **Breaking:** Rename a field ([#2](https://x/pull/2)): The field \`a\` is now \`b\`.
  Rename it in your specs.
- Add a thing ([#1](https://x/pull/1))
- Fix typo on main

## 0.1.0 (2026-01-01)

- Old.
`);
});

// Protects: criterion 4. Fails when: the release cannot tell which pull requests break something, so release.ts cannot refuse them.
test('names the pull requests that have a Breaking section, and none without one', () => {
  assert.deepEqual(collect(fake(LOG)).breaking.map((b) => b.pull.number), [2]);
  assert.deepEqual(collect(fake('Merge pull request #1 from a/b')).breaking, []);
});

test('counts every commit when there is no release tag yet', () => {
  assert.equal(collect(fake('Merge pull request #1 from a/b', '')).changes.length, 1);
});

// Protects: criterion 4 of the quick-to-read spec. Fails when: Breaking, placed above the folded blocks, is read to the end of the description or not found.
test('breakingOf stops at the next section or folded block', () => {
  assert.equal(breakingOf('s\n\n## Breaking\n\nA is now B.\n\n<details>\n<summary>Run</summary>\n\nx\n</details>\n'), 'A is now B.');
  assert.equal(breakingOf('s\n\n## Breaking\n\nA is now B.\n\n## Needs you\n\n- x\n\n<details>\n'), 'A is now B.');
});

test('breakingOf ignores an empty section', () => {
  assert.equal(breakingOf('## Breaking\n\n## Review here\n'), undefined);
});

// Fails when: a Breaking section saying only "None." (as PR 56's did) marks the pull request breaking.
test('breakingOf ignores a section that says only None', () => {
  assert.equal(breakingOf('## Breaking\n\nNone.\n\n## Review here\n'), undefined);
  assert.equal(breakingOf('## Breaking\n\nnone\n'), undefined);
  assert.equal(breakingOf('## Breaking\n\nNone of the old flags work.\n'), 'None of the old flags work.');
});

// Protects: criterion 3. Fails when: a `$` in a title is expanded as a replacement pattern, or an empty release is cut because older releases have bullets.
test('inserts titles literally, and refuses a release with nothing in it', () => {
  const changelog = '## Unreleased\n\n## 0.1.0 (2026-01-01)\n\n- Old.\n';
  const dollar = { git: () => 'Merge pull request #3 from a/d', pull: () => ({ number: 3, title: "Price in $$ and $' and $&", body: '', url: 'u' }) };

  assert.match(cut(changelog, collect(dollar), '0.2.0', 'd'), /^- Price in \$\$ and \$' and \$& \(\[#3\]\(u\)\)$/m);
  assert.throws(() => cut(changelog, { breaking: [], changes: [], direct: [] }, '0.2.0', 'd'), /nothing was merged/);
});

// Protects: criterion 4. Fails when: a breaking pull request, or an incompatible version, is released without --breaking.
test('refuses without --breaking, naming the pull requests', () => {
  const notes = collect(fake(LOG));
  const none = collect(fake('Merge pull request #1 from a/b'));

  assert.match(breakingRefusal(notes, '0.1.0', '0.1.1', false)!, /#2 Rename a field/);
  assert.match(breakingRefusal(none, '0.1.0', '0.2.0', false)!, /cannot work with 0\.1\.0/);
  assert.equal(breakingRefusal(notes, '0.1.0', '0.2.0', true), undefined);
  assert.equal(breakingRefusal(none, '0.1.0', '0.1.1', false), undefined);
});
