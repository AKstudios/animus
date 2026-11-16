// `animus run spec.md`: one job from spec to pull request (docs/factory.md,
// "The pipeline"). Scripts do what needs no judgment: the workspace, the
// gates, the evidence, the PR. One agent implements and one fresh agent
// reviews. Both loops are bounded; a job that runs out of rounds stops as
// failed with its reason and a draft PR. Office mode will run this same
// function behind a queue.
import { spawnSync } from 'node:child_process';
import { randomBytes } from 'node:crypto';
import { copyFileSync, existsSync, mkdirSync, readFileSync, writeFileSync } from 'node:fs';
import { userInfo } from 'node:os';
import { basename, join, resolve } from 'node:path';
import { resolveAfter, waitForMerged } from './after.ts';
import type { Agent, AgentResult } from './agent.ts';
import { describe, failsOnBase, jobChecks, LATER_SLICE, runChecks, type CheckResult } from './gates.ts';
import { commitAll, mainCheckout, matchesAny, touchedFiles } from './git.ts';
import { appendRun, jobDir, saveState, writeJson, type JobState, type Outcome, type Run } from './log.ts';
import { evidenceBranch, prBody, prState, type Evidence, type PrLookup, type Publish } from './pr.ts';
import { loadProfile } from './profile.ts';
import { describePlan, escalate, modelFor, PLUGIN_ROOT, raise, readPrompt, resolvePlan, type Factory, type Tier } from './profiles.ts';
import { animusCommand, git, AnimusError, tryGit } from './proc.ts';
import { asReport, asReview, blockers, criteriaList, listFindings, REPORT_SCHEMA, REVIEW_SCHEMA, type Finding, type Report, type Review } from './review.ts';
import { roleSkills } from './skills.ts';
import { criteriaSoFar, oneSlice, planSlices, type Slicing } from './slices.ts';
import { loadSpec, type Spec } from './spec.ts';
import { describeShots, designOf, takeShots, uiProblem, uiTarget, type UiJob } from './ui.ts';
import { createWorkspace, ensureSetup, removeWorkspace, reopenWorkspace, type Workspace } from './workspace.ts';

export type Deps = {
  factory: Factory;
  agent: Agent;
  publish: Publish;
  log: (line: string) => void;
  /** Pushes a job's screenshots where its pull request can show them; left out, the PR lists their paths. */
  evidence?: Evidence;
  /** Takes a UI job's screenshots; replaced in tests. */
  shots?: typeof takeShots;
  /** How a spec with `after:` learns the earlier pull request merged, and how it waits between looks; replaced in tests. */
  prState?: PrLookup;
  sleep?: (ms: number) => Promise<void>;
};

export type RunOptions = {
  repo: string;
  /** The spec file; not needed when resuming. */
  specFile?: string;
  /** Stop before the push: the PR body is written to the job's folder. */
  dryRun?: boolean;
  /** Open the pull request as a draft even when the job succeeds. */
  draft?: boolean;
  /** Leave the worktree in place when the job ends. */
  keep?: boolean;
  trigger?: string;
  /** Pick a job up again, with the person's answer if it asked a question. */
  resume?: { state: JobState; answer?: string };
};

/** Ends the job where it is thrown, with an outcome that is not a pull request. */
class Stop extends Error {
  outcome: 'needs-input' | 'failed';
  constructor(outcome: 'needs-input' | 'failed', reason: string) {
    super(reason);
    this.outcome = outcome;
  }
}

const REVIEW_TIMEOUT_MS = 30 * 60 * 1000;
const MARKER = 'animus-job.json';

const slug = (s: string) => s.toLowerCase().replace(/[^a-z0-9]+/g, '-').replace(/^-|-$/g, '').slice(0, 32).replace(/-$/, '') || 'job';
export const newJobId = (title: string) => `${slug(title)}-${randomBytes(2).toString('hex')}`;

export { readPrompt };

/** The job a worktree belongs to, for `animus check` and `animus shots` run inside it. */
export function jobOf(cwd: string): string | undefined {
  const dir = tryGit(cwd, ['rev-parse', '--absolute-git-dir']);
  if (!dir || !existsSync(join(dir, MARKER))) return undefined;
  return (JSON.parse(readFileSync(join(dir, MARKER), 'utf8')) as { job: string }).job;
}

export function factoryVersion(): string {
  const head = tryGit(PLUGIN_ROOT, ['rev-parse', '--short', 'HEAD']);
  if (!head) return 'unknown';
  return tryGit(PLUGIN_ROOT, ['status', '--porcelain']) ? `${head}-dirty` : head;
}

