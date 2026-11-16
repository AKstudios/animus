import assert from 'node:assert/strict';
import { spawn } from 'node:child_process';
import { mkdirSync, mkdtempSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { test } from 'node:test';
import type { Agent, AgentRequest } from '../../plugin/src/agent.ts';
import { checkPerson, claudeToken, githubPush, githubToken, type Runner } from '../src/check.ts';
import { credentialEnv, hashToken, type Config } from '../src/config.ts';
import { openStore } from '../src/store.ts';
import { MAX_INTERRUPTIONS, supervise, type Launch } from '../src/supervisor.ts';

const USER = (expires?: string) => `HTTP/2.0 200 OK\n${expires ? `Github-Authentication-Token-Expiration: ${expires}\n` : ''}\n{"login":"ana","id":1}`;
const answers = (map: Record<string, { code?: number; stdout?: string; stderr?: string }>, seen: { command: string; env: Record<string, string> }[] = []): Runner => (command, args, opts) => {
  const line = `${command} ${args.join(' ')}`;
  seen.push({ command: line, env: opts.env });
  const hit = Object.entries(map).find(([k]) => line.startsWith(k))?.[1] ?? {};
  return { code: hit.code ?? 0, stdout: hit.stdout ?? '', stderr: hit.stderr ?? '' };
};

test('the GitHub token check says who it is and when it ends, and fails when GitHub refuses it or none is set', () => {
  const today = Date.parse('2026-11-16T00:00:00Z');
  const env = { GH_TOKEN: 't' };
  assert.deepEqual(githubToken({}, answers({})), { what: 'GitHub token', ok: false, detail: 'the env file sets no GH_TOKEN' });
  assert.match(githubToken(env, answers({ 'gh api': { stdout: USER() } }), today).detail, /signs in as ana; it has no end date/);
  assert.match(githubToken(env, answers({ 'gh api': { stdout: USER('2027-02-14 08:00:00 UTC') } }), today).detail, /ends in 90 day\(s\), on 2027-02-14$/);
  assert.match(githubToken(env, answers({ 'gh api': { stdout: USER('2026-11-19 00:00:00 UTC') } }), today).detail, /ends in 3 day\(s\).*replace it now/);
  const refused = githubToken(env, answers({ 'gh api': { code: 1, stderr: 'gh: Bad credentials (HTTP 401)' } }), today);
  assert.deepEqual([refused.ok, refused.detail], [false, 'GitHub refused it: gh: Bad credentials (HTTP 401)']);
});

test('the push check sends nothing, gives git the person\'s token for https only, and says when a remote would not use it', () => {
  const env = { GH_TOKEN: 't' };
  const seen: { command: string; env: Record<string, string> }[] = [];
  const ok = githubPush('app', '/r', env, answers({ 'git remote': { stdout: 'https://github.com/o/app.git\n' } }, seen));
  assert.deepEqual([ok.ok, ok.detail], [true, 'https://github.com/o/app.git']);
  const push = seen.find((s) => s.command.startsWith('git push'))!;
  assert.match(push.command, /--dry-run/);
  assert.deepEqual([push.env.GIT_CONFIG_VALUE_0, push.env.GIT_CONFIG_VALUE_1, push.env.GIT_TERMINAL_PROMPT], ['', '!gh auth git-credential', '0']);
  assert.deepEqual(credentialEnv({}), {});

  assert.match(githubPush('app', '/r', env, answers({ 'git remote': { stdout: 'git@github.com:o/app.git\n' } })).detail, /not https, so this used the machine's own key/);
  const refused = githubPush('app', '/r', env, answers({ 'git remote': { stdout: 'https://github.com/o/app.git\n' }, 'git push': { code: 128, stderr: 'remote: Permission denied\nfatal: unable to access: 403' } }));
  assert.deepEqual([refused.ok, refused.detail], [false, 'https://github.com/o/app.git refused: fatal: unable to access: 403']);
});

test('the Claude token check runs one small session with the person\'s variables and no sign-in kept on the machine', () => {
  const asked: AgentRequest[] = [];
  const agent = (ok: boolean): Agent => (req) => { asked.push(req); return { ok, status: ok ? 'success' : 'exit 1: Invalid bearer token', text: '', provider: 'claude', model: 'haiku', cost_usd: 0.001, turns: 1, tokens: { input: 0, output: 0, cache_read: 0, cache_write: 0 }, ms: 1 }; };
  assert.equal(claudeToken({}, agent(true)).ok, false);
  assert.equal(asked.length, 0);
  assert.match(claudeToken({ CLAUDE_CODE_OAUTH_TOKEN: 'x' }, agent(true)).detail, /the subscription token answered \(haiku, \$0\.0010\)/);
  assert.deepEqual([asked[0]!.tier, asked[0]!.readOnly, asked[0]!.env!.CLAUDE_CODE_OAUTH_TOKEN, Boolean(asked[0]!.env!.CLAUDE_CONFIG_DIR)], ['fast', true, 'x', true]);
  assert.match(claudeToken({ ANTHROPIC_API_KEY: 'x' }, agent(false)).detail, /no answer: exit 1: Invalid bearer token/);
});

test('a person with no env file fails the check, and the repositories are tried only with a token GitHub accepts', () => {
  const home = mkdtempSync(join(tmpdir(), 'helix-check-'));
  writeFileSync(join(home, 'ana.env'), 'GH_TOKEN=t\n');
  const config: Config = { host: '127.0.0.1', port: 0, slots: 1, repos: { app: '/r' }, people: { ana: { token_sha256: 'x', env_file: join(home, 'ana.env') }, ben: { token_sha256: 'y' } } };
  assert.match(checkPerson(config, 'ben')[0]!.detail, /none was given/);
  const good = checkPerson(config, 'ana', { runner: answers({ 'gh api': { stdout: USER() }, 'git remote': { stdout: 'https://github.com/o/app.git' } }) });
  assert.deepEqual(good.map((f) => [f.what, f.ok]), [['GitHub token', true], ['push to app', true]]);
  const bad = checkPerson(config, 'ana', { runner: answers({ 'gh api': { code: 1, stderr: 'HTTP 401' } }) });
  assert.deepEqual(bad.map((f) => [f.what, f.ok]), [['GitHub token', false]]);
});

/** A Helix home with one job the table calls running, as a crash leaves it. */
function crashed(job: { pid?: number; started?: string; interrupted?: number }) {
  const home = mkdtempSync(join(tmpdir(), 'helix-'));
  mkdirSync(join(home, 'repo'));
  const config: Config = { host: '127.0.0.1', port: 0, slots: 1, repos: { app: join(home, 'repo') }, people: { ana: { token_sha256: hashToken('t') } } };
  const store = openStore(join(home, 'helix.db'));
  const added = store.add({ state: 'running', person: 'ana', repo: 'app', spec: join(home, 'spec.md'), title: 'x', draft: false, submitted: new Date().toISOString(), ...job });
  const launch: Launch = () => ({ command: process.execPath, args: ['-e', 'setInterval(() => {}, 1000)'] });
  return { home, config, store, id: added.id, launch };
}

test('a job found running too many times when Helix comes back is ended, not started again', () => {
  const c = crashed({ interrupted: MAX_INTERRUPTIONS - 1 });
  const s = supervise({ store: c.store, config: c.config, home: c.home, launch: c.launch });
  const job = c.store.get(c.id)!;
  assert.deepEqual([job.state, job.outcome, job.interrupted], ['ended', 'failed', MAX_INTERRUPTIONS]);
  assert.match(job.reason!, /stopped 3 times while this job ran/);
  s.stop();
  c.store.close();
});

test('a pid recorded before the machine last started is left alone: it is no longer the job', async () => {
  const other = spawn(process.execPath, ['-e', 'setInterval(() => {}, 1000)'], { detached: process.platform !== 'win32', stdio: 'ignore' });
  const c = crashed({ pid: other.pid!, started: '2000-01-01T00:00:00.000Z' });
  const s = supervise({ store: c.store, config: c.config, home: c.home, launch: c.launch });
  await new Promise((r) => { setTimeout(r, 200); });
  assert.deepEqual([other.exitCode, other.signalCode], [null, null]);
  assert.deepEqual([c.store.get(c.id)!.state, c.store.get(c.id)!.interrupted], ['running', 1]);
  s.stop();
  other.kill();
  c.store.close();
});

test('a job whose credentials fail the look before it starts ends at once with the reason', () => {
  const c = crashed({});
  c.store.save({ ...c.store.get(c.id)!, state: 'queued' });
  const s = supervise({ store: c.store, config: c.config, home: c.home, launch: c.launch, preflight: (person) => `${person}'s GitHub token ended` });
  const job = c.store.get(c.id)!;
  assert.deepEqual([job.state, job.outcome, job.reason], ['ended', 'failed', 'ana\'s GitHub token ended']);
  s.stop();
  c.store.close();
});
