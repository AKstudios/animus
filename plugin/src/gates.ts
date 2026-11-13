// The gates: the profile's commands for the job's type (lint, types, tests,
// build), then the `$ command` lines of the spec's acceptance criteria, run in
// the job's worktree by a script. Their captured output is also the evidence
// the pull request shows for each criterion. Adapted from orbit's checks.ts.
import { existsSync } from 'node:fs';
import { join } from 'node:path';
import { matchesAny } from './git.ts';
import { checksFor, type Profile } from './profile.ts';
import type { Plan } from './profiles.ts';
import { ANSI, failureExcerpt, sh } from './proc.ts';
import type { Spec } from './spec.ts';

/** criterion: the acceptance criterion (from 1) the command proves. skip: why this job does not run it. */
export type Check = { name: string; command: string; cwd?: string; skip?: string; env?: Record<string, string>; note?: string; criterion?: number };
export type CheckResult = { name: string; command: string; ok: boolean; skipped: boolean; ms: number; output: string; note?: string; criterion?: number };

/** The project's own tool folders, in front of PATH, so `vitest` or `pytest` runs the worktree's copy. */
const TOOL_DIRS = ['node_modules/.bin', '.venv/bin'];

export function toolPath(dirs: readonly string[], path = process.env.PATH ?? ''): string {
  const found = dirs.flatMap((d) => TOOL_DIRS.map((t) => join(d, t))).filter((d) => existsSync(d));
  return [...found, path].filter(Boolean).join(':');
}

const squash = (command: string) => command.trim().replace(/\s+/g, ' ');

/**
 * A job's gates. A profile command with `paths` is skipped when the job
 * changed nothing under them. A trivial job (plan.gates affected) runs a
 * command's `affected` form where the profile has one. The same command
 * twice runs once, as the acceptance one.
 */
export function jobChecks(profile: Profile, plan: Pick<Plan, 'type' | 'gates'>, spec: Pick<Spec, 'criteria'>, changed: { base: string; files: readonly string[] }): Check[] {
  const checks: Check[] = checksFor(profile, plan.type).map((name) => {
    const c = profile.commands[name]!;
    const check: Check = c.cwd ? { name, command: c.run, cwd: c.cwd } : { name, command: c.run };
    if (c.paths && !changed.files.some((f) => matchesAny(f, c.paths!))) check.skip = `no change under ${c.paths.join(', ')}`;
    else if (plan.gates === 'affected' && c.affected) {
      Object.assign(check, { command: c.affected, note: 'affected form', env: { ANIMUS_BASE: changed.base, ANIMUS_CHANGED: changed.files.join(' ') } });
    }
    return check;
  });
  const profileChecks = checks.length;
  let n = 0;
  spec.criteria.forEach((criterion, i) => {
    for (const command of criterion.commands) {
      const name = `acceptance-${++n}`;
      const key = squash(command);
      for (const c of checks.slice(0, profileChecks)) {
        if (!c.skip && !c.cwd && squash(profile.commands[c.name]!.run) === key) c.skip = `${name} runs the same command`;
      }
      checks.push({ name, command, criterion: i + 1 });
    }
  });
  return checks;
}

/** Runs every check, stopping at nothing, so all failures are reported at once. */
export function runChecks(worktree: string, checks: readonly Check[], job: string): CheckResult[] {
  const ran = new Map<string, CheckResult>();
  return checks.map((c): CheckResult => {
    const meta = { name: c.name, command: c.command, ...(c.criterion ? { criterion: c.criterion } : {}), ...(c.note ? { note: c.note } : {}) };
    const skipped = (output: string): CheckResult => ({ ...meta, ok: true, skipped: true, ms: 0, output });
    if (c.skip) return skipped(c.skip);
    const cwd = c.cwd ? join(worktree, c.cwd) : worktree;
    // A check for a part of the project that does not exist yet has nothing to check.
    if (!existsSync(cwd)) return skipped(`${c.cwd}/ does not exist yet`);
    // Two criteria proved by one command: it runs once, and both show its result.
    const twin = c.cwd ? undefined : ran.get(squash(c.command));
    if (twin) return { ...twin, ...meta, ms: 0 };
    const env = { ...c.env, ANIMUS_JOB: job, CI: '1', PATH: toolPath([...(c.cwd ? [cwd] : []), worktree]) };
    const r = sh(c.command, cwd, env);
    const result: CheckResult = { ...meta, ok: r.code === 0, skipped: false, ms: r.ms, output: r.output };
    if (!c.cwd) ran.set(squash(c.command), result);
    return result;
  });
}

// What a test runner prints when its arguments select no test at all: the
// command never reaches the tests, so no code change can pass it.
const NO_TESTS = /No test files found|No tests found|no tests ran|collected 0 items|\bRan 0 tests\b|No tests to run/i;
const NO_TESTS_HINT = 'This command found no tests at all: it does not reach the test file it names (wrong folder, or outside the runner\'s config). If the test file is where the spec says, say in your final answer that the acceptance command is wrong.';

export function findsNoTests(output: string): boolean {
  return NO_TESTS.test(output.replace(ANSI, ''));
}

/** One line per check (a skipped one says why), then the output of each failure, short. */
export function describe(results: readonly CheckResult[]): string {
  const lines = results.map((r) => `${r.skipped ? 'skip' : r.ok ? 'ok  ' : 'FAIL'} ${r.name}: ${r.command} (${r.skipped ? r.output : `${(r.ms / 1000).toFixed(1)}s${r.note ? `; ${r.note}` : ''}`})`);
  const failures = results.filter((r) => !r.ok).map((r) => `--- ${r.name}: ${r.command}\n${failureExcerpt(r.output, 40)}${findsNoTests(r.output) ? `\n${NO_TESTS_HINT}` : ''}`);
  return [...lines, ...failures].join('\n');
}
