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
import type { Finding } from './check.ts';
import { addPerson, checkName, hashToken, helixHome, loadConfig, removePerson, type Config } from './config.ts';
import { originOf, personDirs } from './container.ts';
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

/** Makes an invite and returns its code: the only time it exists in the clear. */
export function invite(config: Config, store: Store, name: string, opts: { github?: string; at?: Date } = {}): { code: string; expires: string } {
  checkName(name);
  if (config.people[name]) throw new Refused(409, `${name} is already on Helix: helix remove-person ${name} first, or helix add-person ${name} for a new token`);
  if (opts.github !== undefined && !/^[A-Za-z0-9-]{1,39}$/.test(opts.github)) throw new Refused(400, `${opts.github} is not a GitHub login`);
  // Four groups of four from an alphabet with no look-alikes: easy to read out, close to 80 bits to guess.
  const alphabet = 'abcdefghjkmnpqrstuvwxyz23456789';
  const bytes = randomBytes(16);
  const code = Array.from(bytes, (b) => alphabet[b % alphabet.length]).join('').replace(/(.{4})(?!$)/g, '$1-');
  const expires = new Date((opts.at ?? new Date()).getTime() + INVITE_HOURS * 3_600_000).toISOString();
  store.invite({ code_sha256: hashToken(normalise(code)), name, expires, ...(opts.github ? { github: opts.github } : {}) });
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

/** Who the code is for and which repositories their GitHub token has to reach. */
export function inviteDetails(config: Config, store: Store, code: unknown, at?: Date): InviteDetails {
  const { invite: i } = liveInvite(store, code, at);
  const repos = Object.entries(config.repos).map(([name, dir]) => {
    let url = '';
    try { url = originOf(dir); } catch { /* a clone with no origin: nothing to show */ }
    return { name, url };
  });
  return { name: i.name, expires: i.expires, repos, ...(i.github ? { github: i.github } : {}) };
}

const TOKEN = /^[\x21-\x7e]{8,1024}$/;

/**
 * Lets the invited person in, once their tokens have worked for real. The
 * code is taken only then, so a mistyped token can be tried again with it.
 */
export async function joinHelix(opts: { config: Config; store: Store; verify: Verify; at?: Date }, body: Record<string, unknown>): Promise<{ name: string; token: string; github?: string }> {
  const { config, store } = opts;
  const { invite: i, hash } = liveInvite(store, body.code, opts.at);
  if (config.people[i.name]) throw new Refused(409, `${i.name} is already on Helix`);
  const claude = body.claude_token;
  const github = body.github_token;
  if (typeof claude !== 'string' || !TOKEN.test(claude)) throw new Refused(400, 'claude_token is the token claude setup-token printed');
  if (typeof github !== 'string' || !TOKEN.test(github)) throw new Refused(400, 'github_token is the fine-grained token made on GitHub');
  const env = { CLAUDE_CODE_OAUTH_TOKEN: claude, GH_TOKEN: github };
  const { findings, login } = await opts.verify(env);
  const bad = findings.filter((f) => !f.ok);
  if (bad.length) throw new Refused(422, `Helix tried your tokens and ${bad.length === 1 ? 'one did' : 'some did'} not work:\n${bad.map((f) => `  ${f.what}: ${f.detail}`).join('\n')}\nThe code still works: fix the token and run animus join again`);
  if (i.github && login?.toLowerCase() !== i.github.toLowerCase()) throw new Refused(403, `this invite is for the GitHub account ${i.github}, and the token signs in as ${login ?? 'nobody'}`);
  // Two joins with one code: the first to take it gets in.
  if (!store.takeInvite(hash, opts.at)) throw new Refused(403, 'that code was used a moment ago');
  const file = credentialsFile(i.name);
  mkdirSync(dirname(file), { recursive: true, mode: 0o700 });
  writeFileSync(file, Object.entries(env).map(([k, v]) => `${k}=${v}\n`).join(''), { mode: 0o600 });
  chmodSync(file, 0o600);
  const token = addPerson(i.name, file, login);
  // The token works on this request's Helix at once, not only once it reads config.yaml again.
  const person = loadConfig().people[i.name];
  if (person) config.people[i.name] = person;
  return { name: i.name, token, ...(login ? { github: login } : {}) };
}

/**
 * Takes a person off Helix: their token, their queued and running jobs, their
 * credentials file under Helix's home, and their folder. Returns a
 * credentials file kept elsewhere, for whoever removes them to delete.
 */
export function takeOff(name: string, store: Store, reap?: (id: number) => void): { kept?: string; cancelled: HelixJob[]; folder: string } {
  const { kept } = removePerson(name);
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
