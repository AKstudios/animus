// The install cache. Every stage, land and epic check gets a fresh worktree,
// and installing into each (npm ci, cargo build, ...) is minutes of CPU and
// disk once five run at once. The profile's `installs` name what an install
// command makes (node_modules, target) and the files that decide it (the
// lockfile); the first worktree to run it saves the result under
// .git/animus/installs, and every later worktree with the same lockfile,
// tool version and platform gets a copy-on-write clone instead. On APFS one
// clonefile call clones a whole folder: 643 MB of node_modules in 0.4 s and
// almost no disk. The cache is filled by what the install command itself
// made in a clean worktree, never by the person's own checkout, so it holds
// exactly what a fresh install would.
import { createHash } from 'node:crypto';
import { existsSync, mkdirSync, readdirSync, readFileSync, readlinkSync, realpathSync, renameSync, rmSync, statSync, utimesSync, writeFileSync } from 'node:fs';
import { spawnSync } from 'node:child_process';
import { dirname, isAbsolute, join, matchesGlob } from 'node:path';
import { commonDir, withScratch } from './git.ts';
import { failureExcerpt, AnimusError, sh, tryGit } from './proc.ts';

/**
 * path: what run makes, relative to the root: a folder (web/node_modules) or
 * a glob of ignored folders (**\/node_modules for workspaces). key: files
 * whose contents decide it. version: a command whose output is part of the
 * key too (node --version), for installs that depend on the tool.
 */
export type Install = { path: string; key: string[]; run: string; version?: string };

/** How many saved installs each path keeps; older ones go when a worktree is removed. */
const KEEP = 2;
/** A partial save this old was abandoned; a save used this recently may be being cloned by another job, so it stays. */
const RECENT_MS = 60 * 60 * 1000;

export const installsRoot = (cwd: string) => join(commonDir(cwd), 'animus', 'installs');

const slug = (path: string) => path.replace(/[^A-Za-z0-9._-]+/g, '_');

/** The cache key: the install, the platform, the tool's version and the key files' contents. */
export function installKey(worktree: string, i: Install, read: (file: string) => Buffer | undefined = (f) => (existsSync(join(worktree, f)) ? readFileSync(join(worktree, f)) : undefined)): string {
  const h = createHash('sha256');
  h.update(JSON.stringify([i.path, i.run, process.platform, process.arch]));
  if (i.version) {
    const r = sh(i.version, worktree, {}, 30_000);
    h.update(`\0version ${r.code} ${r.output.trim()}`);
  }
  for (const f of i.key) {
    h.update(`\0${f}\0`);
    h.update(read(f) ?? '(none)');
  }
  return h.digest('hex').slice(0, 20);
}

/**
 * Clones a folder copy-on-write: one clonefile call on macOS (by the system
 * perl, which can make the syscall; Node cannot), else cp with reflinks. A
 * filesystem without clones fails, and the caller installs instead: a full
 * copy would be no faster than the install.
 */
export function cloneDir(from: string, to: string): boolean {
  mkdirSync(dirname(to), { recursive: true });
  if (process.platform === 'darwin') {
    // SYS_clonefileat is 462; -2 is AT_FDCWD.
    const r = spawnSync('/usr/bin/perl', ['-e', 'exit(syscall(462, -2, $ARGV[0], -2, $ARGV[1], 0) == 0 ? 0 : 1)', from, to], { stdio: 'ignore' });
    if (r.status === 0) return true;
    rmSync(to, { recursive: true, force: true });
    if (spawnSync('cp', ['-cR', from, to], { stdio: 'ignore' }).status === 0) return true;
  } else if (spawnSync('cp', ['-R', '--reflink=always', from, to], { stdio: 'ignore' }).status === 0) return true;
  rmSync(to, { recursive: true, force: true });
  return false;
}

