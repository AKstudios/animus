// The gates: the profile's commands for the job's type (lint, types, tests,
// build), then the `$ command` lines of the spec's acceptance criteria, run in
// the job's worktree by a script. Their captured output is also the evidence
// the pull request shows for each criterion. Adapted from orbit's checks.ts.
import { existsSync, readFileSync, rmSync } from 'node:fs';
import { join } from 'node:path';
import { contentTree, matchesAny, withScratch } from './git.ts';
import { jobDir, writeJson } from './log.ts';
import { checksFor, type Profile } from './profile.ts';
import type { Plan } from './profiles.ts';
import { ANSI, failureExcerpt, sh, tryGit } from './proc.ts';
import type { Spec } from './spec.ts';
import { ensureSetup } from './workspace.ts';

/** criterion: the acceptance criterion (from 1) the command proves. skip: why this job does not run it. */
export type Check = { name: string; command: string; cwd?: string; skip?: string; env?: Record<string, string>; note?: string; criterion?: number };
export type CheckResult = { name: string; command: string; ok: boolean; skipped: boolean; ms: number; output: string; note?: string; criterion?: number; flaky?: boolean; reused?: boolean };

/** The project's own tool folders, in front of PATH, so `vitest` or `pytest` runs the worktree's copy. */
const TOOL_DIRS = ['node_modules/.bin', '.venv/bin'];

export function toolPath(dirs: readonly string[], path = process.env.PATH ?? ''): string {
  const found = dirs.flatMap((d) => TOOL_DIRS.map((t) => join(d, t))).filter((d) => existsSync(d));
  return [...found, path].filter(Boolean).join(':');
}

/** Why an acceptance command is skipped while a job is part-way through its slices. */
export const LATER_SLICE = 'its criterion belongs to a later slice';

const squash = (command: string) => command.trim().replace(/\s+/g, ' ');

/**
 * A job's gates. A profile command with `paths` is skipped when the job
 * changed nothing under them. A trivial job (plan.gates affected) runs a
 * command's `affected` form where the profile has one. The same command
 * twice runs once, as the acceptance one. While a job is part-way through
 * its slices, `only` holds the criteria finished so far, and the commands of
 * the others are skipped: nothing has been built for them yet.
 */
