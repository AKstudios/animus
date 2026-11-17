// `animus init`: a first .animus/animus.yaml for a repository, written from
// what its root says about itself (package.json, pyproject.toml, go.mod,
// Cargo.toml). It runs nothing and guesses nothing it cannot read; what it
// could not find it says, for the person to fill in.
import { existsSync, mkdirSync, readFileSync, writeFileSync } from 'node:fs';
import { dirname, join } from 'node:path';
import { stringify } from 'yaml';
import { isRecord, parseProfile, PROFILE_PATH } from './profile.ts';
import { AnimusError, tryGit } from './proc.ts';

type Found = { setup?: string; commands: [name: string, run: string][]; ui?: Record<string, unknown>; said: string[] };

const has = (repo: string, file: string) => existsSync(join(repo, file));
const read = (repo: string, file: string) => readFileSync(join(repo, file), 'utf8');

const PACKAGE_MANAGERS = [
  { lock: 'pnpm-lock.yaml', install: 'pnpm install --frozen-lockfile', run: 'pnpm run' },
  { lock: 'yarn.lock', install: 'yarn install --frozen-lockfile', run: 'yarn run' },
  { lock: 'bun.lock', install: 'bun install --frozen-lockfile', run: 'bun run' },
  { lock: 'bun.lockb', install: 'bun install --frozen-lockfile', run: 'bun run' },
  { lock: 'package-lock.json', install: 'npm ci', run: 'npm run' },
] as const;

/** Script names a gate may go by, in the order the gates run: the cheap ones first. */
const SCRIPTS: [gate: string, names: string[]][] = [['lint', ['lint']], ['typecheck', ['typecheck', 'type-check', 'check-types', 'types', 'tsc']], ['test', ['test']], ['build', ['build']]];

function node(repo: string): Found | undefined {
  if (!has(repo, 'package.json')) return undefined;
  let pkg: unknown;
  try { pkg = JSON.parse(read(repo, 'package.json')); } catch { throw new AnimusError(`${join(repo, 'package.json')} is not JSON`); }
  const scripts = isRecord(pkg) && isRecord(pkg.scripts) ? pkg.scripts : {};
  const deps = isRecord(pkg) ? { ...(isRecord(pkg.dependencies) ? pkg.dependencies : {}), ...(isRecord(pkg.devDependencies) ? pkg.devDependencies : {}) } : {};
  const pm = PACKAGE_MANAGERS.find((m) => has(repo, m.lock));
  const found: Found = { commands: [], said: [] };
  if (pm) found.setup = pm.install;
  else found.said.push('package.json has no lockfile beside it, so no setup command was written: jobs start with nothing installed');
  const run = pm?.run ?? 'npm run';
  for (const [gate, names] of SCRIPTS) {
    const script = names.find((n) => typeof scripts[n] === 'string' && !/no test specified/.test(scripts[n] as string));
    if (script) found.commands.push([gate, `${run} ${script}`]);
    else found.said.push(`package.json has no ${gate} script`);
  }
  if (typeof scripts.dev === 'string' && ('vite' in deps || 'next' in deps)) {
    const flags = 'vite' in deps ? '--port $PORT --strictPort --host 127.0.0.1' : '--port $PORT --hostname 127.0.0.1';
    found.ui = { targets: { app: { serve: `${run} dev -- ${flags}`, url: 'http://127.0.0.1:$PORT', pages: { home: '/' } } } };
  } else found.said.push('no web app was recognised (a dev script with vite or next), so there is no ui target: ui specs will be refused until you add one');
  return found;
}

function python(repo: string): Found | undefined {
  if (!has(repo, 'pyproject.toml')) return undefined;
  const text = read(repo, 'pyproject.toml');
  const uv = has(repo, 'uv.lock');
  const run = uv ? 'uv run ' : '';
  const found: Found = { commands: [], said: [] };
  if (uv) found.setup = 'uv sync';
  else found.said.push('pyproject.toml has no uv.lock beside it, so no setup command was written for Python');
  if (/\bruff\b/.test(text)) found.commands.push(['lint', `${run}ruff check .`]);
  if (/\bmypy\b/.test(text)) found.commands.push(['typecheck', `${run}mypy .`]);
  if (/\bpytest\b/.test(text) || has(repo, 'tests')) found.commands.push(['test', `${run}pytest`]);
  else found.said.push('pyproject.toml does not mention pytest and there is no tests/ folder, so no Python test command was written');
  return found;
}

const go = (repo: string): Found | undefined => (has(repo, 'go.mod') ? { commands: [['lint', 'go vet ./...'], ['test', 'go test ./...']], said: [] } : undefined);
const rust = (repo: string): Found | undefined => (has(repo, 'Cargo.toml') ? { commands: [['lint', 'cargo clippy -- -D warnings'], ['test', 'cargo test']], said: [] } : undefined);

const ECOSYSTEMS: [name: string, detect: (repo: string) => Found | undefined][] = [['node', node], ['python', python], ['go', go], ['rust', rust]];

/** The profile's text for this repository, and what could not be worked out. */
export function draftProfile(repo: string): { text: string; said: string[] } {
  const found = ECOSYSTEMS.flatMap(([name, detect]) => { const f = detect(repo); return f ? [{ name, ...f }] : []; });
  if (!found.length) throw new AnimusError(`nothing at the root of ${repo} says how it is built (no package.json, pyproject.toml, go.mod or Cargo.toml). Write ${PROFILE_PATH} by hand: docs/configuration.md in Animus lists its keys`);
  const commands: Record<string, string> = {};
  // Two ecosystems at one root both have a test command: the second is named for its ecosystem.
  for (const f of found) for (const [gate, run] of f.commands) commands[gate in commands ? `${f.name}-${gate}` : gate] = run;
  const said = found.flatMap((f) => f.said);
  if (!('test' in commands)) said.push('no test command was found: without one the only gates are a spec\'s own acceptance commands');
  const head = tryGit(repo, ['symbolic-ref', '--short', 'refs/remotes/origin/HEAD'])?.replace(/^origin\//, '');
  const base = head ?? tryGit(repo, ['branch', '--show-current']) ?? 'main';
  const setup = found.flatMap((f) => (f.setup ? [f.setup] : [])).join(' && ');
  const ui = found.find((f) => f.ui)?.ui;
  const profile = { ...(setup ? { setup } : {}), commands, base, ...(ui ? { ui } : {}) };
  const text = [
    '# Animus\'s profile for this repository, drafted by `animus init` from what the root says.',
    '# Read it and correct it: the commands are the gates every job must pass.',
    '# Other keys (notes, protected, checks, installs, tests) are in Animus\'s docs/configuration.md.',
    ...said.map((s) => `# Not found: ${s}.`),
    '',
    stringify(profile, { lineWidth: 0 }),
  ].join('\n');
  parseProfile(text);
  return { text, said };
}

/** Writes the drafted profile. Refuses to replace one that is there. */
export function initProfile(repo: string, force = false): { file: string; text: string; said: string[] } {
  const file = join(repo, PROFILE_PATH);
  if (existsSync(file) && !force) throw new AnimusError(`${file} already exists; --force replaces it`);
  const draft = draftProfile(repo);
  mkdirSync(dirname(file), { recursive: true });
  writeFileSync(file, draft.text);
  return { file, ...draft };
}
