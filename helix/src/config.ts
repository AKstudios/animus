// Helix's home and its one config file: where it listens, how many jobs run
// at once, the repositories it has clones of, and the people who may submit.
// A person is known by the hash of a token; the token itself is shown once,
// when they are added, and never kept.
import { createHash, randomBytes } from 'node:crypto';
import { chmodSync, existsSync, mkdirSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import { homedir } from 'node:os';
import { isAbsolute, join, relative, resolve } from 'node:path';
import { parse, stringify } from 'yaml';
import { isRecord } from '../../plugin/src/profile.ts';
import { AnimusError } from '../../plugin/src/proc.ts';

export const helixHome = () => process.env.HELIX_HOME ?? join(homedir(), '.helix');
export const configFile = () => join(helixHome(), 'config.yaml');

/** env_file: KEY=VALUE lines set for that person's jobs only: their Claude token and GitHub credential. */
export type Person = { token_sha256: string; env_file?: string };

export type Config = {
  /** What the display calls this machine; its hostname when unset. */
  name?: string;
  /** The address to listen on: one on the private network, never a public one. */
  host: string;
  port: number;
  /** Jobs that run at once; set by the machine's memory. */
  slots: number;
  /** Repositories by name, each a clone on this machine with a .animus/animus.yaml. */
  repos: Record<string, string>;
  people: Record<string, Person>;
  /**
   * Run each job in a container of its own (container.ts), with these limits.
   * Left out, jobs run on the machine as Helix's account, sharing it.
   */
  container?: { memory?: string; cpus?: number };
};

const DEFAULTS: Config = { host: '127.0.0.1', port: 7420, slots: 2, repos: {}, people: {} };

export const hashToken = (token: string) => createHash('sha256').update(token).digest('hex');

export function loadConfig(file = configFile()): Config {
  if (!existsSync(file)) return structuredClone(DEFAULTS);
  let raw: unknown;
  try { raw = parse(readFileSync(file, 'utf8')); } catch (err) { throw new AnimusError(`${file}: ${(err as Error).message}`); }
  if (!isRecord(raw)) throw new AnimusError(`${file}: expected a mapping at the top`);
  const config = { ...structuredClone(DEFAULTS), ...raw } as Config;
  if (!Number.isInteger(config.slots) || config.slots < 1) throw new AnimusError(`${file}: slots must be a whole number, 1 or more`);
  if (!isRecord(config.repos) || !isRecord(config.people)) throw new AnimusError(`${file}: repos and people must be mappings`);
  return config;
}

export function saveConfig(config: Config, file = configFile()): void {
  mkdirSync(helixHome(), { recursive: true });
  writeFileSync(file, stringify(config));
  // The file names where credentials are kept: the owner's eyes only, where the system has such a thing.
  chmodSync(file, 0o600);
}

/** Adds a person, or gives one a new token. Returns the token: the only time it exists in the clear. */
export function addPerson(name: string, envFile?: string): string {
  if (!/^[A-Za-z0-9._-]+$/.test(name)) throw new AnimusError('a person\'s name may hold letters, digits, dot, dash and underscore');
  if (envFile && !existsSync(envFile)) throw new AnimusError(`no file at ${envFile}`);
  const config = loadConfig();
  const token = randomBytes(24).toString('base64url');
  const env = envFile ? resolve(envFile) : config.people[name]?.env_file;
  config.people[name] = { token_sha256: hashToken(token), ...(env ? { env_file: env } : {}) };
  saveConfig(config);
  return token;
}

/**
 * Takes a person off Helix: their token stops working as soon as `helix serve`
 * reads the file again, and the credentials file is deleted when it is under
 * Helix's home. Returns a credentials file kept elsewhere, for whoever removes
 * them to delete by hand.
 */
export function removePerson(name: string): { kept?: string } {
  const config = loadConfig();
  const person = config.people[name];
  if (!person) throw new AnimusError(`${configFile()} has no person named ${name}`);
  delete config.people[name];
  saveConfig(config);
  const file = person.env_file;
  if (!file || !existsSync(file)) return {};
  const inside = relative(helixHome(), resolve(file));
  // A file someone else also points to is not this person's alone.
  const shared = Object.values(config.people).some((p) => p.env_file && resolve(p.env_file) === resolve(file));
  if (!inside.startsWith('..') && !isAbsolute(inside) && !shared) { rmSync(file); return {}; }
  return { kept: file };
}

/** Stops Helix taking jobs for a repository. Its clone stays; returns where it is. */
export function removeRepo(name: string): string {
  const config = loadConfig();
  const dir = config.repos[name];
  if (!dir) throw new AnimusError(`${configFile()} has no repository named ${name}`);
  delete config.repos[name];
  saveConfig(config);
  return dir;
}

export function addRepo(name: string, dir: string): void {
  const path = resolve(dir);
  if (!existsSync(join(path, '.git'))) throw new AnimusError(`${path} is not a git checkout`);
  const config = loadConfig();
  config.repos[name] = path;
  saveConfig(config);
}

/**
 * Makes git use the person's GitHub token for https remotes, for this process
 * only: nothing is written to the machine's git config, and no sign-in kept
 * there is tried first.
 */
export function credentialEnv(env: Record<string, string>): Record<string, string> {
  if (!env.GH_TOKEN && !env.GITHUB_TOKEN) return {};
  const key = 'credential.https://github.com.helper';
  return { GIT_CONFIG_COUNT: '2', GIT_CONFIG_KEY_0: key, GIT_CONFIG_VALUE_0: '', GIT_CONFIG_KEY_1: key, GIT_CONFIG_VALUE_1: '!gh auth git-credential' };
}

/** Makes a job's commits the person's, on a machine whose account has no git identity of its own. */
export function identityEnv(who: { name: string; email: string }): Record<string, string> {
  return { GIT_AUTHOR_NAME: who.name, GIT_AUTHOR_EMAIL: who.email, GIT_COMMITTER_NAME: who.name, GIT_COMMITTER_EMAIL: who.email };
}

/** The variables a person's jobs run with, from their env_file. */
export function personEnv(person: Person | undefined): Record<string, string> {
  if (!person?.env_file) return {};
  if (!existsSync(person.env_file)) throw new AnimusError(`the credentials file ${person.env_file} is gone`);
  const out: Record<string, string> = {};
  for (const line of readFileSync(person.env_file, 'utf8').split(/\r?\n/)) {
    const m = /^\s*(?:export\s+)?([A-Za-z_][A-Za-z0-9_]*)=(.*)$/.exec(line);
    if (m) out[m[1]!] = m[2]!.trim().replace(/^(['"])(.*)\1$/, '$2');
  }
  return out;
}
