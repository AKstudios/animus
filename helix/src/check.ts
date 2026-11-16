// Whether a person's credentials still work, asked of the services
// themselves: GitHub says who the token is and when it ends, a push that
// sends nothing says whether it may write to each repository, and one small
// Claude session says whether the Claude token answers. `helix check` runs
// all of it; the supervisor runs the GitHub part before each job, so a token
// that ended fails the job at once and says why.
import { spawnSync } from 'node:child_process';
import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import type { Agent } from '../../plugin/src/agent.ts';
import { credentialEnv, personEnv, type Config } from './config.ts';

export type Finding = { what: string; ok: boolean; detail: string };

/** The name and address GitHub credits a person's commits to. */
export type Identity = { name: string; email: string };

export type Ran = { code: number; stdout: string; stderr: string };
export type Runner = (command: string, args: string[], opts: { cwd?: string; env: Record<string, string> }) => Ran;

const run: Runner = (command, args, opts) => {
  const r = spawnSync(command, args, { cwd: opts.cwd, encoding: 'utf8', timeout: 60_000, env: { ...process.env, ...opts.env } });
  if (r.error) return { code: 1, stdout: '', stderr: (r.error as NodeJS.ErrnoException).code === 'ENOENT' ? `${command} is not installed or not on PATH` : r.error.message };
  return { code: r.status ?? 1, stdout: r.stdout, stderr: r.stderr };
};

const lastLine = (text: string) => text.trim().split('\n').pop() ?? '';

/** Warn this many days before a token ends. */
const SOON_DAYS = 7;

/** Who GitHub says the token is, and when it ends. */
export function githubToken(env: Record<string, string>, runner: Runner = run, today = Date.now()): Finding & { identity?: Identity } {
  const what = 'GitHub token';
  if (!env.GH_TOKEN && !env.GITHUB_TOKEN) return { what, ok: false, detail: 'the env file sets no GH_TOKEN' };
  const r = runner('gh', ['api', '-i', 'user'], { env });
  if (r.code !== 0) return { what, ok: false, detail: `GitHub refused it: ${lastLine(r.stderr || r.stdout)}` };
  const login = /"login"\s*:\s*"([^"]+)"/.exec(r.stdout)?.[1] ?? 'someone';
  const id = /"id"\s*:\s*(\d+)/.exec(r.stdout)?.[1];
  // The address GitHub gives every account, so a commit is theirs without their real one.
  const who = id && login !== 'someone' ? { identity: { name: login, email: `${id}+${login}@users.noreply.github.com` } } : {};
  // "2027-02-01 08:00:00 UTC", or with an offset; a token that never ends has no such header.
  const ends = /^github-authentication-token-expiration:\s*(.+)$/im.exec(r.stdout)?.[1]?.trim();
  if (!ends) return { what, ok: true, ...who, detail: `signs in as ${login}; it has no end date` };
  const at = Date.parse(ends.replace(' UTC', 'Z').replace(' ', 'T'));
  const days = Number.isNaN(at) ? undefined : Math.floor((at - today) / 86_400_000);
  if (days === undefined) return { what, ok: true, ...who, detail: `signs in as ${login}; ends ${ends}` };
  return { what, ok: true, ...who, detail: `signs in as ${login}; ends in ${days} day(s), on ${ends.slice(0, 10)}${days < SOON_DAYS ? ': replace it now' : ''}` };
}

/** Whether the token may push to a repository: a push that sends nothing still has to be let in. */
export function githubPush(name: string, repoDir: string, env: Record<string, string>, runner: Runner = run): Finding {
  const what = `push to ${name}`;
  const origin = runner('git', ['remote', 'get-url', 'origin'], { cwd: repoDir, env });
  if (origin.code !== 0) return { what, ok: false, detail: `${repoDir} has no origin` };
  const url = origin.stdout.trim();
  const r = runner('git', ['push', '--dry-run', 'origin', 'HEAD:refs/heads/animus/check'], { cwd: repoDir, env: { ...env, ...credentialEnv(env), GIT_TERMINAL_PROMPT: '0' } });
  if (r.code !== 0) return { what, ok: false, detail: `${url} refused: ${lastLine(r.stderr || r.stdout)}` };
  return { what, ok: true, detail: /^https?:/.test(url) ? url : `${url} (not https, so this used the machine's own key and not the person's token)` };
}

/** One small session, with only the person's variables and no sign-in kept on the machine to fall back on. */
export function claudeToken(env: Record<string, string>, agent: Agent): Finding {
  const what = 'Claude token';
  if (!env.CLAUDE_CODE_OAUTH_TOKEN && !env.ANTHROPIC_API_KEY) return { what, ok: false, detail: 'the env file sets neither CLAUDE_CODE_OAUTH_TOKEN nor ANTHROPIC_API_KEY' };
  const dir = mkdtempSync(join(tmpdir(), 'helix-check-'));
  try {
    const r = agent({ role: 'check', tier: 'fast', effort: 'low', prompt: 'Reply with the single word ok.', cwd: dir, readOnly: true, timeoutMs: 120_000, env: { ...env, CLAUDE_CONFIG_DIR: join(dir, 'config') } });
    return r.ok
      ? { what, ok: true, detail: `${env.CLAUDE_CODE_OAUTH_TOKEN ? 'the subscription token' : 'the API key'} answered (${r.model}, $${r.cost_usd.toFixed(4)})` }
      : { what, ok: false, detail: `no answer: ${r.text ? r.text.slice(0, 200) : r.status}` };
  } catch (err) {
    return { what, ok: false, detail: (err as Error).message };
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
}

/** Everything for one person. Without an agent the Claude token is not tried. */
export function checkPerson(config: Config, name: string, deps: { agent?: Agent; runner?: Runner } = {}): Finding[] {
  let env: Record<string, string>;
  try { env = personEnv(config.people[name]); } catch (err) { return [{ what: 'env file', ok: false, detail: (err as Error).message }]; }
  if (!config.people[name]?.env_file) return [{ what: 'env file', ok: false, detail: 'none was given (helix add-person <name> --env-file <file>), so their jobs would run with the machine\'s own sign-ins' }];
  const token = githubToken(env, deps.runner);
  const out = [token];
  if (token.ok) for (const [repo, dir] of Object.entries(config.repos)) out.push(githubPush(repo, dir, env, deps.runner));
  if (deps.agent) out.push(claudeToken(env, deps.agent));
  return out;
}

export const describeFindings = (person: string, findings: readonly Finding[]) =>
  [`${person}`, ...findings.map((f) => `  ${f.ok ? 'ok  ' : 'FAIL'} ${f.what}: ${f.detail}`)].join('\n');
