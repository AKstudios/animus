import assert from 'node:assert/strict';
import { mkdtempSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { test } from 'node:test';
import { openStore, type Upgrade } from '../src/store.ts';
import { releaseToFollow } from '../src/upgrade.ts';

const none = () => undefined;

test('follow moves to the release stable is at', () => {
  assert.deepEqual(releaseToFollow({ head: 'a', stable: 'b', tags: ['v0.3.4'], last: none }), { tag: 'v0.3.4' });
});

test('follow stays when stable is the commit checked out', () => {
  const to = releaseToFollow({ head: 'b', stable: 'b', tags: ['v0.3.4'], last: none });
  assert.deepEqual(to, { stay: 'already on v0.3.4' });
});

test('follow picks the newest release tag at stable and ignores other tags', () => {
  assert.deepEqual(releaseToFollow({ head: 'a', stable: 'b', tags: ['v0.3.9', 'nightly', 'v0.3.10', 'v1.0.0-rc1'], last: none }), { tag: 'v0.3.10' });
});

test('follow stays when stable is missing or not at a release', () => {
  assert.match((releaseToFollow({ head: 'a', tags: [] }) as { stay: string }).stay, /no stable branch/);
  assert.match((releaseToFollow({ head: 'a', stable: 'b', tags: ['nightly'] }) as { stay: string }).stay, /not at a release tag/);
});

test('follow does not try again a release that failed here, but does one that went on', () => {
  const failed: Upgrade = { tag: 'v0.3.4', at: '2026-11-17T10:00:00Z', ok: false, detail: 'tests failed' };
  const to = releaseToFollow({ head: 'a', stable: 'b', tags: ['v0.3.4'], last: () => failed });
  assert.ok('stay' in to);
  assert.match(to.stay, /v0\.3\.4 failed here .*tests failed.*helix upgrade v0\.3\.4/);
  // Moved back to an earlier release by hand, the one that went on is followed again.
  assert.deepEqual(releaseToFollow({ head: 'a', stable: 'b', tags: ['v0.3.4'], last: () => ({ ...failed, ok: true }) }), { tag: 'v0.3.4' });
});

test('helix.db keeps the last try at each release', () => {
  const store = openStore(join(mkdtempSync(join(tmpdir(), 'helix-upgrade-')), 'helix.db'));
  assert.equal(store.upgrade('v0.3.4'), undefined);
  store.putUpgrade({ tag: 'v0.3.4', at: '1', ok: false, detail: 'tests failed' });
  store.putUpgrade({ tag: 'v0.3.4', at: '2', ok: true });
  assert.deepEqual(store.upgrade('v0.3.4'), { tag: 'v0.3.4', at: '2', ok: true });
  store.close();
});
