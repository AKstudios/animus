// Animus's release version, and which versions can talk to each other. The one
// version lives in the plugin's manifest; the plugin and Helix ship from the
// same tag, so they share it.
import { readFileSync } from 'node:fs';
import { join } from 'node:path';
import { PLUGIN_ROOT } from './profiles.ts';
import { tryGit } from './proc.ts';
import { parseVersion } from './semver.ts';

export { atLeast, MIN_CLAUDE, parseVersion } from './semver.ts';

export function animusVersion(): string {
  const manifest = JSON.parse(readFileSync(join(PLUGIN_ROOT, '.claude-plugin', 'plugin.json'), 'utf8')) as { version?: string };
  return manifest.version ?? '0.0.0';
}

/** The release that runs: the plugin's version, with the commit (and -dirty) when it runs from a git checkout. */
export function factoryVersion(): string {
  const head = tryGit(PLUGIN_ROOT, ['rev-parse', '--short', 'HEAD']);
  if (!head) return animusVersion();
  return `${animusVersion()}+${head}${tryGit(PLUGIN_ROOT, ['status', '--porcelain', '--', '.']) ? '-dirty' : ''}`;
}

/**
 * Whether a client and a Helix can work together: the same major version, and
 * before 1.0 the same minor, since there a minor release may break the API.
 * A release that breaks the HTTP API, a spec, a profile or a job's files bumps
 * that number, and Helix then refuses older clients with how to update.
 */
export function compatible(a: string, b: string): boolean {
  const x = parseVersion(a), y = parseVersion(b);
  if (!x || !y) return false;
  return x[0] === y[0] && (x[0] > 0 || x[1] === y[1]);
}
