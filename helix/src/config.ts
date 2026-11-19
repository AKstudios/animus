// Helix's home and its one config file: where it listens, how many jobs run
// at once, and whether jobs run in containers. The people who may submit and
// the projects they submit for are in helix.db (store.ts); a config.yaml from
// before that has them moved there the first time Helix opens it.
import { createHash, randomBytes } from 'node:crypto';
import { chmodSync, existsSync, mkdirSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import { homedir } from 'node:os';
import { isAbsolute, join, relative, resolve } from 'node:path';
import { parse, stringify } from 'yaml';
import { isRecord } from '../../plugin/src/profile.ts';
import { TIERS, type Tier } from '../../plugin/src/profiles.ts';
import { AnimusError, tryGit } from '../../plugin/src/proc.ts';
import { parseMemory } from '../../plugin/src/room.ts';
import type { Person, Store } from './store.ts';

export type { Person } from './store.ts';

export const helixHome = () => process.env.HELIX_HOME ?? join(homedir(), '.helix');
export const configFile = () => join(helixHome(), 'config.yaml');

export type Config = {
  /** What the display calls this machine; its hostname when unset. */
  name?: string;
  /** The address people reach Helix at, such as its Tailscale Serve address: what helix invite tells them to join. */
  url?: string;
  /** The address on the office network, for when Tailscale is off (such as http://<host>.local:7420): invites show a second join line with it. */
  lan_url?: string;
  /** The address to listen on: one on the private network, never a public one. */
  host: string;
  port: number;
  /** Jobs that run at once; set by the machine's memory. */
  slots: number;
  /** Draft sessions from Slack (drafts.ts) that run at once, apart from job slots so drafts never delay jobs; 1 when unset. */
  draft_slots?: number;
  /**
   * Run each job in a container of its own (container.ts), with these limits.
   * Left out, jobs run on the machine as Helix's account, sharing it.
   */
  container?: { memory?: string; cpus?: number };
  /** Memory kept free for the machine beyond what a new job needs (`2g`), before Helix starts it. */
  reserve_memory?: string;
  /** What a job is counted to need when container.memory is not set (`4g`). */
  job_memory?: string;
  /** The most jobs at once whose implementer runs on a tier, such as `deep: 1`; a tier left out has no limit. */
  tier_limits?: Partial<Record<Tier, number>>;
  /** The person who may invite and remove people and act on any project or job; set by helix owner (owner.ts). */
  owner?: string;
  /** The Slack bot, set by helix slack setup; its tokens are in credentials/slack.env. Its owner is the Slack user linked to owner. */
  slack?: { enabled: boolean };
  /** Helix's GitHub App, set by helix github setup (github-app.ts): people join with its device flow instead of a pasted token. */
  github?: { client_id: string };
};

const DEFAULTS: Config = { host: '127.0.0.1', port: 7420, slots: 2, reserve_memory: '2g', job_memory: '4g', tier_limits: {} };

export { parseMemory };

/** What config.yaml held before people and projects moved to helix.db. */
type Old = { repos?: Record<string, string>; people?: Record<string, Person> };

export const hashToken = (token: string) => createHash('sha256').update(token).digest('hex');

function readRaw(file: string): Record<string, unknown> {
  if (!existsSync(file)) return {};
  let raw: unknown;
  try { raw = parse(readFileSync(file, 'utf8')); } catch (err) { throw new AnimusError(`${file}: ${(err as Error).message}`); }
  if (raw === null || raw === undefined) return {};
  if (!isRecord(raw)) throw new AnimusError(`${file}: expected a mapping at the top`);
  return raw;
}

export function loadConfig(file = configFile()): Config {
  const { repos: _r, people: _p, ...raw } = readRaw(file) as Record<string, unknown> & Old;
  const config = { ...structuredClone(DEFAULTS), ...raw } as Config;
  if (!Number.isInteger(config.slots) || config.slots < 1) throw new AnimusError(`${file}: slots must be a whole number, 1 or more`);
  for (const key of ['reserve_memory', 'job_memory'] as const) {
    if (parseMemory(config[key]) === undefined) throw new AnimusError(`${file}: ${key} must be a memory size such as 2g or 512m`);
  }
  if (config.container?.memory !== undefined && parseMemory(config.container.memory) === undefined) throw new AnimusError(`${file}: container.memory must be a memory size such as 6g or 512m`);
  const limits = config.tier_limits as unknown;
  if (!isRecord(limits)) throw new AnimusError(`${file}: tier_limits must be a mapping of tier to a number`);
  for (const [tier, n] of Object.entries(limits)) {
    if (!(TIERS as readonly string[]).includes(tier)) throw new AnimusError(`${file}: tier_limits has ${tier}, which is not one of ${TIERS.join(', ')}`);
    if (!Number.isInteger(n) || (n as number) < 1) throw new AnimusError(`${file}: tier_limits.${tier} must be a whole number, 1 or more`);
  }
  if (config.draft_slots !== undefined && (!Number.isInteger(config.draft_slots) || config.draft_slots < 1)) throw new AnimusError(`${file}: draft_slots must be a whole number, 1 or more`);
  return config;
}

export function saveConfig(config: Config, file = configFile()): void {
  mkdirSync(helixHome(), { recursive: true });
  writeFileSync(file, stringify(config));
  chmodSync(file, 0o600);
}

/** Sets some of config.yaml's keys and leaves the others as written, defaults left out. */
export function updateConfig(patch: Partial<Config>, file = configFile()): void {
  saveConfig({ ...readRaw(file), ...patch } as Config, file);
}

/**
 * Moves the people and repositories a config.yaml from before 0.4 names into
 * helix.db, then takes them out of the file. One already in the table is
 * left as the table has it. Returns what moved.
 */
export function importRegistry(store: Store, file = configFile()): { people: string[]; repos: string[] } {
  const raw = readRaw(file) as Record<string, unknown> & Old;
  if (raw.people === undefined && raw.repos === undefined) return { people: [], repos: [] };
  if ((raw.people !== undefined && !isRecord(raw.people)) || (raw.repos !== undefined && !isRecord(raw.repos))) throw new AnimusError(`${file}: repos and people must be mappings`);
  const moved = { people: [] as string[], repos: [] as string[] };
  for (const [name, person] of Object.entries(raw.people ?? {})) {
    if (store.person(name) || !isRecord(person) || typeof person.token_sha256 !== 'string') continue;
    store.putPerson(name, person);
    moved.people.push(name);
  }
  for (const [name, dir] of Object.entries(raw.repos ?? {})) {
    if (store.project(name) || typeof dir !== 'string') continue;
    store.putProject({ name, url: originUrl(dir) ?? '', dir: resolve(dir), state: 'ready', added: new Date().toISOString() });
    moved.repos.push(name);
  }
  const { people: _p, repos: _r, ...rest } = raw;
  writeFileSync(file, stringify(rest));
  chmodSync(file, 0o600);
  return moved;
}

/** A clone's origin, if it has one. */
export const originUrl = (dir: string) => tryGit(dir, ['remote', 'get-url', 'origin']) || undefined;

/** A person's name names their folder and credentials file, so it is kept to safe characters. */
export function checkName(name: string, what = 'a person\'s name'): void {
  if (!/^[A-Za-z0-9._-]+$/.test(name) || /^\.+$/.test(name)) throw new AnimusError(`${what} may hold letters, digits, dot, dash and underscore`);
}

/** Adds a person, or gives one a new token. Returns the token: the only time it exists in the clear. */
export function addPerson(store: Store, name: string, envFile?: string, github?: string): string {
  checkName(name);
  if (envFile && !existsSync(envFile)) throw new AnimusError(`no file at ${envFile}`);
  const known = store.person(name);
  const token = randomBytes(24).toString('base64url');
  const env = envFile ? resolve(envFile) : known?.env_file;
  const login = github ?? known?.github;
  // Joined is kept from the first time only: a new token for someone already here is not joining.
  const joined = known?.joined ?? (known ? undefined : new Date().toISOString());
  store.putPerson(name, { token_sha256: hashToken(token), ...(env ? { env_file: env } : {}), ...(login ? { github: login } : {}), ...(joined ? { joined } : {}) });
  if (!known) store.record(name, 'joined');
  return token;
}

/**
 * Takes a person off Helix: their token stops working at once, and the
 * credentials file is deleted when it is under Helix's home. Returns a
 * credentials file kept elsewhere, for whoever removes them to delete by hand.
 */
export function removePerson(store: Store, name: string): { kept?: string } {
  const person = store.person(name);
  if (!person) throw new AnimusError(`Helix has no person named ${name}`);
  store.dropPerson(name);
  const file = person.env_file;
  if (!file || !existsSync(file)) return {};
  const inside = relative(helixHome(), resolve(file));
  // A file someone else also points to is not this person's alone.
  const shared = Object.values(store.people()).some((p) => p.env_file && resolve(p.env_file) === resolve(file));
  if (!inside.startsWith('..') && !isAbsolute(inside) && !shared) { rmSync(file); return {}; }
  return { kept: file };
}

/** A clone already on this machine that jobs may be submitted for, ready at once: the machine's own way to add one. */
export function addRepo(store: Store, name: string, dir: string): void {
  checkName(name, 'a project\'s name');
  const path = resolve(dir);
  if (!existsSync(join(path, '.git'))) throw new AnimusError(`${path} is not a git checkout`);
  store.putProject({ name, url: originUrl(path) ?? '', dir: path, state: 'ready', added: new Date().toISOString() });
}

/** Stops Helix taking jobs for a repository. Its clone stays; returns where it is. */
export function removeRepo(store: Store, name: string): string {
  const project = store.project(name);
  if (!project) throw new AnimusError(`Helix has no project named ${name}`);
  store.dropProject(name);
  return project.dir;
}

/** The projects jobs may be submitted for now, by name: their clones. */
export const readyRepos = (store: Store): Record<string, string> =>
  Object.fromEntries(store.projects().filter((p) => p.state === 'ready').map((p) => [p.name, p.dir]));

/**
 * Makes git use the person's GitHub token for https remotes, for this process
 * only: nothing is written to the machine's git config, and no sign-in kept
 * there is tried first.
 */
export function credentialEnv(env: Record<string, string>): Record<string, string> {
  if (!env.GH_TOKEN && !env.GITHUB_TOKEN && !env.ANIMUS_GH_TOKEN_FILE) return {};
  const key = 'credential.https://github.com.helper';
  // With a live token file (github-app.ts), git reads the token from it at each push, so a renewal during a job does not strand it.
  const helper = env.ANIMUS_GH_TOKEN_FILE ? LIVE_TOKEN_HELPER : '!gh auth git-credential';
  return { GIT_CONFIG_COUNT: '2', GIT_CONFIG_KEY_0: key, GIT_CONFIG_VALUE_0: '', GIT_CONFIG_KEY_1: key, GIT_CONFIG_VALUE_1: helper };
}

/** A git credential helper that answers with the token in $ANIMUS_GH_TOKEN_FILE as it is now. */
export const LIVE_TOKEN_HELPER = '!f() { test "$1" = get || exit 0; echo username=x-access-token; echo "password=$(cat "$ANIMUS_GH_TOKEN_FILE")"; }; f';

/** Makes a job's commits the person's, on a machine whose account has no git identity of its own. */
export function identityEnv(who: { name: string; email: string }): Record<string, string> {
  return { GIT_AUTHOR_NAME: who.name, GIT_AUTHOR_EMAIL: who.email, GIT_COMMITTER_NAME: who.name, GIT_COMMITTER_EMAIL: who.email };
}

/** The variables a person's jobs run with, from their env_file: all but the refresh token and when the access token ends, which only Helix uses. */
export function personEnv(person: Person | undefined): Record<string, string> {
  if (!person?.env_file) return {};
  if (!existsSync(person.env_file)) throw new AnimusError(`the credentials file ${person.env_file} is gone`);
  const { GH_REFRESH_TOKEN: _refresh, GH_TOKEN_EXPIRES: _expires, ...env } = envFileVars(person.env_file);
  return env;
}

/** The values of a person's env that are their GitHub or Claude credentials: shown as *** wherever their job's output is kept. */
export const credentialValues = (env: Record<string, string>): string[] =>
  ['GH_TOKEN', 'GITHUB_TOKEN', 'CLAUDE_CODE_OAUTH_TOKEN', 'ANTHROPIC_API_KEY'].flatMap((n) => (env[n] ? [env[n]] : []));

/** The KEY=value lines of an env file. */
export function envFileVars(file: string): Record<string, string> {
  const out: Record<string, string> = {};
  for (const line of readFileSync(file, 'utf8').split(/\r?\n/)) {
    const m = /^\s*(?:export\s+)?([A-Za-z_][A-Za-z0-9_]*)=(.*)$/.exec(line);
    if (m) out[m[1]!] = m[2]!.trim().replace(/^(['"])(.*)\1$/, '$2');
  }
  return out;
}