/** Puts the worktree back to its last commit: what the gates or a reviewer changed is not the job's work. */
function restore(worktree: string): void {
  tryGit(worktree, ['checkout', '--quiet', '--', '.']);
  tryGit(worktree, ['clean', '-fdq']);
}

export const uiJobOf = (job: string, spec: Spec): UiJob => ({ id: job, pages: spec.ui.pages, designs: spec.design, ...(spec.ui.target ? { target: spec.ui.target } : {}) });

export async function runJob(opts: RunOptions, deps: Deps): Promise<Run> {
  const { factory, log } = deps;
  const startedAt = Date.now();
  const repo = mainCheckout(opts.repo);
  const prior = opts.resume?.state;
  if (!prior && !opts.specFile) throw new AnimusError('animus run needs a spec file');
  const spec = loadSpec(prior ? prior.spec : opts.specFile!);
  let plan = prior?.plan ?? resolvePlan(factory, spec);
  const repoProfile = loadProfile(repo);
  const job = prior?.job ?? newJobId(spec.title);
  const ui = plan.type === 'ui' ? uiJobOf(job, spec) : undefined;
  if (ui) {
    const problem = uiProblem(repoProfile, ui);
    if (problem) throw new AnimusError(problem);
  }

  const dir = jobDir(job);
  mkdirSync(dir, { recursive: true });
  const specCopy = join(dir, 'spec.md');
  if (!prior) copyFileSync(opts.specFile!, specCopy);

  const run: Run = {
    job, repo, submitter: process.env.ANIMUS_USER ?? tryGit(repo, ['config', 'user.email']) ?? userInfo().username,
    trigger: opts.trigger ?? (prior ? 'resume' : 'cli'), title: spec.title,
    size: plan.size, difficulty: plan.difficulty, type: plan.type, labels_defaulted: spec.defaulted, escalations: [],
    provider: factory.provider, factory_version: factoryVersion(), skills: [],
    started: new Date(startedAt).toISOString(), ended: '',
    ms: { queue: 0, setup: 0, plan: 0, implement: 0, gates: 0, review: 0, evidence: 0, pr: 0, total: 0 },
    agents: [], cost_usd: 0, turns: 0, tokens: { input: 0, output: 0, cache_read: 0, cache_write: 0 },
    gates: [], fix_rounds: 0, review: null, outcome: 'failed', branch: '', base: '', protected_touched: [], dir,
  };
  const timed = async <T>(stage: keyof Run['ms'], fn: () => T | Promise<T>): Promise<T> => {
    const t = Date.now();
    try { return await fn(); } finally { run.ms[stage] += Date.now() - t; }
  };

  const source = prior ? prior.source : resolve(opts.specFile!);
  if (source) run.spec_file = source;

  log(`job ${job}: ${spec.title}`);
  log(describePlan(factory, plan));
  // A spec that builds on another waits for it, then starts from a base that holds it.
  if (!prior && spec.after.length) {
    const files = resolveAfter(repo, source!, spec.after);
    await timed('queue', () => waitForMerged({ repo, files, lookup: deps.prState ?? prState, log, ...(deps.sleep ? { sleep: deps.sleep } : {}) }));
  }
  if (spec.defaulted.length) log(`the spec's header has no ${spec.defaulted.join(', ')}: the default ran`);

  // ---------------------------------------------------------------- setup
  let ws: Workspace;
  try {
    ws = await timed('setup', () => {
      const w = prior ? reopenWorkspace(repo, prior.workspace) : createWorkspace(repo, repoProfile, job, spec.base ?? repoProfile.base, log);
      writeFileSync(join(git(w.worktree, ['rev-parse', '--absolute-git-dir']), MARKER), JSON.stringify({ job }));
      return w;
    });
  } catch (err) {
    if (!(err instanceof AnimusError)) throw err;
    throw new AnimusError(`job ${job} could not start: ${err.message}`);
  }
  const wt = ws.worktree;
  run.branch = ws.branch;
  run.base = ws.base;
  const answers = [...(prior?.answers ?? []), ...(prior?.question && opts.resume?.answer ? [{ question: prior.question, answer: opts.resume.answer }] : [])];
  const state: JobState = { job, repo, spec: specCopy, ...(source ? { source } : {}), workspace: ws, plan, ...(prior?.session ? { session: prior.session } : {}), ...(prior?.context !== undefined ? { context: prior.context } : {}), ...(answers.length ? { answers } : {}), ...(prior?.slicing ? { slicing: prior.slicing, sliced_by: prior.sliced_by ?? 'script', slices_done: prior.slices_done ?? [] } : {}) };
  saveState(state);

  let summary = '';
  let notes: string | undefined;
  /** What a session new to the job is told first: where it is, the gates, the spec. */
  let brief = '';
  let lastGates: CheckResult[] = [];
  let review: Review | undefined;
  let reviewRounds = 0;
  let open: Finding[] = [];
  let shots: { dir: string; files: string[]; urls?: Record<string, string>; branch?: string } | undefined;
  const found = new Map<string, Finding>();
  let actedOn = 0;
  /** Gate fix rounds spent inside slices: each slice has its own allowance, and so has the finished branch. */
  let sliceRounds = 0;
  let planFallback: string | undefined;

  const record = (stage: string, role: string, tier: Tier, effort: string, r: AgentResult) => {
    run.agents.push({
      stage, role, tier, effort, model: r.model, ok: r.ok, status: r.status, cost_usd: r.cost_usd, turns: r.turns, tokens: r.tokens, ms: r.ms,
      ...(r.session ? { session: r.session } : {}), ...(r.transcript ? { transcript: r.transcript } : {}), ...(r.context !== undefined ? { context: r.context } : {}),
    });
    if (r.context !== undefined) log(`  ${stage}: ${k(r.context)} tokens of context at the end${budget ? `, budget ${k(budget)}` : ''}`);
    run.cost_usd = Math.round((run.cost_usd + r.cost_usd) * 10_000) / 10_000;
    run.turns += r.turns;
    for (const k of ['input', 'output', 'cache_read', 'cache_write'] as const) run.tokens[k] += r.tokens[k];
    if (r.transcript && existsSync(r.transcript)) {
      mkdirSync(join(dir, 'transcripts'), { recursive: true });
      copyFileSync(r.transcript, join(dir, 'transcripts', `${stage}.jsonl`));
    }
  };

  /** A role's standing instructions with the skills it is granted, and the folders those skills' files are in. */
  const instructions = (role: string) => {
    const s = roleSkills(factory, role, plan.type, wt);
    for (const name of s.names) if (!run.skills.includes(name)) run.skills.push(name);
    return { system: [readPrompt(role), s.system].filter(Boolean).join('\n\n'), ...(s.dirs.length ? { addDirs: s.dirs } : {}) };
  };

  const budget = factory.limits.context_budget;
  const k = (tokens: number) => `${Math.round(tokens / 1000)}k`;
  /** What every session is held to while it runs: where its context is compacted, and what it may spend. */
  const caps = (tier: Tier) => ({ ...(factory.limits.context_cap ? { compactAt: factory.limits.context_cap } : {}), ...(factory.limits.session_usd?.[tier] ? { maxUsd: factory.limits.session_usd[tier]! } : {}) });

  /**
   * One turn of the implementer. A turn that opens the job or a slice starts
   * a session with what it is asked. Any other resumes the session before it,
   * unless that ended over the context budget or there is none (the slice
   * that made it is closed). Then a fresh session is started with the brief
   * and what was done, so a long job is a chain of short sessions and not
   * one that only grows.
   */
  const implementer = async (stage: string, asked: string, tier: Tier, opens = false): Promise<Report> => {
    const effort = plan.implement.effort;
    let prompt = asked;
    if (!opens) {
      const over = Boolean(state.session && budget && (state.context ?? 0) > budget);
      if (over) {
        log(`the implementer's session ended at ${k(state.context!)} tokens of context, over the ${k(budget!)} budget: ${stage} starts a fresh session`);
        delete state.session;
        run.handoffs = (run.handoffs ?? 0) + 1;
      }
      if (!state.session) prompt = handoffPrompt({ brief, base: ws.base, summary, notes, asked, over });
    }
    log(`${stage}: ${modelFor(factory, tier)}, ${effort} effort`);
    const r = await timed('implement', () => deps.agent({ role: 'implementer', tier, effort, prompt, cwd: wt, ...instructions('implementer'), schema: REPORT_SCHEMA, ...caps(tier), ...(state.session ? { resume: state.session } : {}) }));
    record(stage, 'implementer', tier, effort, r);
    if (r.session) state.session = r.session;
    if (r.context !== undefined) state.context = r.context; else delete state.context;
    saveState(state);
    // The implementer commits at each working step; whatever it left is kept too, so a retry starts from it.
    commitAll(wt, `${spec.title}: work left uncommitted at the end of ${stage}`);
    if (!r.ok) throw new Stop('failed', `the implementer's session ended with ${r.status}${r.text ? `: ${r.text.slice(0, 300)}` : ''}`);
    const report = asReport(r.output) ?? { status: 'done', summary: r.text.trim().split('\n')[0] ?? '' };
    if (report.escalate?.why) {
      const e = escalate(factory, plan, report.escalate);
      run.escalations.push({ ...e.applied, why: report.escalate.why });
      if (e.plan !== plan) {
        plan = state.plan = e.plan;
        Object.assign(run, { size: plan.size, difficulty: plan.difficulty });
        log(`the implementer raised the job to ${plan.size}, ${plan.difficulty}: ${report.escalate.why}`);
      }
    }
    if (report.status === 'needs-input') throw new Stop('needs-input', report.question ?? report.summary);
    if (report.status === 'failed') throw new Stop('failed', `the implementer gave up: ${report.summary}`);
    if (report.summary) summary = report.summary;
    if (report.notes) notes = report.notes;
    return report;
  };

  /**
   * Runs the gates until they pass, sending failures back to the implementer
   * while rounds are left. For a slice, only the criteria of the slices so
   * far are checked, and the rounds are that slice's own.
   */
  const gate = async (slice?: { name: string; only: ReadonlySet<number> }): Promise<void> => {
    const of = slice ? ` for ${slice.name}` : '';
    let rounds = 0;
    for (;;) {
      const head = git(wt, ['rev-parse', 'HEAD']);
      if (head === ws.base) throw new Stop('failed', 'the implementer changed nothing');
      const attempt = run.gates.length + 1;
      const checks = jobChecks(repoProfile, plan, spec, { base: ws.base, files: touchedFiles(wt, ws.base, head) }, slice?.only);
      log(`gates${of}, run ${attempt}: ${checks.filter((c) => !c.skip).map((c) => c.name).join(', ') || 'nothing to run'}`);
      const t = Date.now();
      lastGates = await timed('gates', () => {
        const results = runChecks(wt, checks, job);
        // The proof that the tests fail without the change is for the whole job: it runs on the finished branch.
        if (!plan.prove || slice) return results;
        return [...results, failsOnBase({ repo, profile: repoProfile, spec, base: ws.base, head, files: touchedFiles(wt, ws.base, head), job, green: results.every((r) => r.ok) })];
      });
      restore(wt);
      const ok = lastGates.every((r) => r.ok);
      run.gates.push({ attempt, ok, ms: Date.now() - t, checks: lastGates.map((r) => ({ name: r.name, ok: r.ok, skipped: r.skipped, ms: r.ms })) });
      mkdirSync(join(dir, 'gates'), { recursive: true });
      writeFileSync(join(dir, 'gates', `run-${attempt}.txt`), `${describe(lastGates)}\n\n${lastGates.filter((r) => !r.skipped).map((r) => `=== ${r.name}: ${r.command}\n${r.output}`).join('\n')}`);
      for (const line of describe(lastGates).split('\n').slice(0, lastGates.length)) log(`  ${line}`);
      if (ok) return;
      const used = slice ? rounds : run.fix_rounds - sliceRounds;
      if (used >= factory.limits.gate_rounds) throw new Stop('failed', `the gates${of} still fail after ${used} fix round(s):\n${describe(lastGates.filter((r) => !r.ok))}`);
      run.fix_rounds++;
      if (slice) { rounds++; sliceRounds++; }
      // A failed gate round raises the model tier by one for the next.
      await implementer(`gate-fix-${run.fix_rounds}`, gateFixPrompt(describe(lastGates), factory.limits.gate_rounds - used - 1), raise(plan.implement.tier));
    }
  };

  const shoot = async (of: UiJob = ui!): Promise<string> => {
    const r = await timed('evidence', () => (deps.shots ?? takeShots)(wt, of, repoProfile, join(dir, 'shots')));
    shots = { dir: r.dir, files: r.shots.build };
    log(`${r.reused ? 'screenshots unchanged' : `${r.shots.build.length} screenshot(s) taken`}: ${r.dir}`);
    return describeShots(r.dir, r.shots, r.reused);
  };

  let outcome: Outcome = 'failed';
  let reason: string | undefined;
  try {
    await timed('setup', () => ensureSetup(wt, repoProfile, log));

    // ------------------------------------------------------------ implement
    const profile = repoProfile;
    const about = { job, spec, ws, repo, notes: profile.notes, ui: ui ? uiBrief(wt, profile, ui) : undefined };
    const whole = implementPrompt({ ...about, gates: jobChecks(profile, plan, spec, { base: ws.base, files: [] }).map((c) => c.command), prove: plan.prove ? profile.tests : undefined });

    // ----------------------------------------------------------------- plan
    // How the spec is cut is decided once. A job picked up again keeps its cut.
    if (!state.slicing) {
      state.slicing = prior ? oneSlice(spec) : await timed('plan', () => {
        try {
          const planned = planSlices({ factory, agent: deps.agent, spec, cwd: wt, log, record: (stage, r) => record(stage, 'planner', factory.planner!.tier, factory.planner!.effort, r) });
          state.sliced_by = planned.by;
          if (planned.by === 'planner') for (const name of roleSkills(factory, 'planner', plan.type, wt).names) if (!run.skills.includes(name)) run.skills.push(name);
          return planned.slicing;
        } catch (err) {
          if (!(err instanceof AnimusError)) throw err;
          // The work a planner could not cut is done the way it was before there was a planner.
          planFallback = err.message;
          log(`no plan was taken, so the job runs as one slice: ${err.message.split('\n')[0]}`);
          return oneSlice(spec);
        } finally {
          restore(wt);
        }
      });
      state.sliced_by ??= 'script';
      state.slices_done = [];
      saveState(state);
    }
    const { slices } = state.slicing;
    const done = (state.slices_done ??= []);
    const resumed = done.length;

    // ------------------------------------------------------------ implement
    if (slices.length === 1) {
      brief = whole;
      await implementer(prior ? 'resume' : 'implement', prior ? resumePrompt(prior, opts.resume?.answer) : brief, plan.implement.tier, !prior);
    } else {
      if (!prior) log(`${slices.length} slices: ${slices.map((s) => s.title).join('; ')}`);
      for (let i = resumed; i < slices.length; i++) {
        const name = `slice ${i + 1} of ${slices.length}`;
        const only = criteriaSoFar(state.slicing, i)!;
        log(`${name}: ${slices[i]!.title}`);
        brief = slicePrompt({ ...about, slicing: state.slicing, index: i, done, gates: jobChecks(profile, plan, spec, { base: ws.base, files: [] }, only).filter((c) => c.skip !== LATER_SLICE).map((c) => c.command) });
        if (prior && i === resumed && state.session) {
          // The job stopped inside this slice: its session carries on.
          await implementer(`slice-${i + 1}-resume`, resumePrompt(prior, opts.resume?.answer), plan.implement.tier);
        } else {
          delete state.session;
          delete state.context;
          summary = '';
          notes = undefined;
          await implementer(`slice-${i + 1}`, brief, plan.implement.tier, true);
        }
        // The last slice is gated with the finished branch, below, and its session takes what comes back.
        if (i < slices.length - 1) {
          await gate({ name, only });
          delete state.session;
          delete state.context;
        }
        done.push(summary || slices[i]!.title);
        saveState(state);
      }
      brief = whole;
      if (prior && resumed >= slices.length) await implementer('resume', resumePrompt(prior, opts.resume?.answer), plan.implement.tier);
    }

    // ---------------------------------------------------------------- gates
    await gate();

    // --------------------------------------------------------------- review
    if (plan.review) {
      const { role, tier, effort } = plan.review;
      for (let round = 1; ; round++) {
        const seen = ui ? await shoot() : undefined;
        log(`review ${round}: ${role}, ${modelFor(factory, tier)}, ${effort} effort`);
        const prompt = reviewPrompt({ spec, ws, round, earlier: open, shots: seen, answers });
        let said: Review | undefined;
        for (let tries = 0; tries < 2 && !said; tries++) {
          const r = await timed('review', () => deps.agent({ role, tier, effort, prompt, cwd: wt, ...instructions(role), schema: REVIEW_SCHEMA, readOnly: true, timeoutMs: REVIEW_TIMEOUT_MS, ...caps(tier) }));
          record(`review-${round}${tries ? '-retry' : ''}`, role, tier, effort, r);
          restore(wt);
          said = asReview(r.output);
        }
        if (!said) throw new Stop('failed', 'the reviewer gave no review in two tries');
        review = said;
        reviewRounds = round;
        writeJson(join(dir, `review-${round}.json`), said);
        for (const f of said.findings) found.set(`${f.file ?? ''}:${f.problem}`, f);
        if (said.status === 'not-ready') throw new Stop('failed', `the reviewer says the work is not ready: ${said.summary}`);
        open = blockers(said.findings);
        log(`review ${round}: ${said.findings.length} finding(s), ${open.length} to fix`);
        if (!open.length) break;
        if (round > factory.limits.review_rounds) throw new Stop('failed', `the review still found ${open.length} blocker(s) after its fix round`);
        actedOn += open.length;
        await implementer(`review-fix-${round}`, reviewFixPrompt(open), plan.implement.tier);
        await gate();
      }
    } else log('review: skipped for this profile');

    // ------------------------------------------------------------- evidence
    if (ui) await shoot();
    else {
      // Not a ui job, but it changed files a ui target is built from: show the app anyway.
      const files = touchedFiles(wt, ws.base, git(wt, ['rev-parse', 'HEAD']));
      const target = repoProfile.ui.targets.find((t) => t.paths.length && files.some((f) => matchesAny(f, t.paths)));
      if (target) {
        try {
          await shoot({ id: job, target: target.name, pages: [], designs: [] });
        } catch (err) {
          if (!(err instanceof AnimusError)) throw err;
          log(`no screenshots: ${err.message.split('\n')[0]}`);
        }
      }
    }
    outcome = opts.dryRun ? 'dry-run' : 'pr';
  } catch (err) {
    if (!(err instanceof Stop) && !(err instanceof AnimusError)) throw err;
    outcome = err instanceof Stop ? err.outcome : 'failed';
    reason = err.message;
    log(`${outcome === 'needs-input' ? 'needs input' : 'failed'}: ${reason.split('\n')[0]}`);
  }

  // ------------------------------------------------------------------- PR
  const head = git(wt, ['rev-parse', 'HEAD']);
  run.head = head;
  run.protected_touched = touchedFiles(wt, ws.base, head).filter((f) => matchesAny(f, repoProfile.protected));
  const all = [...found.values()];
  if (reviewRounds) run.review = { rounds: reviewRounds, findings: all.length, blockers: all.filter((f) => f.severity === 'blocker').length, acted_on: actedOn, open: outcome === 'failed' ? open.length : 0 };
  const failed = outcome === 'failed';
  const cut = state.slicing?.slices ?? [];
  if (cut.length) run.slices = { by: state.sliced_by ?? 'script', planned: cut.length, done: cut.length > 1 ? state.slices_done?.length ?? 0 : failed || outcome === 'needs-input' ? 0 : 1, ...(planFallback ? { fallback: planFallback } : {}) };
  const sliced = cut.length > 1 ? cut.map((s, i) => ({ title: s.title, ...(state.slices_done?.[i] ? { summary: state.slices_done[i]! } : {}) })) : undefined;
  if (outcome !== 'needs-input' && head !== ws.base) {
    const models = [...new Set(run.agents.map((a) => `${a.role} ${a.model} (${a.effort})`))].join(', ');
    if (shots && !opts.dryRun && deps.evidence) {
      try {
        const s = shots;
        s.urls = await timed('pr', () => deps.evidence!({ cwd: wt, job, dir: s.dir, files: s.files }));
        s.branch = evidenceBranch(job);
      } catch (err) {
        if (!(err instanceof AnimusError)) throw err;
        log(`the screenshots could not be pushed: ${err.message.split('\n')[0]}`);
      }
    }
    const body = prBody({
      job, spec, plan, summary, ...(sliced ? { slices: sliced } : {}), gates: lastGates, gateAttempts: run.gates.length, fixRounds: run.fix_rounds, reviewRounds, open: failed ? open : [],
      protectedTouched: run.protected_touched, escalations: run.escalations, models, cost_usd: run.cost_usd,
      ...(notes ? { notes } : {}), ...(review ? { review } : {}), ...(shots ? { shots } : {}), ...(failed && reason ? { failure: reason } : {}),
    });
    writeFileSync(join(dir, 'pr-body.md'), `${body}\n`);
    if (!opts.dryRun) {
      try {
        run.pr = await timed('pr', () => deps.publish({ cwd: wt, branch: ws.branch, baseBranch: ws.baseBranch, title: spec.title, body, draft: failed || Boolean(opts.draft) }));
        if (failed) outcome = 'draft-pr';
        log(`${failed ? 'draft pull request with the failure report' : 'pull request'}: ${run.pr}`);
      } catch (err) {
        if (!(err instanceof AnimusError)) throw err;
        outcome = 'failed';
        reason = `${reason ? `${reason}\n` : ''}the pull request could not be opened: ${err.message}`;
        log(reason.split('\n').pop()!);
      }
    } else log(`dry run: the pull request's body is in ${join(dir, 'pr-body.md')}; the work is on ${ws.branch}`);
  }

  // -------------------------------------------------------------- the log
  run.outcome = outcome;
  if (reason) run[outcome === 'needs-input' ? 'question' : 'reason'] = reason;
  Object.assign(state, { outcome, ...(outcome === 'needs-input' ? { question: reason } : {}), ...(open.length ? { findings: open } : {}) });
  saveState(state);
  if (!opts.keep && outcome !== 'needs-input') removeWorkspace(repo, wt);
  run.ended = new Date().toISOString();
  run.ms.total = Date.now() - startedAt;
  appendRun(run);
  if (outcome === 'needs-input') log(`answer with: ${animusCommand()} resume ${job} --answer "<your answer>"`);
  return run;
}