export function jobChecks(profile: Profile, plan: Pick<Plan, 'type' | 'gates'>, spec: Pick<Spec, 'criteria'>, changed: { base: string; files: readonly string[] }, only?: ReadonlySet<number>): Check[] {
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
      if (only && !only.has(i + 1)) { checks.push({ name, command, criterion: i + 1, skip: LATER_SLICE }); continue; }
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

/** Puts the worktree back to its last commit: what the gates or a reviewer changed is not the job's work. */
export function restore(worktree: string): void {
  tryGit(worktree, ['checkout', '--quiet', '--', '.']);
  tryGit(worktree, ['clean', '-fdq']);
}

/** What `animus check` ran in the session, and the code it ran on (contentTree), in the job's folder. */
type SessionChecks = { code: string; checks: readonly CheckResult[] };
const sessionFile = (job: string) => join(jobDir(job), 'session-checks.json');

/** Keeps what `animus check` ran; `code` is contentTree of the worktree, taken before the checks ran. */
export function saveSessionChecks(job: string, code: string, results: readonly CheckResult[]): void {
  writeJson(sessionFile(job), { code, checks: results } satisfies SessionChecks);
}

/** What a gate file and the pull request say above a result taken over from the session. */
export const REUSED = 'reused: the session\'s own `animus check` passed this on the same code';

/** The session's pass for a check by this name whose command `command` accepts, when it ran on the code the worktree holds now. Take it before anything changes the worktree. */
export type SessionPasses = (name: string, command: (recorded: string) => boolean) => CheckResult | undefined;

export function sessionPasses(worktree: string, job: string): SessionPasses {
  const file = sessionFile(job);
  if (!existsSync(file)) return () => undefined;
  const record = JSON.parse(readFileSync(file, 'utf8')) as SessionChecks;
  if (record.code !== contentTree(worktree)) return () => undefined;
  return (name, command) => {
    const r = record.checks.find((x) => x.name === name && command(x.command) && x.ok && !x.skipped);
    return r && { ...r, reused: true };
  };
}

/**
 * The checks `animus check` passed in the session on this same code are taken
 * over; the rest run, then each failed check once more on the same tree:
 * passing then, it was flaky and counts as passed.
 */
export function runGates(worktree: string, checks: readonly Check[], job: string, log: (line: string) => void = () => {}, passed = sessionPasses(worktree, job)): CheckResult[] {
  const taken = checks.map((c) => c.skip ? undefined : passed(c.name, (command) => command === c.command));
  const ran = runChecks(worktree, checks.filter((_, i) => !taken[i]), job);
  const results = taken.map((r) => r ?? ran.shift()!);
  const failed = results.filter((r) => !r.ok);
  if (!failed.length) return results;
  restore(worktree);
  for (const r of runChecks(worktree, checks.filter((c) => failed.some((f) => f.name === c.name)), job)) {
    if (!r.ok) continue;
    results[results.findIndex((x) => x.name === r.name)] = { ...r, flaky: true };
    log(`flaky: ${r.name} failed, then passed on the same code`);
  }
  return results;
}

export const FAILS_ON_BASE = 'fails-on-base';

/**
 * A bug job's proof that its test tests the fix: the spec's acceptance
 * commands run in a scratch worktree of the commit the job started from, with
 * only the test files the job changed laid over it. One of them must fail
 * there; the first that does is the evidence. It runs once the other gates
 * pass, so a red here means the tests pass with and without the fix.
 */
export function failsOnBase(p: { repo: string; profile: Profile; spec: Pick<Spec, 'criteria'>; base: string; head: string; files: readonly string[]; job: string; green: boolean }): CheckResult {
  const result = (ok: boolean, output: string, over: Partial<CheckResult> = {}): CheckResult => ({ name: FAILS_ON_BASE, command: 'the acceptance commands, on the base commit with only this job\'s test files', ok, skipped: false, ms: 0, output, ...over });
  if (!p.green) return result(true, 'runs once the other gates pass', { skipped: true });
  const tests = p.files.filter((f) => matchesAny(f, p.profile.tests));
  if (!tests.length) return result(false, `This job changed no test file, so nothing shows the bug is fixed. Add a test that fails without the fix. The project's test files are those matching: ${p.profile.tests.join(', ')}`);
  const commands = [...new Set(p.spec.criteria.flatMap((c) => c.commands))];
  const started = Date.now();
  return withScratch(p.repo, p.base, (scratch) => {
    for (const f of tests) if (tryGit(scratch, ['checkout', p.head, '--', f]) === undefined) rmSync(join(scratch, f), { force: true });
    ensureSetup(scratch, p.profile);
    for (const command of commands) {
      const [r] = runChecks(scratch, [{ name: FAILS_ON_BASE, command }], p.job);
      if (!r!.ok && !findsNoTests(r!.output)) return result(true, r!.output, { command, ms: Date.now() - started, note: 'on the base commit with only this job\'s test files, where it fails as it should' });
    }
    return result(false, `Every acceptance command passes on the commit the job started from with only your test files added (${tests.join(', ')}), so no test fails without the fix. Make the test reproduce the bug: it must fail before the fix and pass after it.`, { ms: Date.now() - started });
  });
}

// What a test runner prints when its arguments select no test at all: the
// command never reaches the tests, so no code change can pass it.
const NO_TESTS = /No test files found|No tests found|no tests ran|collected 0 items|\bRan 0 tests\b|No tests to run/i;
const NO_TESTS_HINT = 'This command found no tests at all: it does not reach the test file it names (wrong folder, or outside the runner\'s config). If the test file is where the spec says, say in your final answer that the acceptance command is wrong.';

export function findsNoTests(output: string): boolean {
  return NO_TESTS.test(output.replace(ANSI, ''));
}

/** A gate run as the job's folder keeps it (gates/run-N.txt): describe(), then each check that ran with all it printed. A job page reads it back. */
export const gateReport = (results: readonly CheckResult[]) => `${describe(results)}\n\n${results.filter((r) => !r.skipped).map((r) => `=== ${r.name}: ${r.command}\n${r.reused ? `${REUSED}\n` : ''}${r.output}`).join('\n')}`;

/** One line per check (a skipped one says why), then the output of each failure, short. */
export function describe(results: readonly CheckResult[]): string {
  const lines = results.map((r) => `${r.skipped ? 'skip' : r.ok ? 'ok  ' : 'FAIL'} ${r.name}: ${r.command} (${r.skipped ? r.output : `${(r.ms / 1000).toFixed(1)}s${r.note ? `; ${r.note}` : ''}`})`);
  const failures = results.filter((r) => !r.ok).map((r) => `--- ${r.name}: ${r.command}\n${failureExcerpt(r.output, 40)}${findsNoTests(r.output) ? `\n${NO_TESTS_HINT}` : ''}`);
  return [...lines, ...failures].join('\n');
}
