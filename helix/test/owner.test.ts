import assert from 'node:assert/strict';
import { execFile } from 'node:child_process';
import { mkdtempSync, readFileSync } from 'node:fs';
import type { AddressInfo } from 'node:net';
import { tmpdir } from 'node:os';
import { dirname, join } from 'node:path';
import { test, type TestContext } from 'node:test';
import { fileURLToPath } from 'node:url';
import * as client from '../../plugin/src/remote.ts';
import { configFile, hashToken, saveConfig, type Config } from '../src/config.ts';
import { serve } from '../src/server.ts';
import { openStore } from '../src/store.ts';
import { supervise, type Launch } from '../src/supervisor.ts';
import { fakeTransport } from './fake-slack.ts';

const ROOT = join(dirname(fileURLToPath(import.meta.url)), '..', '..');
const HELIX = join(ROOT, 'helix', 'src', 'cli.ts');
const ANIMUS = join(ROOT, 'plugin', 'src', 'cli.ts');

/** Runs a command line the way a person would, with this test's Helix and the given env; never throws. */
function cli(file: string, args: string[], env: Record<string, string> = {}): Promise<{ code: number; out: string; err: string }> {
  return new Promise((resolve) => {
    execFile(process.execPath, ['--disable-warning=ExperimentalWarning', file, ...args], { env: { ...process.env, ...env } }, (err, out, stderr) => {
      resolve({ code: err ? Number((err as { code?: number }).code ?? 1) : 0, out, err: stderr });
    });
  });
}

/** A Helix with ajmal and ana on it, listening, its Slack bot a fake; config.yaml as given, plus its own url. Stopped when the test ends, passed or not. */
async function helix(t: TestContext, extra: Partial<Config> = {}) {
  const home = mkdtempSync(join(tmpdir(), 'helix-owner-'));
  process.env.HELIX_HOME = home;
  process.env.ANIMUS_HOME = join(home, 'client');
  delete process.env.HELIX_URL;
  delete process.env.HELIX_TOKEN;
  const store = openStore(join(home, 'helix.db'));
  store.putPerson('ajmal', { token_sha256: hashToken('ajmal-token') });
  store.putPerson('ana', { token_sha256: hashToken('ana-token') });
  const config: Config = { host: '127.0.0.1', port: 0, slots: 1, ...extra };
  const launch: Launch = () => ({ command: process.execPath, args: ['-e', 'setInterval(() => {}, 1000)'] });
  const supervisor = supervise({ store, config, home, launch });
  const slack = fakeTransport();
  const server = serve({ config, store, supervisor, slack: slack.transport });
  t.after(() => { supervisor.stop(); server.close(); store.close(); });
  await new Promise<void>((r) => { server.listen(0, '127.0.0.1', r); });
  const url = `http://127.0.0.1:${(server.address() as AddressInfo).port}`;
  config.url = url;
  saveConfig(config);
  const as = (person: string) => ({ HELIX_URL: url, HELIX_TOKEN: `${person}-token` });
  return { url, slack, as, store };
}

/** An invite's printout with what differs from one invite to the next taken out. */
const shape = (text: string, name: string) => text.replaceAll(name, 'NAME').replace(/[a-z2-9]{4}(-[a-z2-9]{4}){3}/g, 'CODE').replace(/\d{4}-\d\d-\d\d \d\d:\d\d/, 'WHEN');

// Protects: criterion 1, naming the owner. Fails when: helix owner writes no owner: to config.yaml, or names someone who is not on Helix.
test('helix owner <person> makes them the owner in config.yaml, and refuses someone not on Helix', async (t) => {
  await helix(t);

  const nobody = await cli(HELIX, ['owner', 'nobody']);
  const ajmal = await cli(HELIX, ['owner', 'ajmal']);

  assert.equal(nobody.code, 2);
  assert.match(nobody.err, /no person named nobody/);
  assert.equal(ajmal.code, 0, ajmal.err);
  assert.match(readFileSync(configFile(), 'utf8'), /^owner: ajmal$/m);
});

// Protects: criterion 1, the owner's invite from a laptop. Fails when: animus invite prints anything but helix invite's lines, or its code does not let the person in under the GitHub login given.
test('the owner\'s animus invite prints the same lines helix invite does, with a code that lets the person in', async (t) => {
  const h = await helix(t, { owner: 'ajmal' });

  const fromLaptop = await cli(ANIMUS, ['invite', 'sam', '--github', 'sam-gh'], h.as('ajmal'));
  const onMachine = await cli(HELIX, ['invite', 'cleo']);

  assert.equal(fromLaptop.code, 0, fromLaptop.err);
  assert.equal(shape(fromLaptop.out, 'sam'), shape(onMachine.out, 'cleo'));
  const code = new RegExp(`^  animus join ${h.url} (\\S+)$`, 'm').exec(fromLaptop.out)?.[1];
  assert.ok(code, fromLaptop.out);
  const details = await client.inviteDetails(h.url, code);
  assert.deepEqual([details.name, details.github], ['sam', 'sam-gh']);
});

