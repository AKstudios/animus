import assert from 'node:assert/strict';
import { mkdtempSync, writeFileSync } from 'node:fs';
import type { AddressInfo } from 'node:net';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { test } from 'node:test';
import type { Display, DisplayPr } from '../../plugin/display/shape.ts';
import { view } from '../../plugin/display/view.ts';
import { hashToken, type Config } from '../src/config.ts';
import { openPrs, type GithubPr, type ListPrs } from '../src/open-prs.ts';
import { serve } from '../src/server.ts';
import { openStore } from '../src/store.ts';
import { supervise } from '../src/supervisor.ts';

const url = (n: number) => `https://github.com/o/app/pull/${n}`;

/** A Helix table with ana and ben (each with a GitHub token) and cat (who has none), a ready project, and a PR job per number given. */
function table(prs: { n: number; person: string; repo?: string; outcome?: string }[]) {
  const home = mkdtempSync(join(tmpdir(), 'open-prs-'));
  const store = openStore(join(home, 'helix.db'));
  for (const who of ['ana', 'ben']) {
    writeFileSync(join(home, `${who}.env`), `GH_TOKEN=${who}-gh\n`);
    store.putPerson(who, { token_sha256: hashToken(`${who}-token`), env_file: join(home, `${who}.env`) });
  }
  store.putPerson('cat', { token_sha256: hashToken('cat-token') });
  store.putProject({ name: 'app', url: 'https://github.com/o/app.git', dir: home, state: 'ready', added: '' });
  store.putProject({ name: 'site', url: 'https://github.com/o/site.git', dir: home, state: 'ready', added: '' });
  for (const p of prs) {
    store.add({ state: 'ended', person: p.person, repo: p.repo ?? 'app', spec: '', title: `Job for ${p.n}`, draft: false, submitted: '2026-11-17T10:00:00Z', outcome: p.outcome ?? 'pr', pr: url(p.n) });
  }
  return { home, store };
}

/** Stands in for GitHub: lists what it was given, and remembers who asked about what. */
function github(open: GithubPr[]) {
  const asked: [string, string][] = [];
  const list: ListPrs = async (repo, token) => { asked.push([repo, token]); return open; };
  return { asked, list };
}
const gh = (n: number, over: Partial<GithubPr> = {}): GithubPr => ({ html_url: url(n), number: n, title: `PR ${n}`, created_at: `2026-11-17T10:${String(n).padStart(2, '0')}:00Z`, ...over });

// Protects: the overview lists what is open and nothing else. Fails when: a PR GitHub no longer lists (merged, closed) or one no job of Helix's opened is shown, or a draft is not marked.
test('lists the open PRs that jobs opened, marks drafts, and leaves out what GitHub does not list or no job opened', async () => {
  const { store } = table([{ n: 1, person: 'ana' }, { n: 2, person: 'ben' }, { n: 3, person: 'ana' }]);
  const { list } = github([gh(2, { draft: true }), gh(1), gh(99, { title: 'opened by hand' })]);
  const prs = await openPrs({ store, list })();
  assert.deepEqual(prs.map((p) => [p.number, p.title, p.draft, p.person, p.repo]), [[2, 'PR 2', true, 'ben', 'app'], [1, 'PR 1', false, 'ana', 'app']]);
});

// Protects: GitHub sees the opener's own token, never another person's. Fails when: a PR is asked about with the wrong token.
test('asks GitHub with the token of the person whose job opened the latest PR, once per project', async () => {
  const { store } = table([{ n: 1, person: 'ana' }, { n: 2, person: 'ben' }]);
  const { asked, list } = github([gh(1), gh(2)]);
  await openPrs({ store, list })();
  assert.deepEqual(asked, [['https://github.com/o/app.git', 'ben-gh']]);
});

// Protects: GitHub's rate limit. Fails when: every refresh of the display asks again, or the answer is never refreshed.
test('asks again for a project only after a minute', async () => {
  const { store } = table([{ n: 1, person: 'ana' }, { n: 5, person: 'ana', repo: 'site' }]);
  const { asked, list } = github([gh(1)]);
  let clock = 1_000_000;
  const read = openPrs({ store, list, now: () => clock });
  await read();
  clock += 59_000;
  await Promise.all([read(), read()]);
  assert.equal(asked.length, 2, 'one call per project, however often it is read');
  clock += 2_000;
  await read();
  assert.equal(asked.length, 4);
});

