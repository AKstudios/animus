// Admit (docs/adr/0007): decides whether a spec can run on a project, against
// the factory and the project's profile, and lists every problem at once, each
// marked as fixed in the spec or in the profile. A script that only reads: no
// model, no serve command, no acceptance command. A job calls it before any
// work, so a job never fails at start for a reason admit did not name.
import { readFileSync } from 'node:fs';
import { basename } from 'node:path';
import { checksFor, loadProfile, parseProfile, PROFILE_PATH, type Profile, type UiPage, type UiTarget } from './profile.ts';
import { resolvePlan, type Factory, type Plan } from './profiles.ts';
import { AnimusError, tryGit } from './proc.ts';
import { parseSpec, type Spec } from './spec.ts';
import { isLiteralPage, pagesOf, uiTarget } from './ui.ts';
import { baseCommit } from './workspace.ts';

/**
 * What admit knows of the project: its profile, where that was read from
 * ("your checkout", or a branch as GitHub has it), and whether a branch, or a
 * path on a branch, exists.
 */
export type Facts = {
  profile: Profile;
  read: string;
  hasBranch: (branch: string) => boolean;
  hasPath: (branch: string, path: string) => boolean;
  /** Why a secret of the profile would not reach a job where it runs, or undefined when it would. */
  missingSecret?: (name: string) => string | undefined;
};

/** A profile problem carries the YAML to add to the profile and where the profile was read from. */
export type Problem = { who: 'spec' | 'profile'; what: string; add?: string; from?: string };

export type Admitted = {
  spec: Spec;
  /** Absent when the spec's labels would not run. */
  plan?: Plan;
  /** A UI spec's target and the pages it shows, when they could be settled. */
  ui?: { target: UiTarget; pages: UiPage[] };
  /** The profile's checks for the job's type, as `name: command`. */
  gates: string[];
  base: string;
  problems: Problem[];
  warnings: string[];
};

const squash = (command: string) => command.trim().replace(/\s+/g, ' ');

const yaml = (lines: string[]) => lines.join('\n');

export function admit(factory: Factory, text: string, facts: Facts, name = 'spec.md'): Admitted {
  const { profile } = facts;
  const problems: Problem[] = [];
  const specProblem = (what: string) => problems.push({ who: 'spec', what });
  const profileProblem = (what: string, add?: string) => problems.push({ who: 'profile', what, ...(add ? { add } : {}), from: facts.read });

  const found: string[] = [];
  const spec = parseSpec(text, name, found);
  found.forEach(specProblem);

  let plan: Plan | undefined;
  try { plan = resolvePlan(factory, spec); } catch (err) {
    if (!(err instanceof AnimusError)) throw err;
    specProblem(err.message);
  }
  const proves = Boolean(factory.types[spec.type]?.prove);
  if (!proves && !spec.criteria.some((c) => c.commands.length)) {
    specProblem('no acceptance criterion has a `$ command` line, so nothing is run to check the work: put one under at least one criterion');
  }

  const base = spec.base ?? profile.base;
  const baseThere = facts.hasBranch(base);
  if (!baseThere) {
    if (spec.base) specProblem(`base ${base} is not a branch of the project`);
    else profileProblem(`the profile's base branch ${base} does not exist`, `base: <a branch that exists>`);
  }

  for (const name of profile.secrets) {
    const why = facts.missingSecret?.(name);
    if (why) profileProblem(why);
  }

  const gates = checksFor(profile, spec.type).filter((n) => profile.commands[n]).map((n) => `${n}: ${profile.commands[n]!.run}`);
  let ui: Admitted['ui'];
  if (spec.type === 'ui') ui = admitUi(spec, facts, base, baseThere, specProblem, profileProblem);

  const warnings: string[] = [];
  const commands = spec.criteria.flatMap((c) => c.commands).map(squash);
  const gateCommands = new Set(checksFor(profile, spec.type).flatMap((n) => (profile.commands[n] ? [squash(profile.commands[n]!.run)] : [])));
  if (commands.length && commands.every((c) => gateCommands.has(c))) {
    warnings.push('every criterion\'s command is one of the profile\'s gates, so the gates already prove what they prove: add a command that fails until the work is done');
  } else if (commands.length > 1 && spec.criteria.length > 1 && new Set(commands).size === 1) {
    warnings.push(`every criterion runs the same command (${commands[0]}), so it cannot tell them apart: give each its own check where it can`);
  }

  return { spec, ...(plan ? { plan } : {}), ...(ui ? { ui } : {}), gates, base, problems, warnings };
}

