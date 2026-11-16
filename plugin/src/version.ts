// Animus's release version, and which versions can talk to each other. The one
// version lives in the plugin's manifest; the plugin and Helix ship from the
// same tag, so they share it.
import { readFileSync } from 'node:fs';
import { join } from 'node:path';
import { PLUGIN_ROOT } from './profiles.ts';

/** The oldest Claude Code a real job has run on. Jobs use its newer flags (--autocompact, --max-budget-usd, --json-schema). */
export const MIN_CLAUDE = '2.1.322';

export function animusVersion(): string {
  const manifest = JSON.parse(readFileSync(join(PLUGIN_ROOT, '.claude-plugin', 'plugin.json'), 'utf8')) as { version?: string };
  return manifest.version ?? '0.0.0';
}

/** The numbers of a version such as 1.2.3 or 2.1.322 (Claude Code), or undefined. */
export function parseVersion(v: string): [number, number, number] | undefined {
  const m = /(\d+)\.(\d+)\.(\d+)/.exec(v);
  return m ? [Number(m[1]), Number(m[2]), Number(m[3])] : undefined;
}

export function atLeast(v: string, min: string): boolean {
  const a = parseVersion(v), b = parseVersion(min);
  if (!a || !b) return false;
  for (let i = 0; i < 3; i++) if (a[i] !== b[i]) return a[i]! > b[i]!;
  return true;
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
