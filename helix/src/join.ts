// Joining Helix without anyone setting it up by hand (docs/factory.md,
// "Registration and credentials"). Whoever runs the machine invites a person
// by name and passes them a one-time code; `animus join` sends the code with
// the person's Claude and GitHub tokens, Helix tries both for real, and only
// then takes the code, keeps the tokens and gives back the person's Helix
// token. Leaving is the same as `helix remove-person`, asked by the person.
//
// Codes, not Tailscale's identity headers: anything on the machine can send
// those headers to 127.0.0.1, so they prove nothing about who is asking.
//
// On a Helix with a GitHub App (config.yaml's github:), there is no GitHub
// token to paste: Helix starts GitHub's device flow for the code, the laptop
// shows GitHub's code and waits, and Helix polls GitHub until the person
// approves, so their tokens go from GitHub to Helix and never to the laptop.
import { spawn } from 'node:child_process';
import { randomBytes } from 'node:crypto';
import { chmodSync, mkdirSync, rmSync, writeFileSync } from 'node:fs';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { failing, type Finding } from './check.ts';
import { AnimusError } from '../../plugin/src/proc.ts';
import { addPerson, checkName, hashToken, helixHome, removePerson, type Config } from './config.ts';
import { personDirs } from './container.ts';
import { deviceCode, GitHubRefused, githubRepo, githubUser, installLink, keepTokens, pollDevice, reachableRepos, sleep, type GitHubUrls, type Tokens } from './github-app.ts';
import { keepOwner } from './owner.ts';
import { SLACK_USER } from './slack-api.ts';
import type { Invite, Store } from './store.ts';
import { cancelJobsOf, Refused } from './supervisor.ts';
import type { HelixJob } from './store.ts';

export const INVITE_HOURS = 24;

/**
 * Where a person's tokens are kept: beside their folder, not in it, since
 * their folder is mounted into their jobs' containers.
 */
export const credentialsFile = (name: string) => join(helixHome(), 'credentials', `${name}.env`);

/** Tries a person's tokens: `helix check`'s findings, and who the GitHub token signs in as. */
export type Verify = (env: Record<string, string>) => Promise<{ findings: Finding[]; login?: string }>;

/** What the person is told about an invite before they make their tokens. */
export type InviteDetails = { name: string; github?: string; expires: string; repos: { name: string; url: string }[] };

/**
 * Helix's GitHub App, for joining with GitHub's sign-in: its client ID from
 * config.yaml. urls and wait point GitHub elsewhere and pace the polls, for
 * tests; holdSeconds is how long one POST /join waits on GitHub before it
 * answers "still waiting", kept under the five minutes a client waits for an
 * answer.
 */
export type JoinGitHub = { clientId: string; urls?: GitHubUrls; wait?: (seconds: number) => Promise<void>; holdSeconds?: number };

/** What the person types at GitHub, and where; device_code comes back with POST /join. */
export type DeviceStart = { device_code: string; user_code: string; verification_uri: string; expires_in: number };

/** A project Helix's app cannot reach for the person, and where its owner installs the app (unknown while the app reaches nothing of theirs). */
export type Unreachable = { project: string; owner: string; install?: string; missing?: string[] };

export type Joined = { name: string; token: string; github?: string; cannot_push: string[]; unreachable?: Unreachable[] };

/** GitHub has not been approved yet: POST /join answers 202 and the client asks again. */
export class StillWaiting extends Error {}

const HOLD_SECONDS = 120;

const JOIN_AGAIN = 'The code still works: run animus join again';
const LOGIN_AGAIN = 'Run animus github login again';

/** GitHub's refusal, or GitHub out of reach, as Helix's answer: nothing was kept, so the person tries again. */
function refusedBy(err: unknown, again = JOIN_AGAIN): never {
  if (err instanceof GitHubRefused) throw new Refused(403, `GitHub refused the sign-in: ${err.message}. ${again}`);
  if (err instanceof AnimusError && !(err instanceof Refused)) throw new Refused(502, `${err.message}. ${again}`);
  throw err;
}

/** A device code from GitHub, for the person to type at its page. */
async function newDevice(github: JoinGitHub, again: string): Promise<DeviceStart> {
  try {
    const d = await deviceCode(github.clientId, github.urls);
    return { device_code: d.device_code, user_code: d.user_code, verification_uri: d.verification_uri, expires_in: d.expires_in };
  } catch (err) { return refusedBy(err, again); }
}

