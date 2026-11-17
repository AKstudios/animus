import { strict as assert } from 'node:assert';
import { spawnSync } from 'node:child_process';
import { chmodSync, existsSync, mkdtempSync, readFileSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { delimiter, join } from 'node:path';
import { setTimeout as sleep } from 'node:timers/promises';
import { test } from 'node:test';
import './helpers.ts';
import { saveHelixLogin } from '../src/remote.ts';

const cli = join(import.meta.dirname, '..', 'src', 'cli.ts');

/** The system's opener, faked: `open` and `xdg-open` on PATH that write down the address they were given. */
function fakeOpener(): { path: string; opened: () => Promise<string | undefined> } {
  const bin = mkdtempSync(join(tmpdir(), 'animus-opener-'));
  const out = join(bin, 'opened.txt');
  for (const name of ['open', 'xdg-open']) {
    writeFileSync(join(bin, name), `#!/bin/sh\nprintf '%s' "$1" > "${out}"\n`);
    chmodSync(join(bin, name), 0o755);
  }
  return {
    path: `${bin}${delimiter}${process.env.PATH}`,
    // The opener runs detached, so it may write after animus has exited.
    opened: async () => {
      for (let i = 0; i < 20 && !existsSync(out); i++) await sleep(50);
      return existsSync(out) ? readFileSync(out, 'utf8') : undefined;
    },
  };
}

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
