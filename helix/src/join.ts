// Joining Helix without anyone setting it up by hand (docs/factory.md,
// "Registration and credentials"). Whoever runs the machine invites a person
// by name and passes them a one-time code; `animus join` sends the code with
// the person's Claude and GitHub tokens, Helix tries both for real, and only
// then takes the code, keeps the tokens and gives back the person's Helix
// token. Leaving is the same as `helix remove-person`, asked by the person.
//
// Codes, not Tailscale's identity headers: anything on the machine can send
// those headers to 127.0.0.1, so they prove nothing about who is asking.
import { spawn } from 'node:child_process';
import { randomBytes } from 'node:crypto';
import { chmodSync, mkdirSync, rmSync, writeFileSync } from 'node:fs';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { failing, type Finding } from './check.ts';
import { addPerson, checkName, hashToken, helixHome, removePerson, type Config } from './config.ts';
import { personDirs } from './container.ts';
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
 */
export async function joinHelix(opts: { store: Store; verify: Verify; at?: Date }, body: Record<string, unknown>): Promise<{ name: string; token: string; github?: string; cannot_push: string[] }> {
  const { store } = opts;
  const { invite: i, hash } = liveInvite(store, body.code, opts.at);
  if (store.person(i.name)) throw new Refused(409, `${i.name} is already on Helix`);
  const claude = body.claude_token;
  const github = body.github_token;
  if (typeof claude !== 'string' || !TOKEN.test(claude)) throw new Refused(400, 'claude_token is the token claude setup-token printed');
  if (typeof github !== 'string' || !TOKEN.test(github)) throw new Refused(400, 'github_token is the fine-grained token made on GitHub');
  const env = { CLAUDE_CODE_OAUTH_TOKEN: claude, GH_TOKEN: github };
  const { findings, login } = await opts.verify(env);
  const bad = failing(findings);
  if (bad.length) throw new Refused(422, `Helix tried your tokens and ${bad.length === 1 ? 'one did' : 'some did'} not work:\n${bad.map((f) => `  ${f.what}: ${f.detail}`).join('\n')}\nThe code still works: fix the token and run animus join again`);
  if (i.github && login?.toLowerCase() !== i.github.toLowerCase()) throw new Refused(403, `this invite is for the GitHub account ${i.github}, and the token signs in as ${login ?? 'nobody'}`);
  // Two joins with one code: the first to take it gets in.
  if (!store.takeInvite(hash, opts.at)) throw new Refused(403, 'that code was used a moment ago');
  const file = credentialsFile(i.name);
  mkdirSync(dirname(file), { recursive: true, mode: 0o700 });
  writeFileSync(file, Object.entries(env).map(([k, v]) => `${k}=${v}\n`).join(''), { mode: 0o600 });
  chmodSync(file, 0o600);
  const token = addPerson(store, i.name, file, login);
  if (i.slack) store.linkSlack(i.name, i.slack);
  const cannot = findings.filter((f) => !f.ok && f.optional).map((f) => f.what.replace(/^push to /, ''));
  return { name: i.name, token, ...(login ? { github: login } : {}), cannot_push: cannot };
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
