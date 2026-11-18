import assert from 'node:assert/strict';
import { mkdirSync, mkdtempSync } from 'node:fs';
import type { AddressInfo } from 'node:net';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { test } from 'node:test';
import * as client from '../../plugin/src/remote.ts';
import { hashToken, type Config } from '../src/config.ts';
import { serve } from '../src/server.ts';
import { openStore } from '../src/store.ts';
import { supervise } from '../src/supervisor.ts';

const SPEC = '---\nsize: small\n---\n# Links\n\n## Acceptance criteria\n\n1. It works.\n';

async function helix(links: Pick<Config, 'url' | 'lan_url'>) {
  const home = mkdtempSync(join(tmpdir(), 'helix-'));
  const repo = join(home, 'repo');
  mkdirSync(repo);
  const config: Config = { host: '127.0.0.1', port: 0, slots: 1, ...links };
  const store = openStore(join(home, 'helix.db'));
  store.putPerson('ana', { token_sha256: hashToken('ana-token') });
  store.putProject({ name: 'app', url: 'https://github.com/o/app.git', dir: repo, state: 'ready', added: '' });
  // Never started: the job stays queued, which is all these tests need.
  const supervisor = supervise({ store, config, home, launch: () => ({ command: process.execPath, args: ['-e', 'setTimeout(()=>{},60000)'] }) });
  const server = serve({ config, store, supervisor });
  await new Promise<void>((r) => { server.listen(0, '127.0.0.1', r); });
  process.env.HELIX_URL = `http://127.0.0.1:${(server.address() as AddressInfo).port}`;
  process.env.HELIX_TOKEN = 'ana-token';
  return { stop: () => { supervisor.stop(); server.close(); store.close(); } };
}

// Protects: submit and status both name the job's page at each address Helix has, without a token. Fails when: a link is missing, mislabelled, doubles a trailing slash, or carries the token.
test('submit and status give the job page on Tailscale and the office network', async () => {
  const h = await helix({ url: 'https://helix.tail.ts.net/', lan_url: 'http://10.0.0.5:7777' });
  const job = await client.submit({ repo: 'app', spec: SPEC, name: 'spec.md' });
  const links = [`Tailscale: https://helix.tail.ts.net/jobs/${job.id}`, `office network: http://10.0.0.5:7777/jobs/${job.id}`];

  assert.deepEqual(job.links, links);
  assert.deepEqual((await client.job(String(job.id))).links, links);
  const shown = client.describeJob(await client.job(String(job.id)));
  assert.match(shown, new RegExp(`watch it:\\n {4}${links[0]!.replace(/[.\/]/g, '\\$&')}\\n {4}`));
  assert.doesNotMatch(JSON.stringify(job.links), /ana-token|token/);
  h.stop();
});

// Protects: only the addresses Helix has are named. Fails when: an unset address prints as "undefined" or an empty link.
test('a Helix with only lan_url gives only the office network link; one with neither gives none', async () => {
  const lan = await helix({ lan_url: 'http://10.0.0.5:7777' });
  const a = await client.submit({ repo: 'app', spec: SPEC, name: 'spec.md' });
  assert.deepEqual(a.links, [`office network: http://10.0.0.5:7777/jobs/${a.id}`]);
  lan.stop();

  const bare = await helix({});
  const b = await client.submit({ repo: 'app', spec: SPEC, name: 'spec.md' });
  assert.deepEqual(b.links, []);
  assert.doesNotMatch(client.describeJob(await client.job(String(b.id))), /watch it/);
  bare.stop();
});