// ---------------------------------------------------------------- prompts

function uiBrief(worktree: string, profile: ReturnType<typeof loadProfile>, ui: UiJob): string {
  const target = uiTarget(profile, ui)!;
  const design = designOf(worktree, profile, ui);
  const pages = target.pages.filter((p) => !ui.pages.length || ui.pages.includes(p.name)).map((p) => p.name);
  return [
    `This is a UI job on the ${target.name} target (pages: ${pages.join(', ')}).`,
    design.files.length ? `The design to match: ${design.files.join(', ')}. Read each file.` : 'No design reference was given: make it fit the rest of the app.',
    `Before you finish, run \`${animusCommand()} shots\` (foreground, Bash timeout 600000): it serves the app, screenshots those pages at each size and prints the files. Read each one and fix what looks wrong. Animus takes the same screenshots as evidence after you finish.`,
  ].join('\n');
}

function implementPrompt(p: { job: string; spec: Spec; ws: Workspace; repo: string; notes?: string | undefined; gates: string[]; ui?: string | undefined; prove?: readonly string[] | undefined }): string {
  return [
    `Job ${p.job}. You are in a fresh worktree of ${basename(p.repo)} on the branch ${p.ws.branch}, started from ${p.ws.baseBranch}. Its dependencies are installed.`,
    `The job's profile is ${p.spec.size}, ${p.spec.difficulty}, ${p.spec.type}.`,
    p.notes ? `This project's notes for unattended work:\n${p.notes.trim()}` : '',
    p.ui ?? '',
    p.prove ? `This job must prove its test. Write the test that reproduces the problem first and see it fail. Once the gates below pass, Animus runs the spec's acceptance commands on the commit you started from with only your test files laid over it (files matching ${p.prove.join(', ')}), and at least one must fail there. \`${animusCommand()} check\` runs that too.` : '',
    `When you finish, Animus runs these gates, and sends failures back to you. Run them yourself first with \`${animusCommand()} check\` (foreground, Bash timeout 600000):\n${p.gates.map((g) => `  $ ${g}`).join('\n') || '  (the project names no check commands)'}`,
    `The spec follows. Its acceptance criteria are what the reviewer checks your change and its tests against.\n\n${p.spec.text.trim()}`,
  ].filter(Boolean).join('\n\n');
}