/** POST /join/device: starts GitHub's device flow for a live invite's code. */
export async function startDevice(store: Store, github: JoinGitHub | undefined, code: unknown, at?: Date): Promise<DeviceStart> {
  if (!github) throw new Refused(409, 'this Helix has no GitHub App: animus join asks for a GitHub token instead');
  liveInvite(store, code, at);
  return newDevice(github, JOIN_AGAIN);
}

const NO_APP = 'this Helix has no GitHub App, so there is no sign-in to renew: its owner runs helix github setup first';

/** POST /github/device: starts GitHub's device flow for a person already on Helix, for animus github login. */
export async function loginDevice(github: JoinGitHub | undefined): Promise<DeviceStart> {
  if (!github) throw new Refused(409, NO_APP);
  return newDevice(github, LOGIN_AGAIN);
}

/**
 * POST /github/login: the person signs in with GitHub again, when the
 * refresh stopped working, and their tokens are replaced. Only the GitHub
 * account they are on Helix as is taken; one that never had a login on
 * Helix gets the one that approved. StillWaiting: not approved yet.
 */
export async function relogin(store: Store, github: JoinGitHub | undefined, name: string, body: Record<string, unknown>): Promise<{ name: string; github: string }> {
  if (!github) throw new Refused(409, NO_APP);
  const person = store.person(name)!;
  if (!person.env_file) throw new Refused(409, `Helix keeps no credentials file for ${name}: ask its owner to add you again`);
  const { tokens, login } = await approved(github, body.device_code, LOGIN_AGAIN);
  if (person.github && login.toLowerCase() !== person.github.toLowerCase()) throw new Refused(403, `you are on Helix as the GitHub account ${person.github}, and ${login} approved the sign-in. Run animus github login again and approve as ${person.github}`);
  keepTokens(name, person.env_file, tokens);
  if (!person.github) store.putPerson(name, { ...person, github: login });
  return { name, github: login };
}

/** Polls GitHub for the device code until the person approves, or holdSeconds pass (StillWaiting). */
async function approved(github: JoinGitHub, device: unknown, again = JOIN_AGAIN): Promise<{ tokens: Tokens; login: string }> {
  if (typeof device !== 'string' || !device) throw new Refused(400, 'device_code is the one POST /join/device gave: this Helix signs you in with GitHub, not with a token');
  const wait = github.wait ?? sleep;
  const until = Date.now() + (github.holdSeconds ?? HOLD_SECONDS) * 1000;
  try {
    // GitHub's own pace is five seconds; a slow_down within this request is kept by pollDevice.
    const tokens = await pollDevice(github.clientId, { device_code: device, user_code: '', verification_uri: '', expires_in: 0, interval: 5 }, github.urls, async (s) => {
      await wait(s);
      if (Date.now() >= until) throw new StillWaiting();
    });
    return { tokens, login: (await githubUser(tokens.access_token, github.urls)).login };
  } catch (err) {
    if (err instanceof StillWaiting) throw err;
    return refusedBy(err, again);
  }
}

/** Helix's projects on GitHub that the app does not reach for the person's token. */
async function unreachable(store: Store, github: JoinGitHub, token: string): Promise<Unreachable[]> {
  let reach: Awaited<ReturnType<typeof reachableRepos>>;
  try { reach = await reachableRepos(token, github.urls); } catch (err) { return refusedBy(err); }
  const repos = new Set(reach.repos.map((r) => r.toLowerCase()));
  return store.projects().filter((p) => p.state === 'ready').flatMap((p): Unreachable[] => {
    const full = githubRepo(p.url);
    const lacks = full ? reach.missing[full.toLowerCase()] : undefined;
    if (full && lacks) return [{ project: p.name, owner: full.split('/')[0]!, missing: lacks }];
    if (!full || repos.has(full.toLowerCase())) return [];
    return [{ project: p.name, owner: full.split('/')[0]!, ...(reach.slug ? { install: installLink(reach.slug, github.urls) } : {}) }];
  });
}

/**
 * Makes an invite and returns its code: the only time it exists in the clear.
 * With a Slack user, joining with it links that user to the person.
 */
