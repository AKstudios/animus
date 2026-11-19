import assert from 'node:assert/strict';
import { mkdirSync, mkdtempSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { DatabaseSync } from 'node:sqlite';
import { test } from 'node:test';
import { describeJob } from '../../plugin/src/remote.ts';
import { hashToken, type Config } from '../src/config.ts';
import { deviceCode, keepTokens, pollDevice } from '../src/github-app.ts';
import { openStore, type HelixJob } from '../src/store.ts';
import { animusArgs, supervise, type Launch } from '../src/supervisor.ts';
import { fakeGitHub } from './fake-github.ts';

const spec = (title: string, after?: string) => `---\nsize: small\n${after ? `after: ${after}\n` : ''}---\n# ${title}\n\n## Acceptance criteria\n\n1. It works.\n`;

/**
 * A Helix with ana signed in to a fake GitHub and the project app of o, whose
 * clone holds specs/base.md ("Base"). Pull request 4 is titled "Base" and is
 * open. A job "later" runs after specs/base.md; every job ends as a pull request
 * the moment it starts, and `started` lists the ones that were started.
 */
async function helix(home = mkdtempSync(join(tmpdir(), 'helix-waiting-'))) {
  const github = await fakeGitHub();
  const config: Config = { host: '127.0.0.1', port: 0, slots: 1, github: { client_id: 'Iv23liGood' } };
  const store = openStore(join(home, 'helix.db'));
  const envFile = join(home, 'ana.env');
  writeFileSync(envFile, '');
  store.putPerson('ana', { token_sha256: hashToken('ana-token'), env_file: envFile, github: 'ana-gh' });
  const code = await deviceCode('Iv23liGood', github);
  github.approve(code.user_code, 'ana-gh');
  keepTokens('ana', envFile, await pollDevice('Iv23liGood', code, github, async () => {}));
  const dir = join(home, 'app');
  mkdirSync(join(dir, 'specs'), { recursive: true });
  writeFileSync(join(dir, 'specs', 'base.md'), spec('Base'));
  store.putProject({ name: 'app', url: 'https://github.com/o/app.git', dir, state: 'ready', added: '' });
  github.addIssue('o/app', 4, { title: 'Base', body: 'x', pull: true });
  const started: string[] = [];
  const told: HelixJob[] = [];
  const launched = new Map<string, string[]>();
  const launch: Launch = (job, repoDir) => {
    started.push(job.title);
    launched.set(job.title, animusArgs(job, repoDir));
    return { command: process.execPath, args: ['-e', `console.log(JSON.stringify({ outcome: 'pr', pr: 'https://github.com/o/app/pull/9' }))`] };
  };
  const supervisor = supervise({ store, config, home, launch, github, notify: (j) => { told.push(j); } });
  const submit = (title: string, after?: string) => supervisor.submit('ana', { repo: 'app', spec: spec(title, after), name: 'spec.md' });
  // The loop's minute: polls until the job is in the state (a poll that finds another one running does nothing).
  const reaches = async (id: number, state: HelixJob['state']) => {
    for (let i = 0; i < 500 && store.get(id)!.state !== state; i++) {
      await supervisor.poll();
      await new Promise((r) => { setTimeout(r, 20); });
    }
    return store.get(id)!;
  };
  return { github, store, supervisor, started, launched, told, home, submit, reaches, stop: () => { supervisor.stop(); store.close(); } };
}

// Protects: criteria 1 and 2. Fails when: a job whose earlier PR is open takes a slot or starts, says something else than what it waits for, is not queued once that PR merges, or does not then run.
test('a job after a spec whose pull request is open waits without a slot, then runs once it merges', async () => {
  const h = await helix();
  const waiting = await h.submit('Later', 'specs/base.md');
  const other = await h.submit('Other');
  await h.reaches(other.id, 'ended');
  await h.supervisor.poll();

  assert.deepEqual([h.store.get(waiting.id)!.state, h.store.get(waiting.id)!.waiting], ['waiting', "waiting for specs/base.md's pull request"]);
  assert.deepEqual(h.started, ['Other']);
  assert.match(describeJob(h.store.get(waiting.id)!), /\n {2}waiting for specs\/base\.md's pull request/);

  h.github.addIssue('o/app', 4, { title: 'Base', body: 'x', pull: true, merged: true });
  const done = await h.reaches(waiting.id, 'ended');
  assert.deepEqual([done.outcome, done.pr, h.started], ['pr', 'https://github.com/o/app/pull/9', ['Other', 'Later']]);
  // The queue has settled the wait: `animus run` must not look for the earlier spec's file (it may exist only as another Helix job's) or wait again.
  assert.ok(h.launched.get('Later')!.includes('--after-merged'));
  assert.ok(!h.launched.get('Other')!.includes('--after-merged'));
  h.stop();
});

// Protects: criterion 2. Fails when: a closed earlier PR leaves the job waiting for ever, or ends it without the reason or without telling its person.
test('a job whose earlier pull request was closed unmerged ends failed and its person is told', async () => {
  const h = await helix();
  const waiting = await h.submit('Later', 'specs/base.md');
  h.github.addIssue('o/app', 4, { title: 'Base', body: 'x', pull: true, state: 'closed' });
  const ended = await h.reaches(waiting.id, 'ended');
  assert.deepEqual([ended.state, ended.outcome, ended.reason, h.started], ['ended', 'failed', 'its earlier pull request was closed', []]);
  assert.deepEqual(h.told.filter((j) => j.id === waiting.id).map((j) => j.outcome), ['failed']);
  h.stop();
});

// Protects: criterion 2. Fails when: a waiting job cannot be cancelled, or a poll after the cancel brings it back and runs it.
test('a waiting job is cancelled like a queued one and stays cancelled when its earlier pull request merges', async () => {
  const h = await helix();
  const waiting = await h.submit('Later', 'specs/base.md');
  h.supervisor.cancel('ana', waiting.id);
  h.github.addIssue('o/app', 4, { title: 'Base', body: 'x', pull: true, merged: true });
  // A few of the loop's minutes: a cancelled job must not be queued by any of them.
  for (let i = 0; i < 5; i++) {
    await h.supervisor.poll();
    await new Promise((r) => { setTimeout(r, 20); });
  }

  assert.deepEqual([h.store.get(waiting.id)!.state, h.started], ['cancelled', []]);
  h.stop();
});

// Protects: criterion 2. Fails when: a waiting job is lost, or runs without waiting, after Helix starts again.
test('a waiting job survives a restart of Helix and runs after its earlier pull request merges', async () => {
  const first = await helix();
  const waiting = await first.submit('Later', 'specs/base.md');
  first.stop();

  const again = await helix(first.home);
  const kept = again.store.get(waiting.id)!;
  assert.deepEqual([kept.state, kept.after, again.started], ['waiting', ['specs/base.md'], []]);
  again.github.addIssue('o/app', 4, { title: 'Base', body: 'x', pull: true, merged: true });
  assert.equal((await again.reaches(waiting.id, 'ended')).outcome, 'pr');
  again.stop();
});

// Protects: criterion 4. Fails when: opening a helix.db written before waiting existed loses or changes a job that is queued, running, awaiting an answer or ended.
test('a helix.db from the release before keeps its queued, running, awaiting-answer and ended jobs', () => {
  const home = mkdtempSync(join(tmpdir(), 'helix-legacy-'));
  const file = join(home, 'helix.db');
  const db = new DatabaseSync(file);
  db.exec('create table jobs (id integer primary key autoincrement, state text not null, data text not null)');
  const row = (state: string, data: object) => db.prepare('insert into jobs (state, data) values (?, ?)').run(state, JSON.stringify({ person: 'ana', repo: 'app', spec: 'x', draft: false, submitted: '2026-11-01T00:00:00Z', ...data }));
  row('queued', { title: 'queued one' });
  row('running', { title: 'running one', pid: 1, animus_job: 'a-1' });
  row('ended', { title: 'asking one', outcome: 'needs-input', question: 'which?' });
  row('ended', { title: 'done one', outcome: 'pr', pr: 'https://github.com/o/app/pull/2' });
  db.close();

  const store = openStore(file);
  const jobs = store.list(-1).map((j) => [j.id, j.state, j.title, j.outcome, j.question, j.pr, j.pid, j.animus_job]);
  assert.deepEqual(jobs, [
    [1, 'queued', 'queued one', undefined, undefined, undefined, undefined, undefined],
    [2, 'running', 'running one', undefined, undefined, undefined, 1, 'a-1'],
    [3, 'ended', 'asking one', 'needs-input', 'which?', undefined, undefined, undefined],
    [4, 'ended', 'done one', 'pr', undefined, 'https://github.com/o/app/pull/2', undefined, undefined],
  ]);
  store.close();
});
