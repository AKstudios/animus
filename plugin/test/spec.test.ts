import assert from 'node:assert/strict';
import { test } from 'node:test';
import { parseSpec } from '../src/spec.ts';
import { AnimusError } from '../src/proc.ts';

const body = `# Sort the list

Why.

## Acceptance criteria

1. Items sort by aisle.
   \`$ npx vitest run src/shop.test.js\`
2. An empty list shows a hint,
   on every screen size.
- [ ] Nothing else changes.
  - $ npm test

## Out of scope

- Not this.
`;

test('a spec reads its labels from the header and its title from the first heading', () => {
  const spec = parseSpec(`---\nsize: small\ndifficulty: hard\ntype: ui\nui: { target: app, pages: [home] }\ndesign: design/shop.png\n---\n${body}`);
  assert.equal(spec.title, 'Sort the list');
  assert.deepEqual([spec.size, spec.difficulty, spec.type], ['small', 'hard', 'ui']);
  assert.deepEqual(spec.ui, { target: 'app', pages: ['home'] });
  assert.deepEqual(spec.design, ['design/shop.png']);
  assert.deepEqual(spec.defaulted, []);
});

test('each list item under the heading is a criterion, with the $ lines under it as its checks', () => {
  const spec = parseSpec(body);
  assert.deepEqual(spec.criteria, [
    { text: 'Items sort by aisle.', commands: ['npx vitest run src/shop.test.js'] },
    { text: 'An empty list shows a hint, on every screen size.', commands: [] },
    { text: 'Nothing else changes.', commands: ['npm test'] },
  ]);
});

test('a spec without labels gets medium, routine, feature and says so', () => {
  const spec = parseSpec(body);
  assert.deepEqual([spec.size, spec.difficulty, spec.type], ['medium', 'routine', 'feature']);
  assert.deepEqual(spec.defaulted, ['size', 'difficulty', 'type']);
});

test('a spec with a wrong label or no criteria is refused', () => {
  assert.throws(() => parseSpec(`---\nsize: huge\n---\n${body}`), AnimusError);
  assert.throws(() => parseSpec('# Title\n\nJust prose.\n'), /Acceptance criteria/);
});