/** The folders an install made: its path if it exists, or the ignored folders its glob matches. */
function madeBy(worktree: string, i: Install): string[] {
  if (!/[*?[{]/.test(i.path)) return existsSync(join(worktree, i.path)) ? [i.path] : [];
  const ignored = (tryGit(worktree, ['ls-files', '-z', '--others', '--ignored', '--exclude-standard', '--directory']) ?? '').split('\0');
  return ignored.map((p) => p.replace(/\/$/, '')).filter((p) => p && matchesGlob(p, i.path));
}

/** A symlink pointing into the worktree by its absolute path would point into a removed worktree once cloned elsewhere. */
function pinnedTo(worktree: string, dirs: readonly string[]): string | undefined {
  const root = realpathSync(worktree);
  const r = spawnSync('find', [...dirs, '-type', 'l'], { cwd: worktree, encoding: 'utf8', maxBuffer: 64 * 1024 * 1024 });
  for (const link of (r.stdout ?? '').split('\n').filter(Boolean)) {
    let target: string;
    try { target = readlinkSync(join(worktree, link)); } catch { continue; }
    if (isAbsolute(target) && (target === root || target.startsWith(`${root}/`) || target.startsWith(`${worktree}/`))) return link;
  }
  return undefined;
}

type Used = { install: Install; entry: string; restored: boolean };

/**
 * Brings each install into the worktree: cloned from the cache when it holds
 * this key, else made by its run command and then saved. Returns what it
 * used, so a setup that fails on restored installs can drop them.
 */
export function restoreInstalls(worktree: string, installs: readonly Install[], log: (line: string) => void = () => {}): Used[] {
  const used: Used[] = [];
  for (const i of installs) {
    const entry = join(installsRoot(worktree), slug(i.path), installKey(worktree, i));
    if (restore(worktree, entry)) {
      used.push({ install: i, entry, restored: true });
      continue;
    }
    make(worktree, i);
    const why = save(worktree, i, entry);
    if (why) log(`install cache: ${i.path} not saved: ${why}`);
    used.push({ install: i, entry, restored: false });
  }
  return used;
}

function restore(worktree: string, entry: string): boolean {
  let dirs: string[];
  try { dirs = JSON.parse(readFileSync(join(entry, 'dirs.json'), 'utf8')) as string[]; } catch { return false; }
  const done: string[] = [];
  for (const d of dirs) {
    if (existsSync(join(worktree, d))) continue;
    if (!cloneDir(join(entry, 'files', d), join(worktree, d))) {
      for (const x of done) rmSync(join(worktree, x), { recursive: true, force: true });
      return false;
    }
    done.push(d);
  }
  const now = new Date();
  // A clone keeps the times of when it was saved, older than the files just
  // checked out; a check that reinstalls when its lockfile is newer than the
  // install's own record (node_modules/.package-lock.json) would then
  // reinstall. The install is as new as a fresh one would be.
  for (const d of done) {
    const at = join(worktree, d);
    for (const e of [at, ...readdirSync(at).map((x) => join(at, x))]) try { utimesSync(e, now, now); } catch { /* a dangling link */ }
  }
  try { utimesSync(entry, now, now); } catch { /* pruned meanwhile; what was cloned stands */ }
  return true;
}

function make(worktree: string, i: Install): void {
  const r = sh(i.run, worktree, { CI: '1' });
  if (r.code !== 0) throw new AnimusError(`install failed in ${worktree}: ${i.run}\n${failureExcerpt(r.output, 40)}`);
}

/** Saves what the install made; says why not when it cannot. */
function save(worktree: string, i: Install, entry: string): string | undefined {
  if (existsSync(join(entry, 'dirs.json'))) return undefined;
  const dirs = madeBy(worktree, i);
  if (!dirs.length) return `${i.run} made nothing at ${i.path}`;
  const pinned = pinnedTo(worktree, dirs);
  if (pinned) return `${pinned} links to the worktree by its absolute path, so a clone elsewhere would break`;
  const tmp = `${entry}.tmp-${process.pid}`;
  rmSync(tmp, { recursive: true, force: true });
  for (const d of dirs) {
    if (!cloneDir(join(worktree, d), join(tmp, 'files', d))) {
      rmSync(tmp, { recursive: true, force: true });
      return 'this filesystem cannot clone copy-on-write';
    }
  }
  writeFileSync(join(tmp, 'dirs.json'), JSON.stringify(dirs));
  try {
    renameSync(tmp, entry);
  } catch {
    // Another worktree saved the same key first.
    rmSync(tmp, { recursive: true, force: true });
  }
  return undefined;
}

/** After a setup failed on restored installs: they go from the cache and the worktree, and are made afresh. */
export function remakeInstalls(worktree: string, used: readonly Used[]): void {
  for (const u of used.filter((x) => x.restored)) {
    rmSync(u.entry, { recursive: true, force: true });
    for (const d of madeBy(worktree, u.install)) rmSync(join(worktree, d), { recursive: true, force: true });
    make(worktree, u.install);
    save(worktree, u.install, u.entry);
  }
}

/**
 * Keeps the KEEP most recently used saves of each install, and any used in
 * the last hour, and drops abandoned partial ones. Returns how many went.
 */
export function pruneInstalls(repo: string, now = Date.now()): number {
  const root = installsRoot(repo);
  if (!existsSync(root)) return 0;
  let n = 0;
  for (const name of readdirSync(root)) {
    const dir = join(root, name);
    const entries = readdirSync(dir).map((e) => ({ e, at: statSync(join(dir, e)).mtimeMs }));
    for (const t of entries.filter((x) => x.e.includes('.tmp-') && now - x.at > RECENT_MS)) {
      rmSync(join(dir, t.e), { recursive: true, force: true });
      n++;
    }
    const saved = entries.filter((x) => !x.e.includes('.tmp-')).sort((a, b) => b.at - a.at);
    for (const old of saved.slice(KEEP).filter((x) => now - x.at > RECENT_MS)) {
      rmSync(join(dir, old.e), { recursive: true, force: true });
      n++;
    }
  }
  return n;
}

// ------------------------------------------------------------- detection

/**
 * The installs a project's lockfiles call for, for animus init. Only installs
 * whose folder works wherever it is cloned: JavaScript dependencies and
 * Cargo's target. A Python virtualenv names its own absolute path in every
 * script, so uv and pip stay in setup (uv installs from its own cache in seconds).
 */
export function detectInstalls(repo: string): { installs: Install[]; setup: string[] } {
  const files = (tryGit(repo, ['ls-files', '-z']) ?? '').split('\0').filter((f) => f && !f.split('/').includes('node_modules'));
  const installs: Install[] = [];
  const setup: string[] = [];
  const at = (dir: string, p: string) => (dir === '.' ? p : `${dir}/${p}`);
  const inDir = (dir: string, cmd: string) => (dir === '.' ? cmd : `cd ${dir} && ${cmd}`);
  const workspaces = (dir: string) => {
    try { return Boolean((JSON.parse(readFileSync(join(repo, at(dir, 'package.json')), 'utf8')) as { workspaces?: unknown }).workspaces); } catch { return false; }
  };
  for (const f of files) {
    const dir = dirname(f);
    const name = f.slice(dir === '.' ? 0 : dir.length + 1);
    const modules = (all: boolean) => (all ? at(dir, '**/node_modules') : at(dir, 'node_modules'));
    if (name === 'package-lock.json') {
      installs.push({ path: modules(workspaces(dir)), key: [f], version: 'node --version', run: dir === '.' ? 'npm ci' : `npm ci --prefix ${dir}` });
    } else if (name === 'pnpm-lock.yaml') {
      installs.push({ path: modules(true), key: [f], version: 'node --version && pnpm --version', run: inDir(dir, 'pnpm install --frozen-lockfile') });
    } else if (name === 'bun.lock' || name === 'bun.lockb') {
      installs.push({ path: modules(workspaces(dir)), key: [f], version: 'bun --version', run: inDir(dir, 'bun install --frozen-lockfile') });
    } else if (name === 'yarn.lock') {
      const berry = existsSync(join(repo, at(dir, '.yarnrc.yml')));
      const pnp = berry && !/nodeLinker:\s*["']?node-modules/.test(readFileSync(join(repo, at(dir, '.yarnrc.yml')), 'utf8'));
      const run = inDir(dir, berry ? 'yarn install --immutable' : 'yarn install --frozen-lockfile');
      if (pnp) setup.push(run);
      else installs.push({ path: modules(true), key: [f], version: 'node --version && yarn --version', run });
    } else if (name === 'Cargo.lock') {
      const key = [f, ...['rust-toolchain', 'rust-toolchain.toml'].map((t) => at(dir, t)).filter((t) => files.includes(t))];
      installs.push({ path: at(dir, 'target'), key, version: 'rustc --version', run: inDir(dir, 'cargo build --locked --all-targets') });
    } else if (name === 'uv.lock') setup.push(inDir(dir, 'uv sync --frozen'));
    else if (name === 'poetry.lock') setup.push(inDir(dir, 'poetry install --no-interaction'));
    else if (name === 'Gemfile.lock') setup.push(inDir(dir, 'bundle install'));
    else if (name === 'go.sum') setup.push(inDir(dir, 'go mod download'));
  }
  return { installs, setup };
}

/** The installs as YAML lines for the profile. */
export function renderInstalls(installs: readonly Install[]): string[] {
  return installs.flatMap((i) => [
    `  - path: ${JSON.stringify(i.path)}`,
    `    key: [${i.key.map((k) => JSON.stringify(k)).join(', ')}]`,
    ...(i.version ? [`    version: ${JSON.stringify(i.version)}`] : []),
    `    run: ${JSON.stringify(i.run)}`,
  ]);
}