/** What a slice's session is told: the job, its slice and the criteria it finishes, what is done and what is left to others, the planner's brief, then the spec. */
function slicePrompt(p: { job: string; spec: Spec; ws: Workspace; repo: string; notes?: string | undefined; gates: string[]; ui?: string | undefined; slicing: Slicing; index: number; done: readonly string[] }): string {
  const { slices, brief } = p.slicing;
  const mine = slices[p.index]!;
  const later = slices.slice(p.index + 1);
  const criterion = (n: number) => { const c = p.spec.criteria[n - 1]!; return `${n}. ${c.text}${c.commands.map((cmd) => `\n   $ ${cmd}`).join('')}`; };
  return [
    `Job ${p.job}. You are in a worktree of ${basename(p.repo)} on the branch ${p.ws.branch}, started from ${p.ws.baseBranch}. Its dependencies are installed.`,
    `The job's profile is ${p.spec.size}, ${p.spec.difficulty}, ${p.spec.type}.`,
    `This job is done in ${slices.length} slices, in order, on this one branch, each by a fresh session. You do slice ${p.index + 1}, and only that one.`,
    `Your slice: ${mine.title}\nWhen it is done: ${mine.delivers}${mine.prefactor ? '\nIt changes no behaviour: it makes the code ready for the slices after it, and the existing tests must still pass.' : ''}`,
    mine.criteria.length ? `The acceptance criteria your slice finishes, with their numbers in the spec:\n${mine.criteria.map(criterion).join('\n')}` : '',
    p.index ? `Done by the sessions before you. Read their work before you change anything (\`git log --oneline ${p.ws.base}..HEAD\`, \`git diff ${p.ws.base}...HEAD\`) and build on it:\n${slices.slice(0, p.index).map((s, i) => `${i + 1}. ${s.title}${p.done[i] ? `: ${p.done[i]}` : ''}`).join('\n')}` : '',
    later.length ? `Left to the sessions after you. Do not build these or write their tests:\n${later.map((s, i) => `${p.index + 2 + i}. ${s.title}${s.criteria.length ? ` (criteria ${s.criteria.join(', ')})` : ''}`).join('\n')}` : '',
    brief ? `What the planner worked out for every slice, from reading the spec and the code:\n${brief}` : '',
    p.notes ? `This project's notes for unattended work:\n${p.notes.trim()}` : '',
    p.ui ?? '',
    `When you finish, Animus runs these gates, and sends failures back to you. They cover the slices so far and not the later ones. Run them yourself first with \`${animusCommand()} check\` (foreground, Bash timeout 600000):\n${p.gates.map((g) => `  $ ${g}`).join('\n') || '  (the project names no check commands)'}`,
    `The whole spec follows, for its decisions and what is out of scope. The criteria not listed above belong to other slices.\n\n${p.spec.text.trim()}`,
  ].filter(Boolean).join('\n\n');
}