export function invite(store: Store, name: string, opts: { github?: string; slack?: string; at?: Date } = {}): { code: string; expires: string } {
  checkName(name);
  if (store.person(name)) throw new Refused(409, `${name} is already on Helix: helix remove-person ${name} first, or helix add-person ${name} for a new token`);
  if (opts.github !== undefined && !/^[A-Za-z0-9-]{1,39}$/.test(opts.github)) throw new Refused(400, `${opts.github} is not a GitHub login`);
  if (opts.slack !== undefined && !SLACK_USER.test(opts.slack)) throw new Refused(400, `${opts.slack} is not a Slack user id: one starts with U, as in U0123ABCD`);
  // A code sent on Slack could be read by someone else: the login keeps it to one GitHub account.
  if (opts.slack !== undefined && !opts.github) throw new Refused(400, 'an invite sent on Slack names their GitHub login, so only a token that signs in as it is taken');
  // Four groups of four from an alphabet with no look-alikes: easy to read out, close to 80 bits to guess.
  const alphabet = 'abcdefghjkmnpqrstuvwxyz23456789';
  const bytes = randomBytes(16);
  const code = Array.from(bytes, (b) => alphabet[b % alphabet.length]).join('').replace(/(.{4})(?!$)/g, '$1-');
  const expires = new Date((opts.at ?? new Date()).getTime() + INVITE_HOURS * 3_600_000).toISOString();
  store.invite({ code_sha256: hashToken(normalise(code)), name, expires, ...(opts.github ? { github: opts.github } : {}), ...(opts.slack ? { slack: opts.slack } : {}) });
  return { code, expires };
}

/** Typed by hand, a code may come back in capitals or without its dashes. */
const normalise = (code: string) => code.toLowerCase().replace(/[^a-z0-9]/g, '').replace(/(.{4})(?!$)/g, '$1-');

function liveInvite(store: Store, code: unknown, at?: Date): { invite: Invite; hash: string } {
  if (typeof code !== 'string' || !code.trim()) throw new Refused(400, 'code is the one-time code from helix invite');
  const hash = hashToken(normalise(code));
  const found = store.findInvite(hash, at);
  if (!found) throw new Refused(403, `that code does not let anyone in: it was used, it ended ${INVITE_HOURS} hours after it was made, or it was never given. Ask for a new one`);
  return { invite: found, hash };
}

/** Who the code is for, and the projects on Helix: what their GitHub token may be given. */
export function inviteDetails(store: Store, code: unknown, at?: Date): InviteDetails {
  const { invite: i } = liveInvite(store, code, at);
  const repos = store.projects().filter((p) => p.state === 'ready').map((p) => ({ name: p.name, url: p.url.startsWith('https://') ? p.url : '' }));
  return { name: i.name, expires: i.expires, repos, ...(i.github ? { github: i.github } : {}) };
}

const TOKEN = /^[\x21-\x7e]{8,1024}$/;

/**
 * Lets the invited person in, once their tokens have worked for real. The
 * code is taken only then, so a mistyped token can be tried again with it.
 * A project the GitHub token may not push to does not stop them: it is
 * named in cannot_push, and its jobs are theirs to submit once it may.
 *
 * With github (a Helix with an app), body has device_code instead of
 * github_token: they join as the GitHub login that approved it, their access
 * and refresh tokens are kept, and unreachable names the projects the app
 * cannot reach for them. StillWaiting: GitHub has not been approved yet.
 */
