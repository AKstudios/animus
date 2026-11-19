// .animus/animus.yaml: the project's setup and check commands and the few
// rules Animus cannot guess. Read from the checkout the job was started in, so a
// profile works before it is pushed. The format is orbit's; keys only its
// epics used (commits, max_parallel, review, outside_touches, teardown) are
// accepted and ignored, so an existing profile works unchanged.
import { existsSync, readFileSync } from 'node:fs';
import { join } from 'node:path';
import { parse } from 'yaml';
import type { Install } from './installs.ts';
import { AnimusError } from './proc.ts';

/**
 * paths: globs; a job runs the command only when it changed a file under
 * them. Unset: every job. affected: a narrower form a trivial job runs
 * instead, given $ANIMUS_BASE (the commit the job started from) and
 * $ANIMUS_CHANGED (the files changed since, from the root).
 */
export type Command = { run: string; cwd?: string; paths?: string[]; affected?: string };

/** One screen of a UI target: a web path, or a name an app's capture command uses. */
export type UiPage = { name: string; path: string; reference?: string };

/**
 * Something a UI job changes that Animus can show: a web app (screenshot by
 * agent-browser at each viewport) or a phone or desktop app (screenshot by the
 * project's own capture command).
 */
export type UiTarget = {
  name: string;
  kind: 'web' | 'app';
  paths: string[];
  /** Starts it (in the worktree, with $PORT), and keeps running until stopped. */
  serve?: string;
  /** Where a web target answers, with $PORT. */
  url?: string;
  /** A command that exits 0 once the target is ready; web targets wait for url instead. */
  ready?: string;
  /** For app targets: writes PNGs into $ANIMUS_SHOTS (env: $PORT, $ANIMUS_URL, $ANIMUS_PAGES, $ANIMUS_JOB). */
  capture?: string;
  pages: UiPage[];
  viewports: { w: number; h: number }[];
  /** Design references for the whole target (files or folders), when a spec names none of its own. */
  references: string[];
};

export type UiProfile = { targets: UiTarget[]; human_review: boolean };

export type Profile = {
  /** What every agent is told about this project beyond its own rules for Claude. */
  notes?: string;
  /** Installs what the checks need in a fresh worktree; run once per job, after installs. */
  setup?: string;
  /** What install commands make, cached by lockfile and cloned into each new worktree (installs.ts). */
  installs: Install[];
  /** Check commands by name, in the order they run: the gates. */
  commands: Record<string, Command>;
  /** Which commands each task type runs; a type not listed runs them all. */
  checks: Record<string, string[]>;
  /** Globs for test files. */
  tests: string[];
  /** Globs a job should not change; a change under them is flagged at the top of the PR. */
  protected: string[];
  /** The branch jobs start from and their PR targets. */
  base: string;
  /** How a PR says which issue it is for: `Closes #N` (default) or `Refs #N`, for a project whose issues stay open until a person closes them. A spec cannot override it. */
  issue_link: 'closes' | 'refs';
  /** Where job worktrees go; default ../.worktrees/<repo name>. */
  worktrees?: string;
  ui: UiProfile;
  /** Plain settings every step of a job runs with: setup, installs, gates, a UI target's commands and the agent sessions. */
  env: Record<string, string>;
  /** Names of the project's secrets, whose values a job gets from where it runs (on one machine: the queue's own environment). */
  secrets: string[];
};

export const PROFILE_PATH = '.animus/animus.yaml';

// Names Animus or Helix sets for a job itself: the person's tokens, git's identity and credentials, the check's CI, the serve command's PORT.
const RESERVED = new Set(['HOME', 'PATH', 'CI', 'PORT', 'GH_TOKEN', 'GITHUB_TOKEN', 'GH_REFRESH_TOKEN', 'GH_TOKEN_EXPIRES', 'CLAUDE_CODE_OAUTH_TOKEN', 'ANTHROPIC_API_KEY', 'CLAUDE_CONFIG_DIR']);
const RESERVED_PREFIX = /^(ANIMUS_|HELIX_|GIT_AUTHOR_|GIT_COMMITTER_|GIT_CONFIG_)/;

const DEFAULTS: Profile = {
  installs: [],
  commands: {},
  checks: {},
  tests: ['**/*.test.*', '**/*.spec.*', '**/test_*.py', '**/*_test.py', '**/*_test.go', 'test/**', 'tests/**', '__tests__/**'],
  protected: ['.github/**', '.animus/**', '.claude/**', 'infrastructure/**'],
  base: 'main',
  issue_link: 'closes',
  ui: { targets: [], human_review: true },
  env: {},
  secrets: [],
};