/** For a session that starts in the middle of a job: the brief a first session gets, what the sessions before it left, then what is asked now. */
function handoffPrompt(p: { brief: string; base: string; summary: string; notes?: string | undefined; asked: string; over?: boolean }): string {
  return [
    p.brief,
    `This job is already under way. Earlier sessions did the work that is on this branch${p.over ? ', and the last one was ended because its context had grown long' : ''}. You are a fresh session picking the job up, so read what is there before you change anything: \`git log --oneline ${p.base}..HEAD\` and \`git diff ${p.base}...HEAD\`.`,
    p.summary ? `The last session's summary: ${p.summary}` : '',
    p.notes ? `Its notes: ${p.notes}` : '',
    `What is asked of you now:\n\n${p.asked}`,
  ].filter(Boolean).join('\n\n');
}

function gateFixPrompt(failures: string, roundsLeft: number): string {
  return `Animus ran the gates on your last commit and they failed. Fix the cause, not the check, commit, and finish again. ${roundsLeft ? `The gates can send the work back ${roundsLeft} more time(s).` : 'This is the last fix round: if the gates fail again the job stops as failed.'}\n\n${failures}`;
}

function reviewFixPrompt(findings: readonly Finding[]): string {
  return `A reviewer that did not write this code read your change against the spec. Fix each of these, commit, run \`${animusCommand()} check\`, and finish again. This is the review's only fix round. If a finding is wrong, say why in your notes instead of changing code for it.\n\n${listFindings(findings)}`;
}

