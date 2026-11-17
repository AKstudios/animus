// Helix's GitHub App, as a client of GitHub (docs/adr/0005): the device flow
// that signs a person in with nothing but the app's client ID, the refresh
// that trades their refresh token for a fresh access token, and the
// repositories the app reaches for them. No secret or key: GitHub needs none
// for device-flow tokens. `helix github setup` is here too: it proves the
// client ID with a device-code request before config.yaml keeps it.
import { AnimusError } from '../../plugin/src/proc.ts';
import { updateConfig } from './config.ts';

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

const sleep = (seconds: number) => new Promise<void>((r) => { setTimeout(r, seconds * 1000); });

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
export async function reachableRepos(token: string, urls = GITHUB): Promise<{ repos: string[]; slug?: string }> {
  const installs = (await pages('/user/installations', 'installations', token, urls)) as { id: number; app_slug?: string }[];
  const repos: string[] = [];
  for (const inst of installs) {
    const listed = (await pages(`/user/installations/${inst.id}/repositories`, 'repositories', token, urls)) as { full_name: string }[];
    repos.push(...listed.map((r) => r.full_name));
  }
  const slug = installs.find((i) => i.app_slug)?.app_slug;
  return { repos, ...(slug ? { slug } : {}) };
}

/** Every page of a list GitHub pages. */
async function pages(path: string, key: string, token: string, urls: GitHubUrls): Promise<unknown[]> {
  const all: unknown[] = [];
  for (let page = 1; ; page++) {
    const items = ((await api(`${path}?per_page=100&page=${page}`, token, urls))[key] ?? []) as unknown[];
    all.push(...items);
    if (items.length < 100) return all;
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
