// The client side of Helix (docs/factory.md, "The office machine"): submit a
// spec to the machine that runs jobs, and ask about it. Five thin HTTP calls;
// the result never depends on them, since it lands as a pull request.
import { chmodSync, existsSync, mkdirSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import { dirname, join as joinPath } from 'node:path';
import { animusHome } from './log.ts';
import { AnimusError } from './proc.ts';
import { animusVersion } from './version.ts';

/** How a client tells Helix its version; Helix refuses one it cannot work with (version.ts, compatible). */
export const VERSION_HEADER = 'animus-version';

/** A job as Helix reports it. */
export type RemoteJob = {
  id: number; state: string; person: string; repo: string; title: string; submitted: string; started?: string; ended?: string;
  animus_job?: string; outcome?: string; pr?: string; reason?: string; question?: string; cost_usd?: number; log?: string;
};

/** Where `animus join` keeps the address and token it was given: the owner's eyes only. */
export const helixFile = (home = animusHome()) => joinPath(home, 'helix.json');

export type HelixLogin = { url: string; token: string; name?: string };

/** The Helix this client talks to: HELIX_URL and HELIX_TOKEN when both are set, else what `animus join` kept. */
export function helixLogin(env: NodeJS.ProcessEnv = process.env, file = helixFile()): (HelixLogin & { from: string }) | undefined {
  if (env.HELIX_URL && env.HELIX_TOKEN) return { url: env.HELIX_URL, token: env.HELIX_TOKEN, from: 'HELIX_URL and HELIX_TOKEN' };
  if (!existsSync(file)) return undefined;
  try {
    const saved = JSON.parse(readFileSync(file, 'utf8')) as Partial<HelixLogin>;
    if (typeof saved.url === 'string' && typeof saved.token === 'string') return { url: saved.url, token: saved.token, ...(saved.name ? { name: saved.name } : {}), from: file };
  } catch { /* unreadable: as if not there */ }
  return undefined;
}

export function saveHelixLogin(login: HelixLogin, file = helixFile()): void {
  mkdirSync(dirname(file), { recursive: true });
  writeFileSync(file, `${JSON.stringify(login, null, 2)}\n`, { mode: 0o600 });
  chmodSync(file, 0o600);
}

export const forgetHelixLogin = (file = helixFile()) => rmSync(file, { force: true });

const unreachable = (url: string, err: unknown) => new AnimusError(`could not reach Helix at ${url}: ${(err as Error).cause instanceof Error ? ((err as Error).cause as Error).message : (err as Error).message}`);

async function request<T>(method: string, url: string, path: string, token: string | undefined, body?: unknown): Promise<T> {
  let res: Response;
  try {
    res = await fetch(new URL(path, url), { method, headers: { ...(token ? { authorization: `Bearer ${token}` } : {}), 'content-type': 'application/json', [VERSION_HEADER]: animusVersion() }, ...(body === undefined ? {} : { body: JSON.stringify(body) }) });
  } catch (err) { throw unreachable(url, err); }
  const value = (await res.json().catch(() => ({}))) as { error?: string };
  if (!res.ok) throw new AnimusError(`Helix refused: ${value.error ?? res.statusText}`);
  return value as T;
}

async function call<T>(method: string, path: string, body?: unknown): Promise<T> {
  const login = helixLogin();
  if (!login) throw new AnimusError('this machine has not joined a Helix: animus join <url> <code>, with a code from whoever runs it (or set HELIX_URL and HELIX_TOKEN)');
  return request<T>(method, login.url, path, login.token, body);
}

/** Helix's version, asked without a token: what `animus doctor` compares with its own. */
export async function helixVersion(url: string): Promise<string> {
  let res: Response;
  try { res = await fetch(new URL('/version', url), { signal: AbortSignal.timeout(5000) }); } catch (err) { throw unreachable(url, err); }
  const value = (await res.json().catch(() => ({}))) as { version?: string };
  if (!res.ok || !value.version) throw new AnimusError(`Helix at ${url} did not say its version (${res.status}): it predates versioned releases`);
  return value.version;
}

export const submit = (s: { repo: string; spec: string; name: string; draft?: boolean }) => call<RemoteJob>('POST', '/jobs', s);
export const jobs = () => call<{ slots: number; jobs: RemoteJob[] }>('GET', '/jobs');
export const job = (id: string) => call<RemoteJob>('GET', `/jobs/${encodeURIComponent(id)}`);
export const cancel = (id: string) => call<RemoteJob>('POST', `/jobs/${encodeURIComponent(id)}/cancel`);
export const answer = (id: string, text: string) => call<RemoteJob>('POST', `/jobs/${encodeURIComponent(id)}/answer`, { answer: text });
export const leave = () => call<{ name: string; cancelled: number[]; kept?: string }>('POST', '/leave');

/** What an invite is for: asked with its code, before any token exists. */
export type InviteDetails = { name: string; github?: string; expires: string; repos: { name: string; url: string }[] };
export const inviteDetails = (url: string, code: string) => request<InviteDetails>('POST', url, '/invite', undefined, { code });
export const join = (url: string, code: string, tokens: { claude_token: string; github_token: string }) =>
  request<{ name: string; token: string; github?: string }>('POST', url, '/join', undefined, { code, ...tokens });

const how = (j: RemoteJob) => (j.state === 'ended' ? j.outcome ?? 'ended' : j.state);

/** `animus status`: one line per job, newest last. */
export function describeJobs(list: readonly RemoteJob[]): string {
  if (!list.length) return 'no jobs';
  const rows = list.map((j) => [String(j.id), j.person, j.repo, how(j), j.title, j.pr ?? j.question ?? j.reason?.split('\n')[0]?.slice(0, 60) ?? '']);
  const widths = rows[0]!.map((_, i) => Math.max(...rows.map((row) => row[i]!.length)));
  return rows.map((row) => row.map((cell, i) => cell.padEnd(widths[i]!)).join('  ').trimEnd()).join('\n');
}

/** `animus status <id>`: the job, then the end of its log. */
export function describeJob(j: RemoteJob): string {
  return [
    `job ${j.id}: ${j.title}`,
    `  ${how(j)}${j.pr ? `: ${j.pr}` : ''}`,
    `  for ${j.person} on ${j.repo}, submitted ${j.submitted.slice(0, 16).replace('T', ' ')}`,
    ...(j.question ? [`  it asks: ${j.question}`, `  answer with: animus answer ${j.id} "<your answer>"`] : []),
    ...(j.reason ? [`  reason: ${j.reason.split('\n')[0]}`] : []),
    ...(j.log ? ['', j.log] : []),
  ].join('\n');
}