function resumePrompt(prior: JobState, answer?: string): string {
  if (prior.question) return `You stopped this job to ask: ${prior.question}\n\n${answer ? `The person's answer: ${answer}` : 'The person gave no answer; decide as well as you can and say what you assumed in your notes.'}\n\nCarry on from where you stopped, and finish as before.`;
  return `This job was interrupted and is being picked up again. Your earlier commits are on the branch. ${answer ? `From the person: ${answer}\n\n` : ''}Check what is done against the spec, finish the rest, and finish as before.`;
}

function reviewPrompt(p: { spec: Spec; ws: Workspace; round: number; earlier: readonly Finding[]; shots?: string | undefined; answers?: readonly { question: string; answer: string }[] }): string {
  return [
    `You are in the worktree of the finished change. Read the diff with: git diff ${p.ws.base}...HEAD`,
    p.round > 1 ? `This is review ${p.round}, after a fix round. The earlier blockers were:\n${listFindings(p.earlier)}` : '',
    p.shots ?? '',
    `The acceptance criteria, numbered as your answer must number them:\n${criteriaList(p.spec)}`,
    `The spec:\n\n${p.spec.text.trim()}`,
    p.answers?.length ? `While it ran, the job stopped to ask the person who submitted it, and they answered. Their answers decide what the spec left open; judge the work against them as you do the spec:\n${p.answers.map((a) => `- Asked: ${a.question}\n  Answered: ${a.answer}`).join('\n')}` : '',
  ].filter(Boolean).join('\n\n');
}

/** Whether a command is on PATH: `animus doctor`-style checks before a run. */
export function onPath(command: string): boolean {
  return spawnSync('/bin/sh', ['-c', `command -v ${command}`], { stdio: 'ignore' }).status === 0;
}
