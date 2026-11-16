import assert from 'node:assert/strict';
import { mkdtempSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { test } from 'node:test';
import { gitFindings, orbitMarketplace } from '../src/doctor.ts';
import { atLeast, compatible } from '../src/version.ts';
import { write } from './helpers.ts';

test('a client and Helix work together on the same major version, and before 1.0 on the same minor', () => {
  const table: [string, string, boolean][] = [
    ['0.3.0', '0.3.4', true], ['0.3.0', '0.4.0', false], ['1.2.0', '1.9.1', true], ['1.0.0', '2.0.0', false], ['0.3.0', 'unknown', false],
  ];
  for (const [a, b, ok] of table) assert.equal(compatible(a, b), ok, `${a} with ${b}`);
});

test('a Claude Code version is compared number by number, not as text', () => {
  assert.equal(atLeast('2.1.322 (Claude Code)', '2.1.322'), true);
  assert.equal(atLeast('2.1.99 (Claude Code)', '2.1.322'), false);
  assert.equal(atLeast('2.10.0', '2.9.400'), true);
  assert.equal(atLeast('not a version', '2.1.322'), false);
});

test('doctor finds orbit\'s marketplace registered under Animus\'s name, and not Animus\'s own', () => {
  const dir = mkdtempSync(join(tmpdir(), 'claude-'));
  const known = (entry: unknown) => write(dir, 'plugins/known_marketplaces.json', JSON.stringify({ animus: entry }));
  known({ source: { source: 'github', repo: 'ajmalali/orbit' } });
  assert.match(orbitMarketplace(dir)!, /orbit/);
  const animus = mkdtempSync(join(tmpdir(), 'animus-'));
  write(animus, 'plugin/src/slices.ts', '');
  known({ source: { source: 'github', repo: 'AKstudios/animus' }, installLocation: animus });
  assert.equal(orbitMarketplace(dir), undefined);
  assert.equal(orbitMarketplace(mkdtempSync(join(tmpdir(), 'none-'))), undefined);
});

test('doctor warns about git hooks and commit signing of the person\'s that would reach a job\'s commits', () => {
  const config: Record<string, string> = { 'core.hooksPath': '~/.githooks', 'commit.gpgsign': 'true' };
  assert.deepEqual(gitFindings((k) => config[k] ?? '').map((f) => [f.level, f.what]), [['warn', 'git hooks'], ['warn', 'commit signing']]);
  assert.deepEqual(gitFindings(() => ''), []);
});
