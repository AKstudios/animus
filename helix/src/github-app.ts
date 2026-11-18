// Helix's GitHub App, as a client of GitHub (docs/adr/0005): the device flow
// that signs a person in with nothing but the app's client ID, the refresh
// that trades their refresh token for a fresh access token, and the
// repositories the app reaches for them. No secret or key: GitHub needs none
// for device-flow tokens. `helix github setup` is here too: it proves the
// client ID with a device-code request before config.yaml keeps it.
import { chmodSync, existsSync, mkdirSync, renameSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';
import { AnimusError } from '../../plugin/src/proc.ts';
import type { Finding } from './check.ts';
import { envFileVars, helixHome, updateConfig, type Config } from './config.ts';
import type { Store } from './store.ts';

/** Where GitHub's sign-in (web) and REST API live; tests point both at a fake. */
export type GitHubUrls = { web: string; api: string };
export const GITHUB: GitHubUrls = { web: 'https://github.com', api: 'https://api.github.com' };

/** What GitHub hands out to start the device flow: user_code is what the person types at verification_uri. */
export type DeviceCode = { device_code: string; user_code: string; verification_uri: string; expires_in: number; interval: number };

/** A user access token (eight hours) and the refresh token (six months, one use) that gets the next. */
export type Tokens = { access_token: string; expires_in: number; refresh_token: string; refresh_token_expires_in: number };

/** GitHub said no; code is its error, as in access_denied or bad_refresh_token, and the message its reason. */
export class GitHubRefused extends AnimusError {
  code: string;
  /** With slow_down: the seconds GitHub now wants between polls. */
  interval?: number;
  constructor(code: string, reason: string, interval?: number) {
    super(reason);
    this.code = code;
    if (interval) this.interval = interval;
  }
}

export const sleep = (seconds: number) => new Promise<void>((r) => { setTimeout(r, seconds * 1000); });

/** Where an account's owner installs the app, choosing the account and its repositories on GitHub. */
export const installLink = (slug: string, urls = GITHUB) => `${urls.web}/apps/${slug}/installations/new`;

async function call(url: string, init: RequestInit): Promise<{ status: number; answer: Record<string, unknown> }> {
  let res: Response;
  try { res = await fetch(url, init); } catch (err) { throw new AnimusError(`GitHub could not be reached: ${(err as Error).message}`); }
  const answer = (await res.json().catch(() => ({}))) as Record<string, unknown>;
  return { status: res.status, answer };
}

/** A POST to github.com/login/...; GitHub's refusal, often with HTTP 200, is thrown as GitHubRefused. */
async function oauth(path: string, body: Record<string, string>, urls: GitHubUrls): Promise<Record<string, unknown>> {
  const { status, answer } = await call(`${urls.web}${path}`, { method: 'POST', headers: { accept: 'application/json', 'content-type': 'application/x-www-form-urlencoded' }, body: new URLSearchParams(body) });
  if (typeof answer.error === 'string' || status >= 400) {
    const code = typeof answer.error === 'string' ? answer.error : `http_${status}`;
    const reason = typeof answer.error_description === 'string' ? `${answer.error_description} (${code})` : code;
    throw new GitHubRefused(code, reason, typeof answer.interval === 'number' ? answer.interval : undefined);
  }
  return answer;
}

/** A GET of GitHub's REST API as the person. */
async function api(path: string, token: string, urls: GitHubUrls): Promise<Record<string, unknown>> {
  const { status, answer } = await call(`${urls.api}${path}`, { headers: { accept: 'application/vnd.github+json', authorization: `Bearer ${token}`, 'x-github-api-version': '2022-11-28' } });
  if (status >= 400) throw new GitHubRefused(`http_${status}`, `GitHub refused ${path}: ${typeof answer.message === 'string' ? answer.message : `HTTP ${status}`}`);
  return answer;
}

/** Starts the device flow: the code the person types at GitHub. */
export const deviceCode = async (clientId: string, urls = GITHUB) =>
  (await oauth('/login/device/code', { client_id: clientId }, urls)) as DeviceCode;

/**
 * Polls GitHub until the person approves the code, at the pace GitHub asks,
 * and returns their tokens. A cancel, or a code that ended, throws
 * GitHubRefused with GitHub's code (access_denied, expired_token).
 */
export async function pollDevice(clientId: string, code: DeviceCode, urls = GITHUB, wait = sleep): Promise<Tokens> {
  let interval = code.interval;
  for (;;) {
    try {
      return (await oauth('/login/oauth/access_token', { client_id: clientId, device_code: code.device_code, grant_type: 'urn:ietf:params:oauth:grant-type:device_code' }, urls)) as Tokens;
    } catch (err) {
      if (!(err instanceof GitHubRefused)) throw err;
      // slow_down carries the new interval GitHub wants; without it, five seconds more.
      if (err.code === 'slow_down') interval = err.interval ?? interval + 5;
      else if (err.code !== 'authorization_pending') throw err;
    }
    await wait(interval);
  }
}

/** Trades a refresh token for a new pair; the old refresh token stops working, so the caller keeps the new one. */
export const refreshTokens = async (clientId: string, refreshToken: string, urls = GITHUB) =>
  (await oauth('/login/oauth/access_token', { client_id: clientId, grant_type: 'refresh_token', refresh_token: refreshToken }, urls)) as Tokens;

/** Who an access token acts for. */
export async function githubUser(token: string, urls = GITHUB): Promise<{ login: string; id: number }> {
  const user = await api('/user', token, urls);
  return { login: String(user.login), id: Number(user.id) };
}

/**
 * The repositories (owner/name) the app reaches for the person: those of
 * every installation they can see that they have access to. slug is the
 * app's, for its installation link, when they can see any installation.
 */
export async function reachableRepos(token: string, urls = GITHUB): Promise<{ repos: string[]; slug?: string; missing: Record<string, string[]> }> {
  const installs = (await pages('/user/installations', 'installations', token, urls)) as { id: number; app_slug?: string; permissions?: Record<string, string> }[];
  const repos: string[] = [];
  const missing: Record<string, string[]> = {};
  for (const inst of installs) {
    const listed = (await pages(`/user/installations/${inst.id}/repositories`, 'repositories', token, urls)) as { full_name: string }[];
    repos.push(...listed.map((r) => r.full_name));
    const lacks = JOB_PERMISSIONS.filter((p) => inst.permissions?.[p] !== 'write');
    if (lacks.length) for (const r of listed) missing[r.full_name.toLowerCase()] = lacks;
  }
  const slug = installs.find((i) => i.app_slug)?.app_slug;
  return { repos, ...(slug ? { slug } : {}), missing };
}

/**
 * What a job needs the app to have, as write, on its repository's installation:
 * contents to push its branch, pull_requests to open its pull request. An
 * installation keeps the permissions it was installed with until its owner
 * accepts the app's new ones, so each installation is read, not the app.
 */
export const JOB_PERMISSIONS = ['contents', 'pull_requests'] as const;

/** What to tell a person whose repository's installation lacks some of JOB_PERMISSIONS. */
export const permissionsAdvice = (full: string, lacks: readonly string[]) =>
  `Helix's GitHub App may not write ${lacks.map((p) => p.replace('_', ' ')).join(' or ')} in ${full}, so its jobs could not ${lacks.includes('contents') ? 'push' : 'open their pull requests'}: the app needs Contents and Pull requests set to Read and write, and ${full.split('/')[0]} has to accept them (Settings, GitHub Apps, the app, Review request)`;

/** Every page of a list GitHub pages. */
async function pages(path: string, key: string, token: string, urls: GitHubUrls): Promise<unknown[]> {
  const all: unknown[] = [];
  for (let page = 1; ; page++) {
    const items = ((await api(`${path}?per_page=100&page=${page}`, token, urls))[key] ?? []) as unknown[];
    all.push(...items);
    if (items.length < 100) return all;
  }
}

/** A repository's owner/name on GitHub, from its clone address (https or ssh). */
export const githubRepo = (url: string) => /github\.com[:/]([^/]+\/[^/]+?)(?:\.git)?\/?$/.exec(url)?.[1];

/**
 * How long before its eight hours are up an access token is renewed. GitHub
 * ends the old access token the moment its refresh token is used, so renewing
 * is left as late as is safe, never done because a job starts.
 */
export const RENEW_WITHIN_MS = 60 * 60 * 1000;

/**
 * The folder holding a person's current access token, alone, in `gh-token`.
 * It is mounted read-only into their jobs, which read the token from it each
 * time they push or call gh, so a renewal during a job does not strand it with
 * an ended token. The folder is mounted rather than the file: the file is
 * replaced by a rename, which a mount of the file itself would not see.
 */
export const liveTokenDir = (name: string) => join(helixHome(), 'tokens', name);
export const liveTokenFile = (name: string) => join(liveTokenDir(name), 'gh-token');

/** Replaces the person's live token in one step, so a job never reads half of one. */
export function keepLiveToken(name: string, token: string): void {
  const dir = liveTokenDir(name);
  mkdirSync(dir, { recursive: true, mode: 0o700 });
  const next = join(dir, `.gh-token-${process.pid}`);
  writeFileSync(next, token, { mode: 0o600 });
  renameSync(next, liveTokenFile(name));
}

/** Puts a new pair, and when the access token ends, in a person's credentials file, keeping its other lines, readable by Helix's account only; and the access token in their live token file. */
export function keepTokens(name: string, file: string, tokens: Tokens, now = Date.now()): void {
  const kept = { ...envFileVars(file), GH_TOKEN: tokens.access_token, GH_REFRESH_TOKEN: tokens.refresh_token, GH_TOKEN_EXPIRES: new Date(now + tokens.expires_in * 1000).toISOString() };
  writeFileSync(file, Object.entries(kept).map(([k, v]) => `${k}=${v}\n`).join(''), { mode: 0o600 });
  chmodSync(file, 0o600);
  keepLiveToken(name, tokens.access_token);
}

/** Each credentials file's refresh in this process, one after another: a refresh token works once. */
const refreshing = new Map<string, Promise<unknown>>();

/**
 * The person's access token, good for at least RENEW_WITHIN_MS more: the one
 * they have, or, within that last stretch of its eight hours (or with no end
 * kept, from before ends were kept), a new one for their refresh token, with
 * the new pair kept. Undefined on a Helix without the app, or for a person
 * who pasted a token instead. GitHub's refusal (revoked, or unused for six
 * months) is the person's to fix.
 */
export function freshToken(store: Store, config: Pick<Config, 'github'>, name: string, urls = GITHUB, now = Date.now): Promise<string | undefined> {
  const file = store.person(name)?.env_file;
  // A credentials file that is gone is said by whatever reads it next.
  if (!config.github || !file || !existsSync(file)) return Promise.resolve(undefined);
  const clientId = config.github.client_id;
  const next = (refreshing.get(file) ?? Promise.resolve()).catch(() => {}).then(async () => {
    const held = envFileVars(file);
    const used = held.GH_REFRESH_TOKEN;
    if (!used) return undefined;
    if (held.GH_TOKEN && Date.parse(held.GH_TOKEN_EXPIRES ?? '') - now() > RENEW_WITHIN_MS) {
      if (!existsSync(liveTokenFile(name))) keepLiveToken(name, held.GH_TOKEN);
      return held.GH_TOKEN;
    }
    try {
      const tokens = await refreshTokens(clientId, used, urls);
      keepTokens(name, file, tokens, now());
      return tokens.access_token;
    } catch (err) {
      if (!(err instanceof GitHubRefused)) throw err;
      // Another helix process (helix check beside helix serve) spent it a moment ago and kept the next.
      const now = envFileVars(file);
      if (now.GH_REFRESH_TOKEN !== used) return now.GH_TOKEN;
      throw new AnimusError(`GitHub no longer takes your sign-in (${err.message}): run \`animus github login\``);
    }
  });
  refreshing.set(file, next);
  return next;
}

/**
 * What runs before each job on a Helix with the app: a fresh token in the
 * person's credentials file, and the project within the app's reach for
 * them. Throws why the job cannot run.
 */
export const beforeJob = (store: Store, config: Pick<Config, 'github'>, urls = GITHUB) => async (person: string, repo: string): Promise<void> => {
  const token = await freshToken(store, config, person, urls);
  const full = githubRepo(store.project(repo)?.url ?? '');
  if (!token || !full) return;
  const reach = await reachableRepos(token, urls);
  const lacks = reach.missing[full.toLowerCase()];
  if (lacks) throw new AnimusError(permissionsAdvice(full, lacks));
  if (reach.repos.some((r) => r.toLowerCase() === full.toLowerCase())) return;
  throw new AnimusError(`Helix's GitHub App cannot reach ${full} for you: ask its owner to install the app on it${reach.slug ? ` at ${installLink(reach.slug, urls)}` : ''}`);
};

/**
 * Renews, when due, the token of everyone with a job running: a running job
 * reads it from their live token file, so this keeps a job that runs past its
 * token's eight hours able to push. helix serve runs it every few minutes.
 */
export async function renewForRunningJobs(store: Store, config: Pick<Config, 'github'>, say: (line: string) => void, urls = GITHUB, now = Date.now): Promise<void> {
  if (!config.github) return;
  const people = [...new Set(store.list().filter((j) => j.state === 'running').map((j) => j.person))];
  await Promise.all(people.map((person) => freshToken(store, config, person, urls, now).catch((err: unknown) => {
    say(`${person}'s GitHub sign-in could not be renewed: ${(err as Error).message}`);
  })));
}

/** helix check's line for a person who signed in with the app: their sign-in, renewed when due, and tried. */
export async function checkSignIn(store: Store, config: Pick<Config, 'github'>, name: string, urls = GITHUB): Promise<Finding[]> {
  try {
    const token = await freshToken(store, config, name, urls);
    if (!token) return [];
    return [{ what: 'GitHub sign-in', ok: true, detail: `signs in as ${(await githubUser(token, urls)).login}` }];
  } catch (err) {
    return [{ what: 'GitHub sign-in', ok: false, detail: (err as Error).message }];
  }
}

/**
 * helix github setup: proves the client ID with a device-code request, which
 * GitHub refuses for an unknown ID or an app without the device flow, then
 * writes github: {client_id} to config.yaml. A refused ID writes nothing.
 * The device code it starts is left to end by itself.
 */
export async function githubSetup(clientId: string, urls = GITHUB): Promise<void> {
  const id = clientId.trim();
  if (!/^[\x21-\x7e]+$/.test(id)) throw new AnimusError('a client ID is one word, as in Iv23li...: on GitHub, the app\'s settings, under About');
  try { await deviceCode(id, urls); } catch (err) {
    if (err instanceof GitHubRefused) throw new AnimusError(`GitHub refused the client ID ${id}: ${err.message}. Nothing was written`);
    throw err;
  }
  updateConfig({ github: { client_id: id } });
}