// Protects: criterion 1, --slack from a laptop. Fails when: the invite is not DMed by Helix's Slack bot, or the printout is not helix invite --slack's.
test('the owner\'s animus invite --slack has Helix\'s Slack bot DM that user the join line', async (t) => {
  const h = await helix(t, { owner: 'ajmal' });

  const r = await cli(ANIMUS, ['invite', 'sam', '--github', 'sam-gh', '--slack', 'U123'], h.as('ajmal'));

  assert.equal(r.code, 0, r.err);
  assert.match(r.out, /^The Slack bot sent U123 the line that installs Animus and joins as sam; its code is good until \d{4}-\d\d-\d\d \d\d:\d\d UTC\.$/m);
  assert.deepEqual(h.slack.sent[0], { method: 'dm', user: 'U123' });
  assert.match((h.slack.sent[1] as { text: string }).text, new RegExp(`join ${h.url} [a-z2-9-]{19}`));
});

// Protects: criterion 1, the refusal. Fails when: someone but the owner can invite, or the refusal does not say who the owner is.
for (const [who, owner, said] of [
  ['ana', 'ajmal', /only the owner, ajmal, may invite people/],
  ['ajmal', undefined, /no owner: helix owner <person> on the machine/],
] as const) {
  test(`animus invite from ${who} with ${owner ?? 'no'} owner is refused`, async (t) => {
    const h = await helix(t, owner ? { owner } : {});

    const r = await cli(ANIMUS, ['invite', 'sam', '--github', 'sam-gh'], h.as(who));

    assert.equal(r.code, 2);
    assert.match(r.err, said);
    assert.doesNotMatch(r.out, /animus join/);
  });
}

// Protects: criterion 2, the owner removes a person from a laptop. Fails when: animus remove-person does not take the person off, or prints anything but helix remove-person's checklist.
test('the owner\'s animus remove-person takes the person off and prints the checklist helix remove-person does', async (t) => {
  const h = await helix(t, { owner: 'ajmal' });
  h.store.putPerson('sam', { token_sha256: hashToken('sam-token') });
  h.store.putPerson('cleo', { token_sha256: hashToken('cleo-token') });

  const fromLaptop = await cli(ANIMUS, ['remove-person', 'sam'], h.as('ajmal'));
  const onMachine = await cli(HELIX, ['remove-person', 'cleo']);

  assert.equal(fromLaptop.code, 0, fromLaptop.err);
  assert.equal(onMachine.code, 0, onMachine.err);
  assert.equal(fromLaptop.out.replaceAll('sam', 'NAME'), onMachine.out.replaceAll('cleo', 'NAME'));
  assert.match(fromLaptop.out, /Left to do elsewhere:/);
  assert.equal(h.store.person('sam'), undefined);
});

// Protects: criterion 2, the refusal. Fails when: someone but the owner can remove a person.
test('animus remove-person from someone but the owner is refused, and the person stays', async (t) => {
  const h = await helix(t, { owner: 'ajmal' });
  h.store.putPerson('sam', { token_sha256: hashToken('sam-token') });

  const r = await cli(ANIMUS, ['remove-person', 'sam'], h.as('ana'));

  assert.equal(r.code, 2);
  assert.match(r.err, /only the owner, ajmal, may remove people/);
  assert.ok(h.store.person('sam'));
});

// Protects: criterion 5, the owner stays. Fails when: any path takes the owner off Helix, leaving it with nobody who may invite.
for (const [what, file, args, as] of [
  ['animus leave from the owner', ANIMUS, ['leave', '--yes'], 'ajmal'],
  ['animus remove-person of the owner', ANIMUS, ['remove-person', 'ajmal'], 'ajmal'],
  ['helix remove-person of the owner', HELIX, ['remove-person', 'ajmal'], undefined],
] as const) {
  test(`${what} is refused until another owner is named`, async (t) => {
    const h = await helix(t, { owner: 'ajmal' });

    const r = await cli(file, [...args], as ? h.as(as) : {});

    assert.equal(r.code, 2);
    assert.match(r.err, /name another owner first: helix owner <person> on the machine/);
    assert.ok(h.store.person('ajmal'));
  });
}