export function loadProfile(dir: string): Profile {
  const file = join(dir, PROFILE_PATH);
  if (!existsSync(file)) throw new AnimusError(`no ${PROFILE_PATH} in ${dir}. It names the project's setup and check commands; see docs/configuration.md in Animus for its keys`);
  return parseProfile(readFileSync(file, 'utf8'), file);
}

export function parseProfile(text: string, file = PROFILE_PATH): Profile {
  let raw: unknown;
  try {
    raw = parse(text) ?? {};
  } catch (err) {
    throw new AnimusError(`${file}: ${(err as Error).message}`);
  }
  if (!isRecord(raw)) throw new AnimusError(`${file}: expected a mapping at the top`);
  const bad = (what: string) => new AnimusError(`${file}: ${what}`);
  const profile: Profile = structuredClone(DEFAULTS);

  if (raw.commands !== undefined) {
    if (!isRecord(raw.commands)) throw bad('commands must map a name to a command');
    for (const [name, value] of Object.entries(raw.commands)) {
      if (typeof value === 'string') profile.commands[name] = { run: value };
      else if (isRecord(value) && typeof value.run === 'string') {
        const command: Command = { run: value.run };
        if (typeof value.cwd === 'string') command.cwd = value.cwd;
        if (value.affected !== undefined) {
          if (typeof value.affected !== 'string') throw bad(`commands.${name}.affected must be a command`);
          command.affected = value.affected;
        }
        if (value.paths !== undefined) {
          const paths = typeof value.paths === 'string' ? [value.paths] : value.paths;
          if (!isStrings(paths) || !paths.length) throw bad(`commands.${name}.paths must list globs; leave it out to run the command for every job`);
          command.paths = paths;
        }
        profile.commands[name] = command;
      } else throw bad(`commands.${name} must be a string or { run, cwd, paths, affected }`);
    }
  }
  if (raw.checks !== undefined) {
    if (!isRecord(raw.checks)) throw bad('checks must map a task type to a list of command names');
    for (const [type, names] of Object.entries(raw.checks)) {
      if (!isStrings(names)) throw bad(`checks.${type} must be a list of command names`);
      const unknown = names.filter((n) => !profile.commands[n]);
      if (unknown.length) throw bad(`checks.${type} names ${unknown.join(', ')}, not in commands`);
      profile.checks[type] = names;
    }
  }
  for (const key of ['tests', 'protected'] as const) {
    if (raw[key] === undefined) continue;
    if (!isStrings(raw[key])) throw bad(`${key} must be a list of globs`);
    profile[key] = raw[key];
  }
  for (const key of ['notes', 'setup', 'base', 'worktrees'] as const) {
    if (raw[key] === undefined) continue;
    if (typeof raw[key] !== 'string') throw bad(`${key} must be text`);
    profile[key] = raw[key];
  }
  if (raw.issue_link !== undefined) {
    if (raw.issue_link !== 'closes' && raw.issue_link !== 'refs') throw bad('issue_link must be closes or refs');
    profile.issue_link = raw.issue_link;
  }
  if (raw.installs !== undefined) {
    if (!Array.isArray(raw.installs)) throw bad('installs must be a list of { path, key, run, version }');
    profile.installs = raw.installs.map((v, n): Install => {
      const at = `installs[${n}]`;
      if (!isRecord(v)) throw bad(`${at} must be { path, key, run, version }`);
      if (typeof v.path !== 'string' || !v.path || v.path.startsWith('/') || v.path.split('/').includes('..')) throw bad(`${at}.path must be a folder (or a glob) inside the project`);
      if (typeof v.run !== 'string') throw bad(`${at}.run must be the command that makes ${v.path}`);
      const key = typeof v.key === 'string' ? [v.key] : v.key;
      if (!isStrings(key) || !key.length) throw bad(`${at}.key must list the files that decide ${v.path} (its lockfile)`);
      if (v.version !== undefined && typeof v.version !== 'string') throw bad(`${at}.version must be a command`);
      return { path: v.path, key, run: v.run, ...(typeof v.version === 'string' ? { version: v.version } : {}) };
    });
  }
  if (raw.ui !== undefined) profile.ui = parseUi(raw.ui, bad);
  const name = (at: string, n: string) => {
    if (!/^[A-Za-z_][A-Za-z0-9_]*$/.test(n)) throw bad(`${at}: ${n} is not a variable name (letters, digits and _, not starting with a digit)`);
    if (RESERVED.has(n) || RESERVED_PREFIX.test(n)) throw bad(`${at}: Animus or Helix sets ${n} itself; use another name`);
  };
  if (raw.env !== undefined) {
    if (!isRecord(raw.env)) throw bad('env must map a variable name to its value');
    for (const [n, v] of Object.entries(raw.env)) {
      name(`env.${n}`, n);
      if (typeof v !== 'string' && typeof v !== 'number' && typeof v !== 'boolean') throw bad(`env.${n} must be text`);
      profile.env[n] = String(v);
    }
  }
  if (raw.secrets !== undefined) {
    if (!isStrings(raw.secrets)) throw bad('secrets must list names; their values are kept where jobs run, never in the profile');
    for (const n of raw.secrets) {
      name('secrets', n);
      if (n in profile.env) throw bad(`${n} is in both env and secrets; keep it in one`);
    }
    profile.secrets = [...new Set(raw.secrets)];
  }
  return profile;
}

