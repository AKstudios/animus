import assert from 'node:assert/strict';
import { spawnSync } from 'node:child_process';
import { chmodSync, mkdtempSync, readFileSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { test } from 'node:test';
import { cli, deps, fakeAgent, makeRepo, write } from './helpers.ts';
import { fetchReferences, writeDraft, type Fetch } from '../src/draft.ts';

/** A web that answers from a table, and writes down each request with its Authorization header. */
function fakeWeb(pages: Record<string, () => Response>): { fetch: Fetch; asked: { url: string; auth: string | null }[] } {
  const asked: { url: string; auth: string | null }[] = [];
  const fetch: Fetch = async (url, init) => {
    asked.push({ url, auth: new Headers(init?.headers).get('authorization') });
    const page = pages[url];
    return page ? page() : new Response('not found', { status: 404 });
  };
  return { fetch, asked };
}

const json = (value: unknown) => () => Response.json(value);
const anyHost = async () => true;

function draftFolder(message: string): string {
  const folder = join(mkdtempSync(join(tmpdir(), 'animus-draft-')), 'd1');
  write(folder, 'message.md', message);
  return folder;
}

// Protects: criterion 2, each kind of reference reaching the draft's folder before its session. Fails when: a kind is not fetched, is saved without its content, or a token goes to the wrong host.
test('a GitHub issue, a Slack file and a public page in the message are fetched into the draft\'s references', async () => {
  const message = 'Do what <https://github.com/o/app/issues/12|issue 12> says, with https://team.slack.com/files/U1/F2ABC/notes.txt and https://example.com/guide.';
  const folder = draftFolder(message);
  const web = fakeWeb({
    'https://api.github.com/repos/o/app/issues/12': json({ title: 'Sort by aisle', body: 'Group the list by aisle.', user: { login: 'ana' }, state: 'open', html_url: 'https://github.com/o/app/issues/12' }),
    'https://api.github.com/repos/o/app/issues/12/comments': json([{ user: { login: 'ben' }, body: 'Empty lists need a hint.' }]),
    'https://slack.com/api/files.info?file=F2ABC': json({ ok: true, file: { name: 'notes.txt', url_private_download: 'https://files.slack.com/files-pri/T1-F2ABC/download/notes.txt' } }),
    'https://files.slack.com/files-pri/T1-F2ABC/download/notes.txt': () => new Response('aisles come from categories'),
    'https://example.com/guide': () => new Response('<html><script>steal()</script><h1>Guide</h1><p>Use &amp; enjoy</p></html>', { headers: { 'content-type': 'text/html' } }),
  });

  const sources = await fetchReferences(message, folder, { github: { token: 'ghu_person' }, slack: { token: 'xoxb-bot' }, fetch: web.fetch, isPublic: anyHost });

  assert.deepEqual(sources.map((s) => [s.url, Boolean(s.file), s.why]), [
    ['https://github.com/o/app/issues/12', true, undefined],
    ['https://team.slack.com/files/U1/F2ABC/notes.txt', true, undefined],
    ['https://example.com/guide', true, undefined],
  ]);
  const read = (i: number) => readFileSync(join(folder, sources[i]!.file!), 'utf8');
  assert.match(read(0), /Sort by aisle[\s\S]*Group the list by aisle\.[\s\S]*ben[\s\S]*Empty lists need a hint\./);
  assert.equal(read(1), 'aisles come from categories');
  assert.match(read(2), /Guide\s+Use & enjoy/);
  assert.doesNotMatch(read(2), /steal|</);
  const auth = Object.fromEntries(web.asked.map((a) => [new URL(a.url).hostname, a.auth]));
  assert.deepEqual(auth, { 'api.github.com': 'Bearer ghu_person', 'slack.com': 'Bearer xoxb-bot', 'files.slack.com': 'Bearer xoxb-bot', 'example.com': null });
});

// Protects: Helix's own network from a link in a message. Fails when: a loopback, private or link-local address is fetched, directly or by a redirect.
test('a link to a private address is not fetched, nor a redirect to one', async () => {
  const message = 'see http://127.0.0.1:7400/api/jobs http://169.254.169.254/latest/meta-data http://[::1]/ and http://93.184.215.14/moved';
  const folder = draftFolder(message);
  const web = fakeWeb({ 'http://93.184.215.14/moved': () => new Response(null, { status: 302, headers: { location: 'http://10.0.0.1/secret' } }) });

  const sources = await fetchReferences(message, folder, { fetch: web.fetch });

  assert.deepEqual(sources.map((s) => s.file), [undefined, undefined, undefined, undefined]);
  assert.ok(sources.every((s) => /private|local/.test(s.why ?? '')), JSON.stringify(sources));
  assert.deepEqual(web.asked.map((a) => a.url), ['http://93.184.215.14/moved']);
});

// Protects: the draft session reading the message and the fetched references, in a session that can reach nothing else. Fails when: the prompt leaves them out, the session is not files-only on the fast tier with the $0.50 stop, or draft.md is not the session's spec.
test('animus draft writes draft.md from a files-only fast session that reads the message and its references', async () => {
  const repo = makeRepo();
  const folder = draftFolder('Sort the list by aisle, as https://example.com/guide says.');
  await fetchReferences(readFileSync(join(folder, 'message.md'), 'utf8'), folder, { fetch: fakeWeb({ 'https://example.com/guide': () => new Response('aisles') }).fetch, isPublic: anyHost });
  const spec = '---\nsize: small\n---\n# Sort by aisle\n\n## Acceptance criteria\n\n1. Grouped.\n   $ npm test\n';
  const { agent, calls } = fakeAgent([() => ({ output: { spec } })]);

  writeDraft({ ...deps(agent), folder, cwd: repo, env: {} });

  assert.equal(readFileSync(join(folder, 'draft.md'), 'utf8'), spec);
  const req = calls[0]!;
  assert.deepEqual([req.role, req.tier, req.maxUsd, req.filesOnly, req.cwd], ['drafter', 'fast', 0.5, true, repo]);
  assert.deepEqual(req.addDirs, [join(folder, 'references')]);
  assert.match(req.prompt, /Sort the list by aisle/);
  assert.match(req.prompt, /https:\/\/example\.com\/guide: .*references[/\\]1-example\.com-guide/);
});

const UI_SPEC = '---\ntype: ui\n---\n# A page\n\n## Acceptance criteria\n\n1. A page.\n   $ npm test\n';
const FEATURE_SPEC = '---\ntype: feature\n---\n# A page\n\n## Acceptance criteria\n\n1. A page.\n   $ npm test\n';
/** A draft folder with the project Helix read: a profile with one gate and no ui target. */
function projectFolder(): string {
  const folder = draftFolder('Add a page.');
  write(folder, 'project.json', JSON.stringify({ profile: 'commands:\n  test: npm test\n', read: 'origin/main on GitHub', commit: 'abc' }));
  return folder;
}

// Protects: criterion 6. Fails when: the session is not told the project's gates, base and runnable types, or admit's problems do not go back to it once, in its own session, within what is left of the $0.50.
test('a draft session is given the project, and the problems admit finds go back to it once within the cap', () => {
  const folder = projectFolder();
  const { agent, calls } = fakeAgent([() => ({ output: { spec: UI_SPEC } }), () => ({ output: { spec: FEATURE_SPEC } })]);

  writeDraft({ ...deps(agent), folder, cwd: makeRepo(), env: {} });

  assert.match(calls[0]!.prompt, /test: npm test/);
  assert.match(calls[0]!.prompt, /base branch: main/);
  assert.equal(calls.length, 2);
  assert.equal(calls[1]!.resume, 'session-1');
  assert.equal(calls[1]!.maxUsd, 0.49);
  assert.match(calls[1]!.prompt, /a ui spec needs a ui target/);
  assert.equal(readFileSync(join(folder, 'draft.md'), 'utf8'), FEATURE_SPEC);
  assert.doesNotMatch(readFileSync(join(folder, 'summary.md'), 'utf8'), /problem/i);
});

// Protects: a `$` line with notes on it never reaches a job. Fails when: a command the shell cannot parse is not sent back to the drafter, or the drafter is not told a `$` line holds only the command.
test('a draft whose command is not valid shell goes back to the drafter, which is told a $ line is only the command', () => {
  const folder = projectFolder();
  const noted = FEATURE_SPEC.replace('$ npm test', '$ npm test  (src/page.test.ts: add a case for `/page`)');
  const { agent, calls } = fakeAgent([() => ({ output: { spec: noted } }), () => ({ output: { spec: FEATURE_SPEC } })]);

  writeDraft({ ...deps(agent), folder, cwd: makeRepo(), env: {} });

  assert.match(calls[0]!.system ?? '', /nothing else on that line/);
  assert.equal(calls.length, 2);
  assert.match(calls[1]!.prompt, /criterion 1's command is not valid shell/);
  assert.equal(readFileSync(join(folder, 'draft.md'), 'utf8'), FEATURE_SPEC);
});

// Protects: criterion 6's once. Fails when: a retry that fails loses the first draft, or the draft is posted without its problems, or the session is asked a third time.
test('a retry that fails leaves the first draft, with its problems in the summary', () => {
  const folder = projectFolder();
  const { agent, calls } = fakeAgent([() => ({ output: { spec: UI_SPEC } }), () => ({ ok: false, status: 'error_max_budget_usd' })]);

  writeDraft({ ...deps(agent), folder, cwd: makeRepo(), env: {} });

  assert.equal(calls.length, 2);
  assert.equal(readFileSync(join(folder, 'draft.md'), 'utf8'), UI_SPEC);
  assert.match(readFileSync(join(folder, 'summary.md'), 'utf8'), /a ui spec needs a ui target/);
});

// Protects: criterion 6's "outside its spec". Fails when: a draft with no problems is asked again, or a draft with no project writes a summary.
test('a draft admit finds nothing wrong with is not asked again, and one with no project has no summary', () => {
  const folder = projectFolder();
  const { agent, calls } = fakeAgent([() => ({ output: { spec: FEATURE_SPEC } })]);
  writeDraft({ ...deps(agent), folder, cwd: makeRepo(), env: {} });
  assert.equal(calls.length, 1);

  const bare = draftFolder('Add a page.');
  writeDraft({ ...deps(fakeAgent([() => ({ output: { spec: UI_SPEC } })]).agent), folder: bare, cwd: makeRepo(), env: {} });
  assert.throws(() => readFileSync(join(bare, 'summary.md')), /ENOENT/);
});

// Protects: criterion 4's revision. Fails when: a session run again with a reply is not given the draft so far and the reply.
test('a revision gives the session the draft so far and the person\'s reply', () => {
  const folder = draftFolder('Sort by aisle.');
  write(folder, 'draft.md', '# Sort by aisle, the earlier draft');
  write(folder, 'reply.md', 'Empty aisles go last');
  const { agent, calls } = fakeAgent([() => ({ output: { spec: '# Sort by aisle\n' } })]);

  writeDraft({ ...deps(agent), folder, cwd: makeRepo(), env: {} });

  assert.match(calls[0]!.prompt, /Sort by aisle\.[\s\S]*the earlier draft[\s\S]*Empty aisles go last/);
});

// Protects: the draft a person already has when a session fails. Fails when: a session that stopped (at its $0.50, or any other way) overwrites or deletes draft.md.
test('a draft session that stops keeps the draft that was there and says why', () => {
  const folder = draftFolder('Sort by aisle.');
  write(folder, 'draft.md', 'the earlier draft');
  const { agent } = fakeAgent([() => ({ ok: false, status: 'error_max_budget_usd' })]);

  assert.throws(() => writeDraft({ ...deps(agent), folder, cwd: makeRepo(), env: {} }), /error_max_budget_usd.*\$0\.5/);
  assert.equal(readFileSync(join(folder, 'draft.md'), 'utf8'), 'the earlier draft');
});

// Protects: criterion 2's "no GitHub token" from a launcher that passes one anyway. Fails when: a draft session starts with a GitHub token in its environment.
test('animus draft refuses to start with a GitHub token in its environment', () => {
  const { agent, calls } = fakeAgent([]);
  for (const name of ['ANIMUS_GH_TOKEN_FILE', 'GH_TOKEN', 'GITHUB_TOKEN']) {
    assert.throws(() => writeDraft({ ...deps(agent), folder: draftFolder('x'), cwd: makeRepo(), env: { [name]: 'x' } }), new RegExp(`${name}.*GitHub token`));
  }
  assert.equal(calls.length, 0);
});

// Protects: what Claude Code is told for a draft session: the fast model, the $0.50 stop and no tool that reaches past the files. Fails when: agent.ts lets a files-only session have Bash, WebFetch or WebSearch, or the CLI does not write draft.md.
test('the animus draft command runs Claude Code with file tools only, the fast model and a $0.50 stop', () => {
  const bin = mkdtempSync(join(tmpdir(), 'animus-claude-bin-'));
  const said = join(bin, 'args.txt');
  writeFileSync(join(bin, 'claude'), `#!/bin/sh\nprintf '%s\\n' "$@" > "${said}"\nprintf '%s\\n' '{"result":"","structured_output":{"spec":"# Sort by aisle\\n"},"total_cost_usd":0.1,"session_id":"s1"}'\n`);
  chmodSync(join(bin, 'claude'), 0o755);
  const folder = draftFolder('Sort by aisle.');
  const env: NodeJS.ProcessEnv = { ...process.env, ANIMUS_CLAUDE: join(bin, 'claude') };
  for (const name of ['ANIMUS_GH_TOKEN_FILE', 'GH_TOKEN', 'GITHUB_TOKEN']) delete env[name];

  const r = spawnSync(process.execPath, ['--disable-warning=ExperimentalWarning', cli, 'draft', folder, '--repo', makeRepo()], { encoding: 'utf8', env });

  assert.equal(r.status, 0, r.stderr);
  assert.equal(readFileSync(join(folder, 'draft.md'), 'utf8'), '# Sort by aisle\n');
  const args = readFileSync(said, 'utf8');
  assert.match(args, /--model\nhaiku\n/);
  assert.match(args, /--max-budget-usd\n0\.5\n/);
  assert.match(args, /--allowedTools\nRead\nGlob\nGrep\n--disallowedTools\n/);
  for (const tool of ['Bash', 'WebFetch', 'WebSearch', 'Edit', 'Write']) assert.match(args.split('--disallowedTools\n')[1]!, new RegExp(`^${tool}$`, 'm'));
});