function admitUi(spec: Spec, facts: Facts, base: string, baseThere: boolean, specProblem: (what: string) => void, profileProblem: (what: string, add?: string) => void): Admitted['ui'] {
  const { profile } = facts;
  const names = profile.ui.targets.map((t) => t.name);
  let target: UiTarget | undefined;
  if (!names.length) {
    profileProblem('a ui spec needs a ui target, and the profile has none', yaml([
      'ui:', '  targets:', '    app:', '      serve: <the command that starts the app, with $PORT>', '      url: http://127.0.0.1:$PORT', '      pages:', '        home: /',
    ]));
  } else if (spec.ui.target) {
    target = uiTarget(profile, { target: spec.ui.target });
    if (!target) specProblem(`ui.target ${spec.ui.target} is not a ui target of the profile (${names.join(', ')})`);
  } else {
    target = uiTarget(profile, {});
    if (!target) specProblem(`the profile has several ui targets (${names.join(', ')}): name one in the spec's header, ui: { target: <name> }`);
  }
  if (baseThere) {
    for (const file of spec.design.filter((f) => !facts.hasPath(base, f))) specProblem(`design file ${file} is not on ${base}: commit it there, or name another file`);
  }
  if (!target) return undefined;
  for (const page of spec.ui.pages) {
    if (isLiteralPage(page)) {
      if (page.startsWith('//')) specProblem(`page ${page} must be a path on the target, not start with //`);
      else if (target.kind === 'app') specProblem(`page ${page} is a path, and ${target.name} is an app target whose capture command takes page names`);
    } else if (!target.pages.some((p) => p.name === page)) {
      profileProblem(
        `${page} is not a page of ui target ${target.name} (${target.pages.map((p) => p.name).join(', ')}); give a path starting with / in the spec instead, or add the page to the profile`,
        yaml(['ui:', '  targets:', `    ${target.name}:`, '      pages:', `        ${page}: <its path>`]),
      );
    }
  }
  return { target, pages: pagesOf(target, { pages: spec.ui.pages }) };
}

/** What `animus plan` and a draft show of an admit: the target and pages, the gates, the problems and the warnings. */
export function describeAdmit(a: Admitted): string {
  const lines: string[] = [];
  if (a.ui) lines.push(`target     ${a.ui.target.name} (${a.ui.target.kind})`, `pages      ${a.ui.pages.map((p) => `${p.name} ${p.path}`).join(', ') || 'none'}`);
  lines.push(`base       ${a.base}`, `gates      ${a.gates[0] ?? 'none'}`, ...a.gates.slice(1).map((g) => `           ${g}`));
  if (a.problems.length) {
    lines.push('problems');
    a.problems.forEach((p, i) => {
      lines.push(`  ${i + 1}. [${p.who}] ${p.what}`);
      if (p.add) lines.push(`     add to ${PROFILE_PATH} (read from ${p.from}):`, ...p.add.split('\n').map((l) => `       ${l}`));
    });
  }
  if (a.warnings.length) lines.push('warnings', ...a.warnings.map((w) => `  - ${w}`));
  return lines.join('\n');
}

/** The facts of a project as its checkout has it: the profile on disk, the base as a job would start from it. */
export function checkoutFacts(repo: string, profile: Profile): Facts {
  const ref = (branch: string) => { try { return baseCommit(repo, branch); } catch { return undefined; } };
  return {
    profile, read: `the checkout, on ${tryGit(repo, ['branch', '--show-current']) || 'no branch'}`,
    hasBranch: (b) => ref(b) !== undefined,
    hasPath: (b, path) => { const c = ref(b); return c !== undefined && tryGit(repo, ['cat-file', '-e', `${c}:${path}`]) !== undefined; },
    // On one machine a job has the environment of the loop that runs it, which is this process's or its parent's.
    missingSecret: (name) => (process.env[name] ? undefined : `secret ${name} is not set in the environment jobs run with on this machine: export it in the shell you start animus from, then stop the queue's loop so the next job starts it again with it`),
  };
}