// Protects: a person who left is not spoken for. Fails when: GitHub is asked with a token Helix no longer holds, or their PR stays listed.
test('a PR whose person has left, or never had a GitHub token, is not asked about and drops off', async () => {
  const { store } = table([{ n: 1, person: 'ana' }, { n: 2, person: 'cat' }, { n: 3, person: 'gone' }]);
  const { asked, list } = github([gh(1), gh(2), gh(3)]);
  const prs = await openPrs({ store, list })();
  assert.deepEqual(prs.map((p) => p.number), [1]);
  assert.deepEqual(asked.map(([, token]) => token), ['ana-gh']);
  store.dropPerson('ana');
  asked.length = 0;
  assert.deepEqual(await openPrs({ store, list })(), []);
  assert.deepEqual(asked, [], 'with nobody left to ask for, GitHub is not asked');
});

test('a GitHub that fails leaves the project with no PRs for the minute, and does not fail the display', async () => {
  const { store } = table([{ n: 1, person: 'ana' }]);
  let calls = 0;
  const list: ListPrs = async () => { calls++; throw new Error('GitHub answered 502'); };
  const read = openPrs({ store, list });
  assert.deepEqual(await read(), []);
  assert.deepEqual(await read(), []);
  assert.equal(calls, 1);
});

const NOW = Date.parse('2026-11-17T12:00:00Z');
const display = (over: Partial<Display>): Display => ({
  name: 'office', at: new Date(NOW).toISOString(), slots: 1, stages: ['setup'],
  repos: [{ name: 'app' }, { name: 'site' }], jobs: [], ...over,
});
const pr = (n: number, over: Partial<DisplayPr> = {}): DisplayPr => ({ job: n, repo: 'app', person: 'ana', number: n, title: `PR ${n}`, url: url(n), draft: false, created: `2026-11-17T10:${String(n).padStart(2, '0')}:00Z`, ...over });

test('the overview shows the ten newest open PRs, drafts marked, and a picked project only its own', () => {
  const twelve = Array.from({ length: 12 }, (_, i) => pr(i + 1, i === 11 ? { draft: true } : {}));
  const v = view(display({ prs: [...twelve, pr(30, { repo: 'site', created: '2026-11-17T09:00:00Z' })] }), null, NOW);
  assert.deepEqual(v.prs.map((p) => p.tag), ['Draft #12', 'Open #11', 'Open #10', 'Open #9', 'Open #8', 'Open #7', 'Open #6', 'Open #5', 'Open #4', 'Open #3']);
  assert.deepEqual([v.prs[0]!.draft, v.prs[0]!.href, v.prs[0]!.page, v.prs[0]!.repo, v.prs[0]!.person, v.prs[0]!.personPage], [true, url(12), '/jobs/12', 'app', 'ana', '/people/ana']);
  assert.deepEqual(view(display({ prs: [pr(1), pr(30, { repo: 'site' })] }), 'site', NOW).prs.map((p) => p.id), [30]);
});

test('/display carries the open PRs, asked of GitHub with the opener\'s token', async () => {
  const { home, store } = table([{ n: 1, person: 'ana' }]);
  const { asked, list } = github([gh(1, { draft: true })]);
  const config: Config = { host: '127.0.0.1', port: 0, slots: 1 };
  const supervisor = supervise({ store, config, home, launch: () => ({ command: process.execPath, args: ['-e', ''] }) });
  const server = serve({ config, store, supervisor, home, listPrs: list });
  await new Promise<void>((r) => { server.listen(0, '127.0.0.1', r); });
  try {
    const d = (await (await fetch(`http://127.0.0.1:${(server.address() as AddressInfo).port}/display`)).json()) as Display;
    assert.deepEqual(d.prs?.map((p) => [p.number, p.draft, p.job]), [[1, true, 1]]);
    assert.deepEqual(asked, [['https://github.com/o/app.git', 'ana-gh']]);
  } finally { supervisor.stop(); server.close(); store.close(); }
});

// Protects: the overview can tell a merged PR from a closed one, and only for jobs of Helix's. Fails when: merged_at is ignored, a PR no job opened is listed, or a failed call breaks the open list.
test('lists the latest closed PRs of jobs, merged or not, and is empty when GitHub fails', async () => {
  const { store } = table([{ n: 1, person: 'ana' }, { n: 2, person: 'ben' }]);
  const listClosed: ListPrs = async () => [gh(1, { merged_at: '2026-11-17T12:00:00Z' }), gh(2, { closed_at: '2026-11-17T13:00:00Z' }), gh(99, { merged_at: '2026-11-17T14:00:00Z' })];
  const prs = openPrs({ store, list: github([]).list, listClosed });
  assert.deepEqual((await prs.closed()).map((c) => [c.number, c.merged, c.at]), [[1, true, '2026-11-17T12:00:00Z'], [2, false, '2026-11-17T13:00:00Z']]);
  const failing = openPrs({ store, list: github([gh(1)]).list, listClosed: async () => { throw new Error('GitHub answered 500'); } });
  assert.deepEqual([(await failing()).length, await failing.closed()], [1, []]);
});