/** What a job runs with beyond its process's own environment: the profile's env, and each of its secrets that `source` has. */
export function jobEnv(profile: Pick<Profile, 'env' | 'secrets'>, source: Record<string, string | undefined> = process.env): Record<string, string> {
  const env = { ...profile.env };
  for (const n of profile.secrets) if (source[n]) env[n] = source[n];
  return env;
}

/** Puts a job's env into this process's environment, so every command and session it starts has it. */
export function useJobEnv(profile: Pick<Profile, 'env' | 'secrets'>): void {
  Object.assign(process.env, jobEnv(profile));
}

function parseUi(raw: unknown, bad: (what: string) => AnimusError): UiProfile {
  if (!isRecord(raw)) throw bad('ui must be a mapping: { targets, human_review }');
  const ui: UiProfile = { targets: [], human_review: true };
  if (raw.human_review !== undefined) {
    if (typeof raw.human_review !== 'boolean') throw bad('ui.human_review must be true or false');
    ui.human_review = raw.human_review;
  }
  if (raw.targets === undefined) return ui;
  if (!isRecord(raw.targets)) throw bad('ui.targets must map a name to a target');
  for (const [name, t] of Object.entries(raw.targets)) {
    const at = `ui.targets.${name}`;
    if (!isRecord(t)) throw bad(`${at} must be a mapping`);
    const kind = t.kind ?? 'web';
    if (kind !== 'web' && kind !== 'app') throw bad(`${at}.kind must be web or app`);
    const str = (k: string) => {
      if (t[k] === undefined) return undefined;
      if (typeof t[k] !== 'string') throw bad(`${at}.${k} must be text`);
      return t[k] as string;
    };
    const list = (k: string) => {
      if (t[k] === undefined) return [];
      if (typeof t[k] === 'string') return [t[k] as string];
      if (!isStrings(t[k])) throw bad(`${at}.${k} must be a list`);
      return t[k] as string[];
    };
    const target: UiTarget = { name, kind, paths: list('paths'), pages: [], viewports: [], references: list('references') };
    for (const k of ['serve', 'url', 'ready', 'capture'] as const) {
      const v = str(k);
      if (v !== undefined) target[k] = v;
    }
    if (kind === 'web' && !target.url) throw bad(`${at}.url is needed for a web target (with $PORT if serve starts it)`);
    if (kind === 'app' && !target.capture) throw bad(`${at}.capture is needed for an app target: a command that writes PNGs into $ANIMUS_SHOTS`);
    if (t.pages !== undefined) {
      if (!isRecord(t.pages)) throw bad(`${at}.pages must map a name to a path or { path, reference }`);
      for (const [page, p] of Object.entries(t.pages)) {
        if (typeof p === 'string') target.pages.push({ name: page, path: p });
        else if (isRecord(p) && (p.path === undefined || typeof p.path === 'string') && (p.reference === undefined || typeof p.reference === 'string')) {
          const entry: UiPage = { name: page, path: typeof p.path === 'string' ? p.path : '/' };
          if (typeof p.reference === 'string') entry.reference = p.reference;
          target.pages.push(entry);
        } else throw bad(`${at}.pages.${page} must be a path or { path, reference }`);
      }
    }
    if (kind === 'web' && !target.pages.length) target.pages.push({ name: 'home', path: '/' });
    for (const v of list('viewports')) {
      const m = /^(\d+)x(\d+)$/.exec(v);
      if (!m) throw bad(`${at}.viewports: ${v} is not <width>x<height>`);
      target.viewports.push({ w: Number(m[1]), h: Number(m[2]) });
    }
    if (kind === 'web' && !target.viewports.length) target.viewports.push({ w: 1280, h: 800 }, { w: 390, h: 844 });
    ui.targets.push(target);
  }
  return ui;
}

/** The commands a job of this type runs, by name. */
export function checksFor(profile: Profile, type: string): string[] {
  return profile.checks[type] ?? Object.keys(profile.commands);
}

export function isRecord(v: unknown): v is Record<string, unknown> {
  return typeof v === 'object' && v !== null && !Array.isArray(v);
}

export function isStrings(v: unknown): v is string[] {
  return Array.isArray(v) && v.every((s) => typeof s === 'string');
}
