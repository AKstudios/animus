import assert from 'node:assert/strict';
import { execFile } from 'node:child_process';
import { existsSync, mkdtempSync, readFileSync } from 'node:fs';
import type { AddressInfo } from 'node:net';
import { tmpdir } from 'node:os';
import { dirname, join } from 'node:path';
import { test, type TestContext } from 'node:test';
import { fileURLToPath } from 'node:url';
import { parse } from 'yaml';
import * as client from '../../plugin/src/remote.ts';
import { configFile, hashToken, saveConfig, updateConfig, type Config } from '../src/config.ts';
import { moveSlackOwner } from '../src/owner.ts';
import { serve } from '../src/server.ts';
import { slackEnvFile, slackSetup } from '../src/slack-api.ts';
import { openStore } from '../src/store.ts';
import { supervise, type Launch } from '../src/supervisor.ts';
import { fakeSlack, fakeTransport } from './fake-slack.ts';

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

/** A job of the person's for the project, queued and never started: the test supervisor is not woken for it. */
const queue = (store: ReturnType<typeof openStore>, person: string, repo: string) => store.add({ state: 'queued', person, repo, spec: '', title: `${person}'s job`, draft: false, submitted: new Date().toISOString() });
const project = (store: ReturnType<typeof openStore>, name: string, added_by?: string) => store.putProject({ name, url: `https://github.com/o/${name}.git`, dir: join(tmpdir(), 'nowhere', name), state: 'ready', added: '', ...(added_by ? { added_by } : {}) });

// Protects: criterion 3, the owner removes any project. Fails when: the owner is refused a project someone else, or the machine, added.
for (const added_by of ['ana', undefined]) {
  test(`the owner's animus project remove removes a project added ${added_by ? `by ${added_by}` : 'on the machine'}`, async (t) => {
    const h = await helix(t, { owner: 'ajmal' });
    project(h.store, 'app', added_by);

    const r = await cli(ANIMUS, ['project', 'remove', 'app'], h.as('ajmal'));

    assert.equal(r.code, 0, r.err);
    assert.equal(h.store.project('app'), undefined);
  });
}

// Protects: criterion 3, the rule still holds for the owner. Fails when: the owner removes a project with a job queued for it.
test('the owner\'s animus project remove is refused while one of its jobs is queued', async (t) => {
  const h = await helix(t, { owner: 'ajmal' });
  project(h.store, 'app', 'ana');
  const job = queue(h.store, 'ana', 'app');

  const r = await cli(ANIMUS, ['project', 'remove', 'app'], h.as('ajmal'));

  assert.equal(r.code, 2);
  assert.match(r.err, new RegExp(`job\\(s\\) ${job.id} are queued or running for app`));
  assert.ok(h.store.project('app'));
});

// Protects: criterion 4, the owner cancels anyone's job. Fails when: cancel is refused for a job the owner did not submit.
test('the owner\'s animus cancel cancels someone else\'s job', async (t) => {
  const h = await helix(t, { owner: 'ajmal' });
  const job = queue(h.store, 'ana', 'app');

  const r = await cli(ANIMUS, ['cancel', String(job.id)], h.as('ajmal'));

  assert.equal(r.code, 0, r.err);
  assert.equal(h.store.get(job.id)?.state, 'cancelled');
});

// Protects: criterion 4, cancel stays own-only for others. Fails when: someone but the owner cancels another person's job.
test('animus cancel from someone but the owner is refused for another person\'s job', async (t) => {
  const h = await helix(t, { owner: 'ajmal' });
  const job = queue(h.store, 'ajmal', 'app');

  const r = await cli(ANIMUS, ['cancel', String(job.id)], h.as('ana'));

  assert.equal(r.code, 2);
  assert.match(r.err, new RegExp(`job ${job.id} is ajmal's`));
  assert.equal(h.store.get(job.id)?.state, 'queued');
});

