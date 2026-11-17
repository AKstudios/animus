// Version numbers, with nothing imported, so `animus setup` can use them
// from the marketplace's clone before the plugin's dependencies are installed.

/** The oldest Claude Code a real job has run on. Jobs use its newer flags (--autocompact, --max-budget-usd, --json-schema). */
export const MIN_CLAUDE = '2.1.322';

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
