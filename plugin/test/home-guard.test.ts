import assert from 'node:assert/strict';
import { existsSync, mkdtempSync } from 'node:fs';
import { spawnSync } from 'node:child_process';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { test } from 'node:test';

const log = join(import.meta.dirname, '..', 'src', 'log.ts');
const personPage = join(import.meta.dirname, '..', '..', 'helix', 'test', 'person-page.test.ts');
const NODE = ['--disable-warning=ExperimentalWarning'];

/** A child of this test run, with the runner's own variables cleared and the given ones set. */
function child(args: string[], env: Record<string, string>, home = mkdtempSync(join(tmpdir(), 'guard-home-'))) {
  const base: NodeJS.ProcessEnv = { ...process.env, HOME: home, USERPROFILE: home };
  for (const name of Object.keys(base)) if (name.startsWith('NODE_TEST') || name === 'ANIMUS_HOME') delete base[name];
  return spawnSync(process.execPath, [...NODE, ...args], { env: { ...base, ...env }, encoding: 'utf8', timeout: 60_000 });
}
const ask = (env: Record<string, string>) => child(['-e', `import(${JSON.stringify(log)}).then((m) => console.log(m.animusHome()))`], env);

// Protects: a test run that never set ANIMUS_HOME cannot fall back to the real home. Fails when: animusHome answers ~/.animus under the test runner.
test('asking for the Animus home in a test run without ANIMUS_HOME fails naming it', () => {
  const r = ask({ NODE_TEST_CONTEXT: 'child-v8' });
  assert.notEqual(r.status, 0);
  assert.match(r.stderr, /ANIMUS_HOME/);
});

// Protects: the guard does not touch a run that set it, or a person's own use. Fails when: either throws.
test('answers as before outside a test run and in one that set ANIMUS_HOME', () => {
  assert.match(ask({}).stdout.trim(), /\.animus$/);
  assert.equal(ask({ NODE_TEST_CONTEXT: 'child-v8', ANIMUS_HOME: '/x/own' }).stdout.trim(), '/x/own');
});

// Protects: criterion 2. Fails when: the Helix person-page test leaves a .animus in the person's home.
test('the person page test alone, with no ANIMUS_HOME, leaves no .animus in HOME', () => {
  const home = mkdtempSync(join(tmpdir(), 'guard-home-'));
  const r = child(['--test', personPage], {}, home);
  assert.equal(r.status, 0, r.stdout + r.stderr);
  assert.equal(existsSync(join(home, '.animus')), false);
});
