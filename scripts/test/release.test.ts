import assert from 'node:assert/strict';
import test from 'node:test';
import { breakingOf, breakingRefusal, collect, cut, type Pull } from '../release-notes.ts';

const pulls: Record<number, Pull> = {
  1: { number: 1, title: 'Add a thing', body: 'Details.\n\n## Review here\n\nNothing.', url: 'https://x/pull/1' },
  2: { number: 2, title: 'Rename a field', body: 'Intro\n\n## Breaking\n\nThe field `a` is now `b`.\nRename it in your specs.\n\n## Review here\n\nx', url: 'https://x/pull/2' },
};
const fake = (log: string, tag = 'v0.1.0') => ({
  git: (...args: string[]) => {
    // Like release.ts's helper, which exits on any git failure: a command that would fail has no answer here.
    if (args[0] === 'describe') throw new Error('git describe fails when there is no tag');
    if (args[0] === 'tag') return tag;
    assert.deepEqual(args.slice(-1), tag ? [`${tag}..HEAD`] : ['--format=%s']);
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

test('breakingOf ignores an empty section', () => {
  assert.equal(breakingOf('## Breaking\n\n## Review here\n'), undefined);
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
