import { strict as assert } from 'node:assert';
import { spawnSync } from 'node:child_process';
import { mkdtempSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { test } from 'node:test';
import { cli, fakeOpener } from './helpers.ts';
import { saveHelixLogin } from '../src/remote.ts';

function animus(args: string[], env: NodeJS.ProcessEnv) {
  const { HELIX_URL: _url, HELIX_TOKEN: _token, ...rest } = process.env;
  return spawnSync(process.execPath, ['--disable-warning=ExperimentalWarning', cli, ...args], { encoding: 'utf8', env: { ...rest, ...env } });
}

// Protects: animus ui --helix signs the browser in. Fails when: it opens Helix without the token, or with one the page cannot decode.
test('animus ui --helix opens the joined Helix with its token in the address', async () => {
  const home = mkdtempSync(join(tmpdir(), 'animus-home-'));
  saveHelixLogin({ url: 'http://helix.test:7420/', token: 'a b/+c', name: 'ajmal' }, join(home, 'helix.json'));
  const opener = fakeOpener();
  const r = animus(['ui', '--helix'], { ANIMUS_HOME: home, PATH: opener.path });
  assert.equal(r.status, 0, r.stderr);
  assert.equal(await opener.opened(), 'http://helix.test:7420/#token=a%20b%2F%2Bc');
  assert.doesNotMatch(r.stdout + r.stderr, /a b\/\+c|a%20b/, 'the token is not printed');
});

// Protects: a machine that has not joined is told how to. Fails when: it opens a broken address instead.
test('animus ui --helix on a machine that has not joined says so and opens nothing', async () => {
  const opener = fakeOpener();
  const r = animus(['ui', '--helix'], { ANIMUS_HOME: mkdtempSync(join(tmpdir(), 'animus-home-')), PATH: opener.path });
  assert.equal(r.status, 2);
  assert.match(r.stderr, /has not joined a Helix/);
  assert.equal(await opener.opened(), undefined);
});
