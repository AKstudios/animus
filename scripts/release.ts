// Cuts a release: node scripts/release.ts <version> [--breaking]
//
// From a clean main that matches origin, with the tests and the typecheck
// passing, it sets the version everywhere it is written, turns CHANGELOG.md's
// Unreleased section into this release's, commits, tags v<version> and moves
// the stable branch to it. It pushes nothing: it prints the push.
//
// Teammates' Claude Code follows stable (docs/releases.md); Helix moves with
// `helix upgrade v<version>`. A version that Helix and older clients cannot
// share (version.ts, compatible) needs --breaking, to say it was meant.
import { spawnSync } from 'node:child_process';
import { readFileSync, writeFileSync } from 'node:fs';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { atLeast, compatible, parseVersion } from '../plugin/src/version.ts';

const ROOT = join(dirname(fileURLToPath(import.meta.url)), '..');
const MANIFEST = join(ROOT, 'plugin', '.claude-plugin', 'plugin.json');
const CHANGELOG = join(ROOT, 'CHANGELOG.md');

function die(message: string): never {
  console.error(`release: ${message}`);
  process.exit(1);
}
const git = (...args: string[]) => {
  const r = spawnSync('git', args, { cwd: ROOT, encoding: 'utf8' });
  if (r.status !== 0) die(`git ${args.join(' ')}: ${r.stderr.trim()}`);
  return r.stdout.trim();
};
const run = (command: string, args: string[], cwd = ROOT) => {
  if (spawnSync(command, args, { cwd, stdio: 'inherit', shell: process.platform === 'win32' }).status !== 0) die(`${command} ${args.join(' ')} failed`);
};

const [version, ...flags] = process.argv.slice(2);
if (!version || !/^\d+\.\d+\.\d+$/.test(version)) die('usage: node scripts/release.ts <major.minor.patch> [--breaking]');
const current = (JSON.parse(readFileSync(MANIFEST, 'utf8')) as { version: string }).version;
if (!parseVersion(current) || atLeast(current, version)) die(`${version} is not after the current ${current}`);
if (!compatible(current, version) && !flags.includes('--breaking')) {
  die(`${version} cannot work with ${current} clients: Helix will refuse every animus not yet updated. Pass --breaking if that is meant, and upgrade Helix and tell the team together`);
}

if (git('rev-parse', '--abbrev-ref', 'HEAD') !== 'main') die('releases are cut from main');
if (git('status', '--porcelain')) die('the checkout has uncommitted changes');
git('fetch', 'origin', 'main');
if (git('rev-parse', 'HEAD') !== git('rev-parse', 'origin/main')) die('main is not the same as origin/main: pull or push first');

const log = readFileSync(CHANGELOG, 'utf8');
const m = /^## Unreleased\n([\s\S]*?)(?=^## |(?![\s\S]))/m.exec(log);
if (!m || !m[1]!.trim()) die('CHANGELOG.md has nothing under "## Unreleased": say what this release changes, and mark what breaks');

run('npm', ['test']);
run('npm', ['run', 'typecheck']);

const manifest = JSON.parse(readFileSync(MANIFEST, 'utf8')) as Record<string, unknown>;
writeFileSync(MANIFEST, `${JSON.stringify({ ...manifest, version }, null, 2)}\n`);
run('npm', ['version', version, '--no-git-tag-version', '--allow-same-version']);
run('npm', ['version', version, '--no-git-tag-version', '--allow-same-version'], join(ROOT, 'plugin'));
const date = new Date().toISOString().slice(0, 10);
writeFileSync(CHANGELOG, log.replace(/^## Unreleased\n/m, `## Unreleased\n\n## ${version} (${date})\n`));

git('add', '-A');
git('commit', '-m', `Release ${version}`);
git('tag', '-a', `v${version}`, '-m', `Animus ${version}`);
git('branch', '-f', 'stable', `v${version}`);
console.log(`v${version} is tagged and stable points at it. To publish it:

  git push origin main v${version} stable

then on the Helix machine: helix upgrade v${version}`);
