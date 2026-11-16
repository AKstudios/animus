import assert from 'node:assert/strict';
import { mkdtempSync, readFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { test } from 'node:test';
import { initProfile } from '../src/init.ts';
import { loadProfile } from '../src/profile.ts';
import { AnimusError } from '../src/proc.ts';
import { write } from './helpers.ts';

const dir = () => mkdtempSync(join(tmpdir(), 'animus-init-'));

test('a node project gets its install as setup, its scripts as gates in order, and a ui target when it has a vite dev script', () => {
  const repo = dir();
  write(repo, 'package.json', JSON.stringify({ scripts: { test: 'vitest run', build: 'vite build', 'type-check': 'tsc --noEmit', dev: 'vite' }, devDependencies: { vite: '^7' } }));
  write(repo, 'pnpm-lock.yaml', '');
  const r = initProfile(repo);
  const profile = loadProfile(repo);
  assert.equal(profile.setup, 'pnpm install --frozen-lockfile');
  assert.deepEqual(Object.entries(profile.commands).map(([name, c]) => [name, c.run]), [['typecheck', 'pnpm run type-check'], ['test', 'pnpm run test'], ['build', 'pnpm run build']]);
  assert.deepEqual([profile.ui.targets[0]!.name, profile.ui.targets[0]!.serve], ['app', 'pnpm run dev -- --port $PORT --strictPort --host 127.0.0.1']);
  assert.deepEqual(r.said, ['package.json has no lint script']);
  assert.match(readFileSync(r.file, 'utf8'), /# Not found: package\.json has no lint script\./);
});

test('npm\'s placeholder test script is not a gate, and two ecosystems at one root keep both test commands', () => {
  const repo = dir();
  write(repo, 'package.json', JSON.stringify({ scripts: { test: 'echo "Error: no test specified" && exit 1', lint: 'eslint .' } }));
  write(repo, 'package-lock.json', '{}');
  write(repo, 'pyproject.toml', '[dependency-groups]\ndev = ["pytest", "ruff"]\n');
  write(repo, 'uv.lock', '');
  initProfile(repo);
  const profile = loadProfile(repo);
  assert.equal(profile.setup, 'npm ci && uv sync');
  assert.deepEqual(Object.entries(profile.commands).map(([name, c]) => [name, c.run]), [['lint', 'npm run lint'], ['python-lint', 'uv run ruff check .'], ['test', 'uv run pytest']]);
});

test('a profile that exists is kept unless forced, and a root that says nothing is an error', () => {
  const repo = dir();
  write(repo, 'go.mod', 'module example.test/x\n');
  write(repo, '.animus/animus.yaml', 'commands:\n  test: mine\n');
  assert.throws(() => initProfile(repo), /already exists/);
  assert.equal(loadProfile(repo).commands.test!.run, 'mine');
  initProfile(repo, true);
  assert.equal(loadProfile(repo).commands.test!.run, 'go test ./...');
  assert.throws(() => initProfile(dir()), AnimusError);
});