// Protects: criterion 4, status --all. Fails when: the owner's --all leaves out someone's jobs or whose they are, or plain status shows other people's jobs.
test('the owner\'s animus status --all lists every person\'s jobs with whose each is; plain status only their own', async (t) => {
  const h = await helix(t, { owner: 'ajmal' });
  const mine = queue(h.store, 'ajmal', 'app');
  const anas = queue(h.store, 'ana', 'site');

  const all = await cli(ANIMUS, ['status', '--all'], h.as('ajmal'));
  const own = await cli(ANIMUS, ['status'], h.as('ajmal'));

  assert.equal(all.code, 0, all.err);
  assert.match(all.out, new RegExp(`^${mine.id}\\s+ajmal\\s+app\\b`, 'm'));
  assert.match(all.out, new RegExp(`^${anas.id}\\s+ana\\s+site\\b`, 'm'));
  assert.match(own.out, new RegExp(`^${mine.id}\\s+ajmal\\s+app\\b`, 'm'));
  assert.doesNotMatch(own.out, /\bana\b/);
});

// Protects: criterion 4, --all is the owner's. Fails when: someone but the owner sees every person's jobs.
test('animus status --all from someone but the owner is refused', async (t) => {
  const h = await helix(t, { owner: 'ajmal' });
  queue(h.store, 'ajmal', 'app');

  const r = await cli(ANIMUS, ['status', '--all'], h.as('ana'));

  assert.equal(r.code, 2);
  assert.match(r.err, /only the owner, ajmal, may see every job/);
  assert.doesNotMatch(r.out, /ajmal/);
});

// Protects: criterion 6, setup links the owner. Fails when: helix slack setup leaves the owner's Slack user unlinked, or still writes slack.owner.
test('helix slack setup links the Slack user it is given to the owner, and config.yaml gets no slack.owner', async (t) => {
  const h = await helix(t, { owner: 'ajmal' });
  const api = await fakeSlack({ app: 'xapp-good', bot: 'xoxb-good' });
  t.after(() => api.close());

  await slackSetup(h.store, { bot: 'xoxb-good', app: 'xapp-good', user: 'U0AJMAL' }, api.api);

  assert.equal(h.store.slackOf('ajmal'), 'U0AJMAL');
  assert.deepEqual(parse(readFileSync(configFile(), 'utf8')).slack, { enabled: true });
});

// Protects: criterion 6, no owner, no setup. Fails when: helix slack setup asks for tokens or turns Slack on while nobody is the owner.
test('helix slack setup is refused while there is no owner, and writes nothing', async (t) => {
  await helix(t);
  const before = readFileSync(configFile(), 'utf8');

  const r = await cli(HELIX, ['slack', 'setup']);

  assert.equal(r.code, 2);
  assert.match(r.err, /this Helix has no owner: helix owner <person> first/);
  assert.equal(readFileSync(configFile(), 'utf8'), before);
  assert.ok(!existsSync(slackEnvFile()));
});

// Protects: criterion 6, the move at start. Fails when: a slack.owner left by an earlier setup is not linked to the owner, or stays in config.yaml.
test('a slack.owner left in config.yaml is linked to the owner and taken out of config.yaml', async (t) => {
  const h = await helix(t);
  updateConfig({ owner: 'ajmal', slack: { enabled: true, owner: 'U0AJMAL' } as Config['slack'] });

  const said = moveSlackOwner(h.store);

  assert.equal(h.store.slackOf('ajmal'), 'U0AJMAL');
  assert.deepEqual(parse(readFileSync(configFile(), 'utf8')).slack, { enabled: true });
  assert.match(said ?? '', /U0AJMAL is now linked to ajmal/);
});

// Protects: criterion 6, nothing lost. Fails when: a slack.owner is dropped while there is no owner to link it to.
test('a slack.owner left in config.yaml stays there while there is no owner', async (t) => {
  const h = await helix(t);
  updateConfig({ slack: { enabled: true, owner: 'U0AJMAL' } as Config['slack'] });

  const said = moveSlackOwner(h.store);

  assert.equal(h.store.personBySlack('U0AJMAL'), undefined);
  assert.equal(parse(readFileSync(configFile(), 'utf8')).slack.owner, 'U0AJMAL');
  assert.match(said ?? '', /no owner to link it to/);
});
