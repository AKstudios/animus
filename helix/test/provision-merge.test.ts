import assert from 'node:assert/strict';
import { execFileSync } from 'node:child_process';
import { mkdtempSync, readFileSync, writeFileSync } from 'node:fs';
import type { AddressInfo } from 'node:net';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { test, type TestContext } from 'node:test';
import { makeRepo, write } from '../../plugin/test/helpers.ts';
import { hashToken, type Config } from '../src/config.ts';
import type { GithubPr } from '../src/open-prs.ts';
import { checkProject, projectDir, type SetupRun } from '../src/projects.ts';
import { serve } from '../src/server.ts';
import { openStore } from '../src/store.ts';
import { pauseFile, supervise } from '../src/supervisor.ts';

const git = (cwd: string, ...args: string[]) => execFileSync('git', args, { cwd, encoding: 'utf8' }).trim();
const PR = 'https://github.com/acme/app/pull/7';

// The add check passes only where the profile asks for curl: what the provision job's pull request adds.
const setup: SetupRun = (worktree) => {
  const ok = readFileSync(join(worktree, '.animus/animus.yaml'), 'utf8').includes('curl');
  return { code: 0, output: '', gates: [{ name: 'test', command: 'npm test', ok, output: 'curl: not found' }] } as unknown as ReturnType<SetupRun>;
};

/**
 * Helix with ana's project `app` failed on a gate, its provision job ended in a
 * pull request, and GitHub saying that pull request is `closed` (merged or not).
 * `merge` puts what the pull request holds on the base branch; `display` is a
 * look at Helix's display, where its polling of the pull requests happens.
 */
async function afterProvision(t: TestContext, closed: Partial<GithubPr>) {
  const home = mkdtempSync(join(tmpdir(), 'helix-provision-merge-'));
  const source = makeRepo();
  write(source, '.animus/animus.yaml', 'commands:\n  test: "true"\n');
  git(source, 'add', '-A');
  git(source, 'commit', '-qm', 'profile');
  const bare = join(home, 'origin.git');
  git(home, 'clone', '-q', '--bare', source, bare);
  writeFileSync(join(home, 'ana.env'), 'GH_TOKEN=github_pat_ana\n');
  const store = openStore(join(home, 'helix.db'));
  store.putPerson('ana', { token_sha256: hashToken('ana-token'), env_file: join(home, 'ana.env') });
  store.putProject({ name: 'app', url: bare, dir: projectDir(home, 'app'), state: 'checking', added: '2026-11-19T10:00:00Z', added_by: 'ana' });
  const said: string[] = [];
  const check = (name: string) => checkProject({ store, home, name, say: (l) => said.push(l), setup });
  check('app');
  const job = store.list().find((j) => j.provision)!;
  store.save({ ...job, state: 'ended', outcome: 'pr', pr: PR });
  assert.equal(store.project('app')!.state, 'failed');

  const config: Config = { host: '127.0.0.1', port: 0, slots: 1 };
  writeFileSync(pauseFile(home), '');
  const supervisor = supervise({ store, config, home, launch: () => ({ command: process.execPath, args: ['-e', ''] }) });
  const server = serve({
    config, store, supervisor, home, startCheck: check, listPrs: async () => [],
    listClosedPrs: async () => [{ html_url: PR, number: 7, title: 'Fix app', created_at: '2026-11-19T10:00:00Z', closed_at: '2026-11-19T11:00:00Z', ...closed }],
  });
  await new Promise<void>((r) => { server.listen(0, '127.0.0.1', r); });
  t.after(() => { supervisor.stop(); server.close(); store.close(); });
  const port = (server.address() as AddressInfo).port;
  return {
    store, home, said, job,
    merge() {
      const work = mkdtempSync(join(tmpdir(), 'helix-provision-merge-work-'));
      git(work, 'clone', '-q', bare, 'w');
      write(join(work, 'w'), '.animus/animus.yaml', 'commands:\n  test: "true"\nsetup: "apt-get install -y curl"\n');
      git(join(work, 'w'), 'commit', '-qam', 'curl');
      git(join(work, 'w'), 'push', '-q', 'origin', 'HEAD');
    },
    display: async () => { await fetch(`http://127.0.0.1:${port}/display`); },
  };
}

const provisions = (store: ReturnType<typeof openStore>) => store.list().filter((j) => j.provision);

// Protects: criterion 5, a merge makes the project ready. Fails when: the merge is not seen, the check does not run on the base branch with the merged files, or the project stays failed.
test('when the provision pull request merges the add check runs on the base branch and the project becomes ready', async (t) => {
  const h = await afterProvision(t, { merged_at: '2026-11-19T11:00:00Z' });
  h.merge();
  await h.display();
  const project = h.store.project('app')!;
  assert.deepEqual([project.state, project.reason], ['ready', undefined]);
  assert.equal(provisions(h.store).length, 1);
  assert.equal(h.store.get(h.job.id)!.pr_done, 'merged');
});

// Protects: criterion 5, a merge that does not fix it ends failed without a loop. Fails when: a second provision job is queued, or the project is left checking, or the reason is lost.
test('a merged provision pull request whose check still fails fails the project with the check\'s reason and queues no second job', async (t) => {
  const h = await afterProvision(t, { merged_at: '2026-11-19T11:00:00Z' });
  await h.display(); // nothing was merged to the base branch: the check fails as before
  const project = h.store.project('app')!;
  assert.equal(project.state, 'failed');
  assert.match(project.reason!, /curl: not found/);
  assert.equal(provisions(h.store).length, 1);
  assert.ok(h.said.some((l) => /no second provision job is queued/.test(l)), h.said.join('\n'));
});

// Protects: a pull request closed unmerged changes nothing but lets the project be provisioned again. Fails when: the check runs for it, or it blocks a new provision job for ever.
test('a provision pull request closed without merging runs no check and no longer blocks another provision job', async (t) => {
  const h = await afterProvision(t, {});
  h.said.length = 0;
  await h.display();
  assert.equal(h.store.project('app')!.state, 'failed');
  assert.deepEqual(h.said, []);
  assert.equal(h.store.get(h.job.id)!.pr_done, 'closed');
  h.store.putProject({ ...h.store.project('app')!, state: 'checking' });
  checkProject({ store: h.store, home: h.home, name: 'app', say: (l) => h.said.push(l), setup });
  assert.equal(provisions(h.store).length, 2);
});
