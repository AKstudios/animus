import { strict as assert } from 'node:assert';
import { spawn, spawnSync } from 'node:child_process';
import { mkdtempSync, writeFileSync } from 'node:fs';
import http from 'node:http';
import type { AddressInfo } from 'node:net';
import { once } from 'node:events';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { test } from 'node:test';
import { cli, fakeOpener } from './helpers.ts';
import { saveHelixLogin } from '../src/remote.ts';
import { claimLocal, localServer } from '../src/local-display.ts';
import { animusHome } from '../src/log.ts';
import { animusVersion } from '../src/version.ts';

function animus(args: string[], env: NodeJS.ProcessEnv) {
  const { HELIX_URL: _url, HELIX_TOKEN: _token, ...rest } = process.env;
  return spawnSync(process.execPath, ['--disable-warning=ExperimentalWarning', cli, ...args], { encoding: 'utf8', env: { ...rest, ...env } });
}

// Protects: animus ui --helix opens the joined Helix, whose display needs no sign-in. Fails when: the token goes into the address or is printed.
test('animus ui --helix opens the joined Helix with no token in the address', async () => {
  const home = mkdtempSync(join(tmpdir(), 'animus-home-'));
  saveHelixLogin({ url: 'http://helix.test:7420/', token: 'a b/+c', name: 'ajmal' }, join(home, 'helix.json'));
  const opener = fakeOpener();
  const r = animus(['ui', '--helix'], { ANIMUS_HOME: home, PATH: opener.path });
  assert.equal(r.status, 0, r.stderr);
  assert.equal(await opener.opened(), 'http://helix.test:7420/');
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

/** A server answering every request with this body, on a free port. */
const fake = (body: unknown) => new Promise<http.Server>((r) => {
  const server = http.createServer((_q, res) => { res.end(JSON.stringify(body)); });
  server.listen(0, '127.0.0.1', () => { portOf(server); r(server); });
});
const ports = new WeakMap<http.Server, number>();
const portOf = (s: http.Server) => ports.get(s) ?? (ports.set(s, (s.address() as AddressInfo).port), ports.get(s)!);
const shows = (over: object) => ({ local: true, jobs: [], ...over });
const warnings: string[] = [];
const claim = (port: number) => claimLocal(localServer(), port, (m) => warnings.push(m));

// Protects: criterion 5, the same version is reused. Fails when: a second display starts beside it.
test('animus ui reuses a display of the same version', async () => {
  const same = await fake(shows({ version: animusVersion(), pid: 1 }));
  assert.deepEqual(await claim(portOf(same)), { port: portOf(same), reused: true });
  same.close();
});

// Protects: criterion 5, an older display that names its process id is stopped. Fails when: it is left holding the port, or a process that did not note itself is killed.
test('animus ui stops an older display that answers with its own process id, and takes its port', async () => {
  const child = spawn(process.execPath, ['-e', "const s=require('http').createServer((q,r)=>r.end(JSON.stringify({local:true,jobs:[],version:'0.0.1',pid:process.pid}))).listen(0,'127.0.0.1',()=>console.log(process.pid+' '+s.address().port))"], { stdio: ['ignore', 'pipe', 'ignore'] });
  const [pid, port] = String(await once(child.stdout!, 'data').then(([b]) => b)).trim().split(' ').map(Number) as [number, number];
  writeFileSync(join(animusHome(), `ui-${port}.json`), JSON.stringify({ pid }));
  // Listened for before the claim: the child can exit while the claim still waits for the port.
  const exited = once(child, 'exit');
  const server = localServer();
  const took = await claimLocal(server, port, (m) => warnings.push(m));
  server.close();
  assert.deepEqual([took, (await exited)[1]], [{ port, reused: false }, 'SIGTERM']);
});

// Protects: criterion 5, a process id nobody noted is not killed. Fails when: it stops whatever a display says its pid is.
test('animus ui does not stop an older display whose process id it did not note', async () => {
  const stranger = await fake(shows({ version: '0.0.1', pid: process.pid }));
  const took = await claim(portOf(stranger));
  stranger.close();
  assert.equal(took.port > portOf(stranger), true);
});

// Protects: criterion 5, a display with no version is warned of. Fails when: it is passed over without a word.
test('animus ui warns of a display that reports no version, and starts on the next port', async () => {
  const bare = await fake(shows({}));
  const took = await claim(portOf(bare));
  bare.close();
  assert.deepEqual([took.port > portOf(bare), warnings.at(-1)], [true, `An older Animus display is on 127.0.0.1:${portOf(bare)}; stop it (it was started before ${animusVersion()})`]);
});

// Protects: criterion 5, another program is passed over as before. Fails when: it is warned of as a display or its port is taken from it.
test('animus ui moves past another program on the port without a warning', async () => {
  const before = warnings.length;
  const other = await fake({ hello: 'world' });
  const took = await claim(portOf(other));
  other.close();
  assert.deepEqual([took.port > portOf(other), warnings.length], [true, before]);
});