/** Admits the spec in a file against a checkout, or against `facts` when given. */
export function admitFile(factory: Factory, file: string, repo: string, profile: Profile, facts: Facts = checkoutFacts(repo, profile)): Admitted {
  return admit(factory, readFileSync(file, 'utf8'), facts, basename(file));
}

/** A refused spec as the error a job ends with. */
export function refusal(file: string, a: Admitted): AnimusError {
  return new AnimusError(`${basename(file)} is refused; it cannot run on this project:\n${describeAdmit(a)}`);
}

/** The facts of a project as one commit of a clone has them: the profile's text read from it, the base branch at the commit, other branches as the clone already has them (no network). */
export function commitFacts(repo: string, profileText: string, commit: string, read: string): Facts {
  const profile = parseProfile(profileText, `${PROFILE_PATH} on ${read}`);
  const ref = (b: string) => (b === profile.base ? commit : [`origin/${b}`, b].find((r) => tryGit(repo, ['rev-parse', '--verify', '--quiet', `${r}^{commit}`]) !== undefined));
  return {
    profile, read,
    hasBranch: (b) => ref(b) !== undefined,
    hasPath: (b, path) => { const r = ref(b); return r !== undefined && tryGit(repo, ['cat-file', '-e', `${r}:${path}`]) !== undefined; },
  };
}

/** What a draft session is told of the project, rendered from its profile: the base, the types that run, the gates, and each UI target with its pages. */
export function describeProject(factory: Factory, facts: Facts): string {
  const { profile } = facts;
  const lines = [
    `The project's profile, as read from ${facts.read}:`,
    `- base branch: ${profile.base}`,
    `- types that run: ${Object.entries(factory.types).filter(([, t]) => !t.later).map(([n]) => n).join(', ')}`,
    `- gates (run on every job): ${Object.entries(profile.commands).map(([n, c]) => `${n}: ${c.run}`).join('; ') || 'none'}`,
  ];
  if (!profile.ui.targets.length) lines.push('- ui targets: none, so a `type: ui` spec cannot run here');
  else {
    lines.push('- ui targets (a `type: ui` spec shows pages of one; with several, name it in the header as `ui: { target: <name> }`):');
    for (const t of profile.ui.targets) lines.push(`  - ${t.name} (${t.kind}); pages: ${t.pages.map((p) => `${p.name} ${p.path}`).join(', ') || 'none'}`);
    lines.push('  A page in the spec\'s `ui: { pages: [...] }` is one of those names, or a path starting with / on a web target.');
  }
  return lines.join('\n');
}

/**
 * The project's profile as `origin/<base>` has it in a clone, whatever the clone has checked out
 * (docs/adr/0008): a job on Helix reads this, not the working tree. The clone's own profile says
 * which base to look at, then the one found there is followed once more, as Helix's fetch does.
 * Nothing when the clone has no such branch or profile; the caller then reads the checkout.
 */
export function profileOnBase(repo: string): { profile: Profile; facts: Facts } | undefined {
  const at = (base: string) => {
    const commit = tryGit(repo, ['rev-parse', '--verify', '--quiet', `origin/${base}^{commit}`]);
    const text = commit ? tryGit(repo, ['show', `${commit}:${PROFILE_PATH}`]) : undefined;
    return commit && text !== undefined ? { commit, text } : undefined;
  };
  let base = 'main';
  try { base = loadProfile(repo).base; } catch { /* no readable profile in the working tree: main */ }
  let found = at(base);
  for (let tries = 0; found && tries < 2; tries++) {
    const next = parseProfile(found.text, PROFILE_PATH).base;
    if (next === base) break;
    base = next;
    found = at(base);
  }
  if (!found) return undefined;
  const facts = commitFacts(repo, found.text, found.commit, `origin/${base} on GitHub`);
  return { profile: facts.profile, facts };
}
