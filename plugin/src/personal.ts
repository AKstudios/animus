// ANIMUS_HOME/config.yaml: one person's own settings, never in a repository.
// It says where their jobs run (here or on Helix) and adds skills of their own
// to their jobs, for every repository or for one. What a job is checked
// against stays in the project's shared profile: a pull request's proof never
// depends on one person's file.
//
// A personal skill is the one way a skill reaches a job other than a grant in
// profiles.yaml. It keeps what that rule protects: its text is copied into
// the job's folder when the job starts (and sent with the spec to Helix), so
// nothing is read or fetched while the job runs, a resumed job uses the same
// copy, and the run log names it with a hash of its text.
import { createHash } from 'node:crypto';
import { existsSync, readFileSync, writeFileSync } from 'node:fs';
import { homedir } from 'node:os';
import { dirname, isAbsolute, join, resolve } from 'node:path';
import { parse } from 'yaml';
import { githubUrl, mainCheckout } from './git.ts';
import { animusHome } from './log.ts';
import { AnimusError, tryGit } from './proc.ts';
import { isRecord, isStrings } from './profile.ts';
import * as helix from './remote.ts';

export type Where = 'local' | 'helix';

/** A personal skill as a job carries it: its text, the roles and task types it is for, and a hash of the text. */
export type PersonalSkill = { name: string; roles: string[]; types?: string[]; text: string; sha: string };

/** A personal skill as the config names it, before its file is read. */
export type SkillEntry = { name: string; file: string; roles: string[]; types?: string[] };

export type Personal = {
  /** Where this person's jobs for the repository run, and which line of the config says so. */
  run?: { where: Where; from: string };
  skills: SkillEntry[];
  /** The config file, when there is one. */
  file?: string;
};

export const personalConfig = (home = animusHome()) => join(home, 'config.yaml');
export const ROLES = ['implementer', 'planner', 'reviewer', 'ui-reviewer'];
/** The reviewer judges the work, so a person's own rules reach it only when they name it. */
const DEFAULT_ROLES = ['implementer', 'planner'];
const JOB_FILE = 'skills.json';

const sha = (text: string) => createHash('sha256').update(text).digest('hex');
const home = (p: string) => (p === '~' ? homedir() : p.startsWith('~/') || p.startsWith('~\\') ? join(homedir(), p.slice(2)) : p);

/** A repository as the config may name it: a GitHub address in any form, or owner/repo. */
export function repoKey(name: string): string | undefined {
  const s = name.trim();
  const url = /^github\.com\//i.test(s) ? `https://${s}` : /^[A-Za-z0-9-]+\/[A-Za-z0-9._-]+$/.test(s) ? `https://github.com/${s}` : s;
  return githubUrl(url)?.toLowerCase();
}

/** What config.yaml says for the repository of this checkout. No file: nothing. */
export function personalFor(checkout: string, file = personalConfig()): Personal {
  if (!existsSync(file)) return { skills: [] };
  let raw: unknown;
  try { raw = parse(readFileSync(file, 'utf8')) ?? {}; } catch (err) { throw new AnimusError(`${file}: ${(err as Error).message}`); }
  const bad = (what: string) => new AnimusError(`${file}: ${what}`);
  if (!isRecord(raw)) throw bad('expected a mapping at the top');
  for (const key of Object.keys(raw)) if (!['run', 'skills', 'repos'].includes(key)) throw bad(`${key} is not a setting here; it takes run, skills and repos (gates and setup belong in the project's .animus/animus.yaml)`);
  const dir = dirname(file);

  const where = (v: unknown, at: string): Where | undefined => {
    if (v === undefined) return undefined;
    if (v !== 'local' && v !== 'helix') throw bad(`${at} must be local or helix`);
    return v;
  };
  const skills = (v: unknown, at: string): SkillEntry[] => {
    if (v === undefined) return [];
    if (!isRecord(v)) throw bad(`${at} must map a skill's name to its SKILL.md, or to { file, roles, types }`);
    return Object.entries(v).map(([name, s]) => {
      const e = typeof s === 'string' ? { file: s } : s;
      if (!isRecord(e) || typeof e.file !== 'string') throw bad(`${at}.${name} must be a file, or { file, roles, types }`);
      const roles = e.roles === undefined ? DEFAULT_ROLES : e.roles;
      if (!isStrings(roles) || !roles.length) throw bad(`${at}.${name}.roles must list roles: ${ROLES.join(', ')}`);
      const unknown = roles.filter((r) => !ROLES.includes(r));
      if (unknown.length) throw bad(`${at}.${name}.roles names ${unknown.join(', ')}; the roles are ${ROLES.join(', ')}`);
      if (e.types !== undefined && !isStrings(e.types)) throw bad(`${at}.${name}.types must list task types`);
      const path = home(e.file);
      return { name, file: isAbsolute(path) ? path : resolve(dir, path), roles: [...roles], ...(e.types ? { types: e.types as string[] } : {}) };
    });
  };

  // The repository's entry: by its GitHub address, or by the checkout's folder.
  const root = mainCheckout(checkout);
  const origin = githubUrl(tryGit(root, ['remote', 'get-url', 'origin']) ?? '')?.toLowerCase();
  let entry: { key: string; value: Record<string, unknown> } | undefined;
  if (raw.repos !== undefined) {
    if (!isRecord(raw.repos)) throw bad('repos must map a repository (owner/repo, its GitHub address, or a folder) to its settings');
    for (const [key, value] of Object.entries(raw.repos)) {
      if (!isRecord(value)) throw bad(`repos.${key} must be a mapping of run and skills`);
      for (const k of Object.keys(value)) if (!['run', 'skills'].includes(k)) throw bad(`repos.${key}.${k} is not a setting here; a repository takes run and skills`);
      const matches = (origin && repoKey(key) === origin) || (!repoKey(key) && resolve(dir, home(key)) === root);
      if (matches && !entry) entry = { key, value };
    }
  }

  const top = where(raw.run, 'run');
  const theirs = entry ? where(entry.value.run, `repos.${entry.key}.run`) : undefined;
  const byName = new Map<string, SkillEntry>();
  for (const s of [...skills(raw.skills, 'skills'), ...(entry ? skills(entry.value.skills, `repos.${entry.key}.skills`) : [])]) byName.set(s.name, s);
  const run = theirs ? { where: theirs, from: `repos.${entry!.key}.run in ${file}` } : top ? { where: top, from: `run in ${file}` } : undefined;
  return { ...(run ? { run } : {}), skills: [...byName.values()], file };
}