export async function joinHelix(opts: { store: Store; verify: Verify; at?: Date; github?: JoinGitHub }, body: Record<string, unknown>): Promise<Joined> {
  const { store, github } = opts;
  const { invite: i, hash } = liveInvite(store, body.code, opts.at);
  if (store.person(i.name)) throw new Refused(409, `${i.name} is already on Helix`);
  const claude = body.claude_token;
  if (typeof claude !== 'string' || !TOKEN.test(claude)) throw new Refused(400, 'claude_token is the token claude setup-token printed');
  let env: Record<string, string>;
  let signedIn: { tokens: Tokens; login: string } | undefined;
  if (github) {
    signedIn = await approved(github, body.device_code);
    if (i.github && signedIn.login.toLowerCase() !== i.github.toLowerCase()) throw new Refused(403, `this invite is for the GitHub account ${i.github}, and ${signedIn.login} approved the sign-in on GitHub. The code still works: run animus join again and approve as ${i.github}`);
    env = { CLAUDE_CODE_OAUTH_TOKEN: claude, GH_TOKEN: signedIn.tokens.access_token };
  } else {
    const pasted = body.github_token;
    if (typeof pasted !== 'string' || !TOKEN.test(pasted)) throw new Refused(400, 'github_token is the fine-grained token made on GitHub');
    env = { CLAUDE_CODE_OAUTH_TOKEN: claude, GH_TOKEN: pasted };
  }
  const verified = await opts.verify(env);
  const { findings } = verified;
  const login = signedIn?.login ?? verified.login;
  const bad = failing(findings);
  if (bad.length) throw new Refused(422, `Helix tried your tokens and ${bad.length === 1 ? 'one did' : 'some did'} not work:\n${bad.map((f) => `  ${f.what}: ${f.detail}`).join('\n')}\nThe code still works: fix the token and run animus join again`);
  if (i.github && login?.toLowerCase() !== i.github.toLowerCase()) throw new Refused(403, `this invite is for the GitHub account ${i.github}, and the token signs in as ${login ?? 'nobody'}`);
  const cut = github && signedIn ? await unreachable(store, github, signedIn.tokens.access_token) : undefined;
  // Two joins with one code: the first to take it gets in.
  if (!store.takeInvite(hash, opts.at)) throw new Refused(403, 'that code was used a moment ago');
  const file = credentialsFile(i.name);
  mkdirSync(dirname(file), { recursive: true, mode: 0o700 });
  // The refresh token renews the access token; it is kept here, never in their folder.
  writeFileSync(file, Object.entries(env).map(([k, v]) => `${k}=${v}\n`).join(''), { mode: 0o600 });
  chmodSync(file, 0o600);
  if (signedIn) keepTokens(i.name, file, signedIn.tokens, opts.at?.getTime());
  const token = addPerson(store, i.name, file, login);
  if (i.slack) store.linkSlack(i.name, i.slack);
  // A project the app cannot reach is named once, with its install link, not again as a push refused.
  const cannot = findings.filter((f) => !f.ok && f.optional).map((f) => f.what.replace(/^push to /, '')).filter((p) => !cut?.some((u) => u.project === p));
  return { name: i.name, token, ...(login ? { github: login } : {}), cannot_push: cannot, ...(cut ? { unreachable: cut } : {}) };
}

/**
 * Takes a person off Helix: their token, their queued and running jobs, their
 * credentials file under Helix's home, and their folder. Returns a
 * credentials file kept elsewhere, for whoever removes them to delete.
 * Every way off Helix comes here, so the owner is refused here.
 */
export function takeOff(name: string, store: Store, config: Pick<Config, 'owner'>, reap?: (id: number) => void): { kept?: string; cancelled: HelixJob[]; folder: string } {
  keepOwner(config, name);
  const { kept } = removePerson(store, name);
  store.record(name, 'left');
  const cancelled = cancelJobsOf(store, name, reap);
  const folder = personDirs(helixHome(), name).root;
  rmSync(folder, { recursive: true, force: true });
  return { ...(kept ? { kept } : {}), cancelled, folder };
}

const CLI = join(dirname(fileURLToPath(import.meta.url)), 'cli.ts');

/**
 * Tries the tokens in a `helix verify` process of its own: the Claude session
 * takes seconds, and Helix goes on answering meanwhile. The tokens go on its
 * stdin, never on a command line.
 */
export const verifyInChild: Verify = (env) => new Promise((resolve, reject) => {
  const child = spawn(process.execPath, ['--disable-warning=ExperimentalWarning', CLI, 'verify'], { stdio: ['pipe', 'pipe', 'pipe'] });
  let out = '';
  let err = '';
  child.stdout.on('data', (c: Buffer) => { out += c.toString(); });
  child.stderr.on('data', (c: Buffer) => { err += c.toString(); });
  child.on('error', reject);
  child.on('close', () => {
    try { resolve(JSON.parse(out) as Awaited<ReturnType<Verify>>); } catch { reject(new Error(`helix verify said nothing Helix could read: ${err.trim().split('\n').pop() ?? ''}`)); }
  });
  child.stdin.end(JSON.stringify(env));
});