/** Reads each skill's file once, as the job will carry it. */
export function snapshotSkills(entries: readonly SkillEntry[]): PersonalSkill[] {
  return entries.map((e) => {
    if (!existsSync(e.file)) throw new AnimusError(`your skill ${e.name} is ${e.file}, which does not exist (${personalConfig()})`);
    const text = readFileSync(e.file, 'utf8');
    return { name: e.name, roles: e.roles, ...(e.types ? { types: e.types } : {}), text, sha: sha(text) };
  });
}

/** Personal skills as they arrive from elsewhere (Helix, a file): checked, and hashed again here. */
export function parseSkills(value: unknown, from: string): PersonalSkill[] {
  if (value === undefined) return [];
  if (!Array.isArray(value)) throw new AnimusError(`${from}: skills must be a list`);
  const seen = new Set<string>();
  return value.map((s, i) => {
    const at = `${from}: skills[${i}]`;
    if (!isRecord(s) || typeof s.name !== 'string' || !/^[A-Za-z0-9._-]+$/.test(s.name) || typeof s.text !== 'string') throw new AnimusError(`${at} must be { name, roles, types, text }, with a name of letters, digits, dots, dashes and underscores`);
    if (seen.has(s.name)) throw new AnimusError(`${at}: ${s.name} is there twice`);
    seen.add(s.name);
    if (!isStrings(s.roles) || !s.roles.length || s.roles.some((r) => !ROLES.includes(r))) throw new AnimusError(`${at}.roles must list roles from ${ROLES.join(', ')}`);
    if (s.types !== undefined && !isStrings(s.types)) throw new AnimusError(`${at}.types must list task types`);
    return { name: s.name, roles: s.roles, ...(s.types ? { types: s.types } : {}), text: s.text, sha: sha(s.text) };
  });
}

export const readSkillsFile = (file: string) => {
  let raw: unknown;
  try { raw = JSON.parse(readFileSync(file, 'utf8')); } catch (err) { throw new AnimusError(`${file}: ${(err as Error).message}`); }
  return parseSkills(raw, file);
};

/** The copy a job keeps in its folder; a job with none keeps no file. */
export function saveJobSkills(dir: string, skills: readonly PersonalSkill[]): void {
  if (skills.length) writeFileSync(join(dir, JOB_FILE), `${JSON.stringify(skills, null, 2)}\n`);
}

export const loadJobSkills = (dir: string): PersonalSkill[] => (existsSync(join(dir, JOB_FILE)) ? readSkillsFile(join(dir, JOB_FILE)) : []);

/** The personal skills one role gets on a job of this type. */
export const skillsForRole = (skills: readonly PersonalSkill[], role: string, type: string) =>
  skills.filter((s) => s.roles.includes(role) && (!s.types || s.types.includes(type)));

/**
 * Where `animus start` runs a job. What the person asked for wins, then their
 * config, then: Helix when this machine has joined one and it has the
 * project, and here otherwise.
 */
export async function whereToRun(opts: {
  asked?: Where; config?: Personal['run']; checkout: string;
  login?: ReturnType<typeof helix.helixLogin>; projects?: () => Promise<{ projects: helix.RemoteProject[] }>;
}): Promise<{ where: Where; why: string; project?: string }> {
  if (opts.asked) return { where: opts.asked, why: `asked for --${opts.asked}` };
  if (opts.config) return { where: opts.config.where, why: `${opts.config.from} says so` };
  const login = 'login' in opts ? opts.login : helix.helixLogin();
  if (!login) return { where: 'local', why: 'this machine has not joined a Helix' };
  const url = githubUrl(tryGit(mainCheckout(opts.checkout), ['remote', 'get-url', 'origin']) ?? '');
  if (!url) return { where: 'local', why: 'this repository is not on GitHub, so Helix cannot have it' };
  let list: helix.RemoteProject[];
  try { list = (await (opts.projects ?? helix.projects)()).projects; } catch (err) { return { where: 'local', why: `Helix did not answer (${(err as Error).message})` }; }
  const p = list.find((x) => x.url.toLowerCase() === url.toLowerCase() && x.state === 'ready');
  return p ? { where: 'helix', why: `Helix has this repository as ${p.name}`, project: p.name } : { where: 'local', why: 'Helix does not have this repository (animus project add puts it there)' };
}
