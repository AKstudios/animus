// `animus run spec.md`: one job from spec to pull request (docs/factory.md,
// "The pipeline"). Scripts do what needs no judgment: the workspace, the
// gates, the evidence, the PR. One agent implements and one fresh agent
// reviews. Both loops are bounded; a job that runs out of rounds stops as
// failed with its reason and a draft PR. Office mode will run this same
// function behind a queue.
import { spawnSync } from 'node:child_process';
import { randomBytes } from 'node:crypto';
import { appendFileSync, copyFileSync, existsSync, mkdirSync, readFileSync, writeFileSync } from 'node:fs';
import { userInfo } from 'node:os';
import { basename, dirname, join, resolve } from 'node:path';
import { resolveAfter, waitForMerged } from './after.ts';
import type { Agent, AgentResult } from './agent.ts';
import { describe, failsOnBase, gateReport, jobChecks, LATER_SLICE, runChecks, type CheckResult } from './gates.ts';
import { commitAll, mainCheckout, matchesAny, touchedFiles } from './git.ts';
import { appendRun, CANCELLED_MARKER, jobDir, toolsLog, saveProgress, saveState, writeJson, type Cause, type FindingLog, type JobState, type Outcome, type Run, type Stage } from './log.ts';
import { evidenceBranch, findPrByTitle, prBody, prDraft, prState, PushRejected, type DraftLookup, type PrFind, type Evidence, type PrLookup, type Publish } from './pr.ts';
import { admitFile, profileOnBase, refusal, type Admitted } from './admit.ts';
import { loadProfile } from './profile.ts';
import { describePlan, escalate, modelFor, PLUGIN_ROOT, raise, readPrompt, resolvePlan, type Factory, type Plan, type Tier } from './profiles.ts';
import { animusCommand, git, AnimusError, tryGit } from './proc.ts';
import { factoryVersion } from './version.ts';
import { handoffFixPrompt, resumeFixPrompt, reviewAsk, syncBranch, type FromPr } from './fix.ts';
import { asReport, asReview, blockers, criteriaList, listFindings, REPORT_SCHEMA, REVIEW_SCHEMA, type Finding, type Report, type Review } from './review.ts';
import { countUses, GIVEN_FILE, lessonsForPrompt, lessonsSection, type Lesson } from './lessons.ts';
import { loadJobSkills, saveJobSkills, type PersonalSkill } from './personal.ts';
import { roleSkills } from './skills.ts';
import { criteriaSoFar, isPlanned, oneSlice, planSlices, type Slicing } from './slices.ts';
import { loadSpec, parseSpec, type Spec } from './spec.ts';
import { describeShots, designOf, JOB_PID, pagesOf, takeShots, uiProblem, uiTarget, type UiJob } from './ui.ts';
import { baseCommit, createWorkspace, ensureSetup, fixWorkspace, removeWorkspace, reopenWorkspace, type Workspace } from './workspace.ts';

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
  /** Whether a pull request a fix updates is a draft; replaced in tests. */
  prDraft?: DraftLookup;
  findPr?: PrFind;
  sleep?: (ms: number) => Promise<void>;
  /** Ends the process after a signal has been logged; replaced in tests. */
  exit?: (code: number) => never;
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
  /** The line saying where the job runs (`animus start`), logged first so the watch line can follow it with the job's id. */
  runsLine?: string;
  /** The submitter's own skills (personal.ts), copied into the job's folder when it starts; a resumed job reads that copy. */
  personal?: PersonalSkill[];
  /** Pick a job up again, with the person's answer if it asked a question. */
  resume?: { state: JobState; answer?: string };
  /** Start a fix (fix.ts): a new job on the pull request's branch, in the worktree of `from`, the job it continues. */
  fix?: { of: string; from?: JobState; alone?: FromPr; ask: string; pr: string; /** A folder of what a script fetched for it (Helix: the pull request's reviews since its last push). */ references?: string; /** What the pull request's description keeps (fix.ts, keptFromBody); it wins over the earlier job's state, which may predate it. */ kept?: { closes?: number; fixes: FromPr['fixes'] } };
};

/** Ends the job where it is thrown, with an outcome that is not a pull request. */
class Stop extends Error {
  outcome: 'needs-input' | 'failed';
  cause: Cause;
  detail: { failing_checks?: string[]; blockers_left?: number };
  constructor(outcome: 'needs-input' | 'failed', reason: string, cause?: Cause, detail: Stop['detail'] = {}) {
    super(reason);
    this.outcome = outcome;
    this.cause = outcome === 'needs-input' ? 'needs-input' : cause ?? 'agent-error';
    this.detail = detail;
  }
}

/** The cause of a session that did not end well, from how the provider says it ended. */
const sessionCause = (status: string): Cause => (/max_budget/.test(status) ? 'budget' : /context|prompt is too long/i.test(status) ? 'context' : 'agent-error');

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

/** Puts the worktree back to its last commit: what the gates or a reviewer changed is not the job's work. */
function restore(worktree: string): void {
  tryGit(worktree, ['checkout', '--quiet', '--', '.']);
  tryGit(worktree, ['clean', '-fdq']);
}

function blankRun(p: { job: string; repo: string; opts: RunOptions; spec: Spec; size: string; difficulty: string; type: string; startedAt: number; dir?: string; factory?: Factory }): Run {
  const { job, repo, opts, spec } = p;
  return {
    job, repo, submitter: process.env.ANIMUS_USER ?? tryGit(repo, ['config', 'user.email']) ?? userInfo().username,
    trigger: opts.trigger ?? (opts.fix ? 'fix' : opts.resume ? 'resume' : 'cli'), ...(opts.fix ? { fix_of: opts.fix.of } : opts.resume?.state.fix_of ? { fix_of: opts.resume.state.fix_of } : {}), title: spec.title,
    size: p.size, difficulty: p.difficulty, type: p.type, labels_defaulted: spec.defaulted, escalations: [],
    provider: p.factory?.provider ?? 'unknown', factory_version: factoryVersion(), skills: [],
    started: new Date(p.startedAt).toISOString(), ended: '',
    ms: { queue: 0, setup: 0, plan: 0, implement: 0, gates: 0, review: 0, evidence: 0, pr: 0, total: 0 },
    agents: [], cost_usd: 0, turns: 0, tokens: { input: 0, output: 0, cache_read: 0, cache_write: 0 },
    gates: [], fix_rounds: 0, review: null, outcome: 'failed', branch: '', base: '', protected_touched: [], dir: p.dir ?? '',
  };
}

export const uiJobOf = (job: string, spec: Spec): UiJob => ({ id: job, pages: spec.ui.pages, designs: spec.design, ...(spec.ui.target ? { target: spec.ui.target } : {}) });

/**
 * Runs a job. A SIGINT or SIGTERM leaves the run in the log, `cancelled` when Helix marked the job so and
 * `interrupted` otherwise, before the process ends.
 */
export async function runJob(opts: RunOptions, deps: Deps): Promise<Run> {
  const live: { run?: Run; startedAt: number } = { startedAt: Date.now() };
  const stop = (code: number) => () => {
    const run = live.run;
    if (run && !run.ended) {
      const cancelled = opts.specFile !== undefined && existsSync(join(dirname(opts.specFile), CANCELLED_MARKER));
      Object.assign(run, { outcome: 'failed', cause: cancelled ? 'cancelled' : 'interrupted', reason: cancelled ? 'the job was cancelled' : 'the job was interrupted', ended: new Date().toISOString() });
      run.ms.total = Date.now() - live.startedAt;
      appendRun(run);
    }
    (deps.exit ?? process.exit)(code);
  };
  const [onInt, onTerm] = [stop(130), stop(143)];
  process.on('SIGINT', onInt);
  process.on('SIGTERM', onTerm);
  try {
    return await runJobWith(opts, deps, live);
  } finally {
    process.off('SIGINT', onInt);
    process.off('SIGTERM', onTerm);
  }
}

async function runJobWith(opts: RunOptions, deps: Deps, live: { run?: Run; startedAt: number }): Promise<Run> {
  const { factory, log } = deps;
  const startedAt = live.startedAt;
  // What this job's sessions serve stops when this process ends, however it ends (ui.ts).
  process.env[JOB_PID] = String(process.pid);
  const repo = mainCheckout(opts.repo);
  const prior = opts.resume?.state;
  // A fix starts from the job it continues; a fix picked up again has that in its own state.
  const fix: { of: string; ask: string; pr?: string | undefined; from?: JobState; references?: string | undefined } | undefined = opts.fix ? { of: opts.fix.of, ask: opts.fix.ask, pr: opts.fix.pr, references: opts.fix.references } : prior?.fix_of && prior.ask ? { of: prior.fix_of, ask: prior.ask, pr: prior.pr } : undefined;
  if (!prior && !opts.specFile && !opts.fix) throw new AnimusError('animus run needs a spec file');
  // On Helix the profile is the base branch's as Helix fetched it, not whatever the clone has checked out (docs/adr/0008).
  const onBase = opts.trigger === 'helix' || process.env.ANIMUS_TRIGGER === 'helix' ? profileOnBase(repo) : undefined;
  const repoProfile = onBase?.profile ?? loadProfile(repo);
  // A new job is admitted before any work (docs/adr/0007); a resumed one was, when it started.
  let spec: Spec;
  let plan: Plan;
  let admitted: Admitted | undefined;
  const earlier = opts.fix?.from;
  const before = prior ?? earlier;
  // A fix with only the pull request to go on (fix.ts, fixAlone): the spec is the one in its description.
  const alone = opts.fix?.alone;
  const carried = Boolean(before || alone);
  if (before) {
    // A job picked up again, or a fix, keeps the spec it was admitted with.
    spec = loadSpec(before.spec);
    plan = before.plan;
  } else if (alone) {
    spec = parseSpec(alone.spec);
    plan = resolvePlan(factory, spec);
  } else {
    admitted = admitFile(factory, opts.specFile!, repo, repoProfile, onBase?.facts);
    if (admitted.problems.length || !admitted.plan) {
      const { spec: s } = admitted;
      const error = refusal(opts.specFile!, admitted);
      appendRun({ ...blankRun({ job: newJobId(s.title), repo, opts, spec: s, size: s.size, difficulty: s.difficulty, type: s.type, startedAt, factory }), outcome: 'failed', cause: 'admit', reason: error.message, ended: new Date().toISOString() });
      throw error;
    }
    ({ spec, plan } = { spec: admitted.spec, plan: admitted.plan });
  }
  const job = prior?.job ?? newJobId(spec.title);
  const ui = plan.type === 'ui' ? uiJobOf(job, spec) : undefined;
  if (ui && carried) {
    const problem = uiProblem(repoProfile, ui);
    if (problem) throw new AnimusError(problem);
  }

  const dir = jobDir(job);
  mkdirSync(dir, { recursive: true });
  const specCopy = join(dir, 'spec.md');
  if (alone) writeFileSync(specCopy, `${alone.spec}\n`);
  else if (!prior) copyFileSync(earlier?.spec ?? opts.specFile!, specCopy);
  if (!prior) saveJobSkills(dir, opts.personal ?? []);
  const personal = loadJobSkills(dir);

  const run = blankRun({ job, repo, opts, spec, size: plan.size, difficulty: plan.difficulty, type: plan.type, startedAt, dir, factory });
  live.run = run;
  const timed = async <T>(stage: keyof Run['ms'], fn: () => T | Promise<T>): Promise<T> => {
    const t = Date.now();
    try {
      const out = await fn();
      // A signal is handled between turns of the event loop, which a session running in the foreground blocks: let it through after each stage.
      await new Promise((done) => setTimeout(done, 5));
      return out;
    } finally { run.ms[stage] += Date.now() - t; }
  };

  /** Says where the job is, in its folder: what Helix's display shows while it runs. */
  const at = (stage: Stage, who: string) => saveProgress(job, stage, who);

  const source = before ? before.source : alone ? undefined : resolve(opts.specFile!);
  if (source) run.spec_file = source;
  if (alone) run.without_session = true;

  const jobLine = `job ${job}: ${spec.title}`;
  // On Helix the person watches at Helix's own links.
  const watch = opts.trigger !== 'helix' && process.env.ANIMUS_TRIGGER !== 'helix' ? [`watch it: animus ui, then open /jobs/${job}`] : [];
  // The watch line follows the where-it-runs line when there is one, else the job line.
  for (const line of opts.runsLine ? [opts.runsLine, ...watch, jobLine] : [jobLine, ...watch]) log(line);
  log(describePlan(factory, plan));
  if (personal.length) log(`the submitter's skills: ${personal.map((p) => `${p.name} (${p.roles.join(', ')}${p.types ? `; ${p.types.join(', ')} jobs` : ''})`).join(', ')}`);
  // A spec that builds on another waits for it, then starts from a base that holds it.
  if (!carried && spec.after.length) {
    at('setup', 'setup · waits for an earlier pull request to merge');
    const files = resolveAfter(repo, source!, spec.after);
    await timed('queue', () => waitForMerged({ repo, files, lookup: deps.prState ?? prState, find: deps.findPr ?? findPrByTitle, log, ...(deps.sleep ? { sleep: deps.sleep } : {}) }));
  }
  for (const w of admitted?.warnings ?? []) log(`warning: ${w}`);
  if (spec.defaulted.length) log(`the spec's header has no ${spec.defaulted.join(', ')}: the default ran`);

  // ---------------------------------------------------------------- setup
  let ws: Workspace;
  /** For a new fix: the one-line log of the commits GitHub's branch has that the worktree lacked, and the commit the fix starts from. */
  let foreign = '';
  let fixStart = prior?.fix_start;
  at('setup', 'setup · worktree and dependencies');
  try {
    ws = await timed('setup', () => {
      if (alone) log('the earlier job\'s folder or worktree is gone: the fix runs from the pull request alone, with the spec from its description and a fresh session');
      const w = before ? reopenWorkspace(repo, before.workspace) : alone ? fixWorkspace(repo, repoProfile, job, alone.branch, alone.baseBranch, log) : createWorkspace(repo, repoProfile, job, spec.base ?? repoProfile.base, log);
      writeFileSync(join(git(w.worktree, ['rev-parse', '--absolute-git-dir']), MARKER), JSON.stringify({ job }));
      if (opts.fix) {
        foreign = syncBranch(w.worktree, w.branch);
        fixStart = git(w.worktree, ['rev-parse', 'HEAD']);
        if (foreign) log(`the branch on GitHub has commits this worktree lacked; the fix starts from it:\n${foreign}`);
      }
      return w;
    });
  } catch (err) {
    if (!(err instanceof AnimusError)) throw err;
    const reason = `job ${job} could not start: ${err.message}`;
    Object.assign(run, { outcome: 'failed', cause: 'setup', reason, ended: new Date().toISOString() });
    run.ms.total = Date.now() - startedAt;
    appendRun(run);
    throw new AnimusError(reason);
  }
  const wt = ws.worktree;
  run.branch = ws.branch;
  run.base = ws.base;
  const kept = opts.fix?.kept;
  const inherited: { fixes?: FromPr['fixes']; closes?: number } | undefined = { fixes: kept?.fixes ?? (before ?? alone)?.fixes, closes: kept?.closes ?? (before ?? alone)?.closes };
  const answers = [...(before?.answers ?? []), ...(prior?.question && opts.resume?.answer ? [{ question: prior.question, answer: opts.resume.answer }] : [])];
  // A fix carries on from the session of the job it continues, and from that job's list of fixes.
  const state: JobState = {
    job, repo, spec: specCopy, ...(source ? { source } : {}), workspace: ws, plan, ...(before?.session ? { session: before.session } : {}), ...(before?.context !== undefined ? { context: before.context } : {}), ...(answers.length ? { answers } : {}),
    ...(prior?.slicing ? { slicing: prior.slicing, sliced_by: prior.sliced_by ?? 'script', slices_done: prior.slices_done ?? [] } : {}),
    ...(fix ? { fix_of: fix.of, ask: fix.ask, ...(fix.pr ? { pr: fix.pr } : {}), ...(fixStart ? { fix_start: fixStart } : {}) } : {}), ...(inherited?.fixes ? { fixes: inherited.fixes } : {}), ...(inherited?.closes ? { closes: inherited.closes } : {}),
  };
  saveState(state);

  let summary = '';
  let notes: string | undefined;
  let breaking: string | undefined;
  /** What a session new to the job is told first: where it is, the gates, the spec. */
  let brief = '';
  let lastGates: CheckResult[] = [];
  let review: Review | undefined;
  let reviewRounds = 0;
  let open: Finding[] = [];
  let shots: { dir: string; files: string[]; urls?: Record<string, string>; branch?: string } | undefined;
  const found = new Map<string, Finding>();
  let actedOn = 0;
  const findingLog: FindingLog[] = [];
  /** Gate fix rounds spent outside the current allowance: each slice has its own, and so have the finished branch and its catch-up. */
  let spentBefore = 0;
  /** The base commit the branch caught up to before the push, once it has. */
  let caughtUp: string | undefined;
  /** The files whose conflicts with the base an implementer resolved in the catch-up. */
  let resolved: string[] = [];
  let planFallback: string | undefined;
  /** The slice being worked on, for whoever watches the job: "slice 2 of 4". */
  let inSlice = '';

  const record = (stage: string, role: string, tier: Tier, effort: string, r: AgentResult) => {
    const by_tool: Record<string, number> = {};
    for (const t of r.tools ?? []) by_tool[t.tool] = (by_tool[t.tool] ?? 0) + 1;
    run.agents.push({
      stage, role, tier, effort, model: r.model, ok: r.ok, status: r.status, cost_usd: r.cost_usd, turns: r.turns, tokens: r.tokens, ms: r.ms,
      ...(r.session ? { session: r.session } : {}), ...(r.transcript ? { transcript: r.transcript } : {}), ...(r.context !== undefined ? { context: r.context } : {}),
      ...(r.tools ? { tools: { calls: r.tools.length, errors: r.tools.filter((t) => !t.ok).length, by_tool } } : {}),
    });
    if (r.tools?.length) {
      mkdirSync(dir, { recursive: true });
      appendFileSync(toolsLog(job), r.tools.map((t) => `${JSON.stringify({ ...t, stage, role, ...(r.session ? { session: r.session } : {}) })}\n`).join(''));
    }
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
    const s = roleSkills(factory, role, plan.type, wt, personal);
    for (const name of s.names) if (!run.skills.includes(name)) run.skills.push(name);
    return { system: [readPrompt(role), s.system, lessonsFor(role)].filter(Boolean).join('\n\n'), ...(s.dirs.length ? { addDirs: s.dirs } : {}) };
  };

  /** The lessons an agent is given, as a section of its instructions. A lesson counts as used once for the job, however many agents get it. */
  const lessonsFor = (role: string): string => {
    const given = lessonsForPrompt(basename(repo), role === 'ui-reviewer' ? 'reviewer' : role as Lesson['agent'], Date.now());
    const fresh = given.map((l) => l.id).filter((id) => !run.lessons?.includes(id));
    if (fresh.length) {
      if (!process.env[GIVEN_FILE]) countUses(fresh);
      run.lessons = [...(run.lessons ?? []), ...fresh];
    }
    return lessonsSection(given);
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
  const implementer = async (stage: string, asked: string, tier: Tier, opens = false, handoff?: () => string): Promise<Report> => {
    const effort = plan.implement.effort;
    let prompt = asked;
    if (!opens) {
      const over = Boolean(state.session && budget && (state.context ?? 0) > budget);
      if (over) {
        log(`the implementer's session ended at ${k(state.context!)} tokens of context, over the ${k(budget!)} budget: ${stage} starts a fresh session`);
        delete state.session;
        run.handoffs = (run.handoffs ?? 0) + 1;
      }
      if (!state.session) prompt = handoff?.() ?? handoffPrompt({ brief, base: ws.base, summary, notes, asked, over });
    }
    log(`${stage}: ${modelFor(factory, tier)}, ${effort} effort`);
    const before = git(wt, ['rev-parse', 'HEAD']);
    at('implement', `implementer · ${tier} tier${inSlice ? ` · ${inSlice}` : ''}${/-fix-/.test(stage) ? ` · ${stage.replace('-fix-', ' fix ')}` : ''}`);
    const r = await timed('implement', () => deps.agent({ role: 'implementer', tier, effort, prompt, cwd: wt, ...instructions('implementer'), schema: REPORT_SCHEMA, ...caps(tier), ...(state.session ? { resume: state.session } : {}) }));
    record(stage, 'implementer', tier, effort, r);
    if (r.session) state.session = r.session;
    if (r.context !== undefined) state.context = r.context; else delete state.context;
    saveState(state);
    // The implementer commits at each working step; whatever it left is kept too, so a retry starts from it.
    commitAll(wt, `${spec.title}: work left uncommitted at the end of ${stage}`);
    const changed = git(wt, ['rev-parse', 'HEAD']) !== before;
    if (!r.ok) throw new Stop('failed', `the implementer's session ended with ${r.status}${r.text ? `: ${r.text.slice(0, 300)}` : ''}`, sessionCause(r.status));
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
    // A `failed` is a claim: with work on the branch the gates check it, and its note goes with the work.
    if (report.status === 'failed') {
      if (!changed) throw new Stop('failed', `the implementer gave up: ${report.summary}`);
      log(`${stage}: the implementer reported failed (${report.summary}) but changed the branch, so the gates decide`);
      report.notes = [`The implementer reported it failed: ${report.summary}`, report.notes].filter(Boolean).join(' ');
    }
    if (report.summary) summary = report.summary;
    if (report.notes) notes = report.notes;
    // Kept across slices and sessions: a later session's silence does not take back what an earlier one broke.
    if (report.breaking && !breaking?.includes(report.breaking)) breaking = [breaking, report.breaking].filter(Boolean).join('\n\n');
    return report;
  };

  /**
   * Runs the gates until they pass, sending failures back to the implementer
   * while rounds are left. For a slice, only the criteria of the slices so
   * far are checked, and the rounds are that slice's own. `why` goes in front
   * of each failure sent back; `exhausted` is how the job ends when the
   * rounds run out.
   */
  const gate = async (slice?: { name: string; only: ReadonlySet<number> }, why = '', exhausted: Stop['outcome'] = 'failed'): Promise<void> => {
    const of = slice ? ` for ${slice.name}` : '';
    let rounds = 0;
    for (;;) {
      const head = git(wt, ['rev-parse', 'HEAD']);
      if (head === (fixStart ?? ws.base)) throw new Stop('failed', 'the implementer changed nothing');
      const attempt = run.gates.length + 1;
      const checks = jobChecks(repoProfile, plan, spec, { base: ws.base, files: touchedFiles(wt, ws.base, head) }, slice?.only);
      log(`gates${of}, run ${attempt}: ${checks.filter((c) => !c.skip).map((c) => c.name).join(', ') || 'nothing to run'}`);
      at('gates', `gates${of} · attempt ${attempt}${run.fix_rounds ? ` after ${run.fix_rounds === 1 ? 'a fix round' : `${run.fix_rounds} fix rounds`}` : ''}`);
      const t = Date.now();
      lastGates = await timed('gates', () => {
        const results = runChecks(wt, checks, job);
        // A failed check runs once more on the same tree: passing then, it was flaky and counts as passed.
        const failed = results.filter((r) => !r.ok);
        if (failed.length) {
          restore(wt);
          const again = runChecks(wt, checks.filter((c) => failed.some((r) => r.name === c.name)), job);
          for (const r of again) {
            if (!r.ok) continue;
            results[results.findIndex((x) => x.name === r.name)] = { ...r, flaky: true };
            log(`flaky: ${r.name} failed, then passed on the same code`);
          }
        }
        // The proof that the tests fail without the change is for the whole job: it runs on the finished branch.
        if (!plan.prove || slice) return results;
        return [...results, failsOnBase({ repo, profile: repoProfile, spec, base: ws.base, head, files: touchedFiles(wt, ws.base, head), job, green: results.every((r) => r.ok) })];
      });
      restore(wt);
      const ok = lastGates.every((r) => r.ok);
      run.gates.push({ attempt, ok, ms: Date.now() - t, checks: lastGates.map((r) => ({ name: r.name, ok: r.ok, skipped: r.skipped, ms: r.ms, ...(r.flaky ? { flaky: true } : {}) })) });
      mkdirSync(join(dir, 'gates'), { recursive: true });
      writeFileSync(join(dir, 'gates', `run-${attempt}.txt`), gateReport(lastGates));
      for (const line of describe(lastGates).split('\n').slice(0, lastGates.length)) log(`  ${line}`);
      if (ok) return;
      const used = slice ? rounds : run.fix_rounds - spentBefore;
      if (used >= factory.limits.gate_rounds) throw new Stop(exhausted, `the gates${of} still fail after ${used} fix round(s):\n${describe(lastGates.filter((r) => !r.ok))}`, 'gates', { failing_checks: lastGates.filter((r) => !r.ok).map((r) => r.name) });
      run.fix_rounds++;
      if (slice) { rounds++; spentBefore++; }
      // A failed gate round raises the model tier by one for the next.
      await implementer(`gate-fix-${run.fix_rounds}`, `${why}${gateFixPrompt(describe(lastGates), factory.limits.gate_rounds - used - 1)}`, raise(plan.implement.tier));
    }
  };

  /**
   * The catch-up: merges what the base gained since the job started into its
   * branch, with one merge commit (no rebase: each of a sliced job's commits
   * would meet the same conflict). Returns the base commit it merged, or
   * nothing when the base did not move. The merged base becomes the job's
   * base, so the job's own changes stay what is diffed. A merge that
   * conflicts is undone and the branch opens as it was, unless `keep` asks
   * for the conflicting files, with the merge left in progress.
   */
  const catchUp = (keep = false): { latest: string; conflicts?: string[] } | undefined => {
    at('gates', `catch-up · ${ws.baseBranch}`);
    const latest = baseCommit(repo, ws.baseBranch, log);
    // Holding it already covers a base that did not move, and one rewound to an earlier commit.
    if (tryGit(wt, ['merge-base', '--is-ancestor', latest, 'HEAD']) !== undefined) return undefined;
    if (tryGit(wt, ['merge', '--no-ff', '--no-verify', '-m', `Merge ${ws.baseBranch} at ${latest.slice(0, 12)} into ${ws.branch}`, latest]) === undefined) {
      const conflicts = git(wt, ['diff', '--name-only', '--diff-filter=U']).split('\n').filter(Boolean);
      if (keep && conflicts.length) {
        log(`catch-up: ${ws.baseBranch} at ${latest} conflicts with the job's branch in ${conflicts.join(', ')}`);
        return { latest, conflicts };
      }
      tryGit(wt, ['merge', '--abort']);
      log(`catch-up: ${ws.baseBranch} at ${latest} conflicts with the job's branch; the pull request opens without it`);
      return undefined;
    }
    log(`catch-up: merged ${ws.baseBranch} at ${latest}`);
    ws.base = caughtUp = latest;
    saveState(state);
    return { latest };
  };

  /**
   * A catch-up that conflicts: a fresh implementer session resolves the
   * merge, and the script decides whether that holds: no conflict markers
   * left, and every gate green within its fix rounds. What it cannot settle
   * ends the job as needs input with the branch put back as the review left
   * it, so the answer starts the catch-up again from a clean merge.
   */
  const resolveConflicts = async (latest: string, files: string[], answered?: { question: string; answer: string }): Promise<void> => {
    const from = git(wt, ['rev-parse', 'HEAD']);
    const was = ws.base;
    const kept = { summary, ...(notes ? { notes } : {}), ...(review ? { review } : {}), review_rounds: reviewRounds };
    try {
      const locked = files.filter((f) => matchesAny(f, repoProfile.protected));
      // The person's answer is their say on a protected path; without one, no session touches it.
      if (locked.length && !answered) throw new Stop('needs-input', `${locked.join(', ')} ${locked.length === 1 ? 'is a protected path' : 'are protected paths'}, so Animus asks you how to resolve it before any session does.`);
      const commits = git(wt, ['log', '--format=%h %s', `${was}..${latest}`, '--', ...files]);
      delete state.session;
      delete state.context;
      await implementer(answered ? 'catch-up-resume' : 'catch-up', conflictPrompt({ job, spec, ws, repo, latest, files, commits, ...(answered ? { answered } : {}) }), plan.implement.tier, true);
      // The resolving session's report is about the merge, not the job: the pull request keeps the job's.
      summary = kept.summary;
      notes = kept.notes;
      const left = (tryGit(wt, ['grep', '-l', '-E', '^(<{7}|>{7})( |$)', 'HEAD', '--', ...files]) ?? '').split('\n').filter(Boolean).map((f) => f.replace(/^HEAD:/, ''));
      if (left.length) throw new Stop('needs-input', `The resolution did not hold: conflict markers are left in ${left.join(', ')}.`);
      if (tryGit(wt, ['merge-base', '--is-ancestor', latest, 'HEAD']) === undefined) throw new Stop('needs-input', 'The resolution did not hold: the merge was not committed.');
      ws.base = caughtUp = latest;
      saveState(state);
      spentBefore = run.fix_rounds;
      await gate(undefined, `The base moved while the job ran, and Animus merged ${ws.baseBranch} at ${latest} into this branch. Its conflicts in ${files.join(', ')} were resolved, and the gates failed on the merged branch: make the resolution work with both the job's change and the base's.\n\n`, 'needs-input');
      resolved = files;
    } catch (err) {
      tryGit(wt, ['merge', '--abort']);
      git(wt, ['reset', '--quiet', '--hard', from]);
      ws.base = was;
      caughtUp = undefined;
      if (!(err instanceof Stop) || err.outcome !== 'needs-input') throw err;
      state.catch_up = kept;
      log(`catch-up: the branch is back at ${from}; an answer picks the job up at the catch-up`);
      throw new Stop('needs-input', `The merge of ${ws.baseBranch} at ${latest} into the job's branch conflicts in ${files.join(', ')}. ${err.message}`);
    }
  };

  /** Screenshots for the reviewer are part of the review; the ones taken after it are the evidence. */
  const shoot = async (of: UiJob = ui!, stage: Stage = 'evidence'): Promise<string> => {
    at(stage, `${stage} · screenshots`);
    const r = await timed('evidence', () => (deps.shots ?? takeShots)(wt, of, repoProfile, join(dir, 'shots')));
    shots = { dir: r.dir, files: r.shots.build };
    log(`${r.reused ? 'screenshots unchanged' : `${r.shots.build.length} screenshot(s) taken`}: ${r.dir}`);
    return describeShots(r.dir, r.shots, r.reused);
  };

  let outcome: Outcome = 'failed';
  let reason: string | undefined;
  let stopped: Stop | undefined;
  try {
    await timed('setup', () => {
      try { ensureSetup(wt, repoProfile, log); } catch (err) { throw err instanceof AnimusError ? new Stop('failed', err.message, 'setup') : err; }
    });

    // ------------------------------------------------------------ implement
    const profile = repoProfile;
    const about = { job, spec, ws, repo, notes: profile.notes, ui: ui ? uiBrief(wt, profile, ui) : undefined };
    const whole = implementPrompt({ ...about, gates: jobChecks(profile, plan, spec, { base: ws.base, files: [] }).map((c) => c.command), prove: plan.prove ? profile.tests : undefined });

    // ----------------------------------------------------------------- plan
    // How the spec is cut is decided once. A job picked up again keeps its cut.
    if (!state.slicing) {
      state.slicing = carried ? oneSlice(spec) : await timed('plan', () => {
        try {
          if (isPlanned(factory, spec.size)) at('plan', `planner · ${factory.planner!.tier} tier`);
          const planned = planSlices({ factory, agent: deps.agent, spec, cwd: wt, personal, lessons: () => lessonsFor('planner'), log, record: (stage, r) => record(stage, 'planner', factory.planner!.tier, factory.planner!.effort, r) });
          state.sliced_by = planned.by;
          if (planned.by === 'planner') for (const name of roleSkills(factory, 'planner', plan.type, wt, personal).names) if (!run.skills.includes(name)) run.skills.push(name);
          return planned.slicing;
        } catch (err) {
          if (!(err instanceof AnimusError)) throw err;
          // A large spec does not fit one session, so with no cut there is no way to run it.
          if (spec.size === 'large') throw new Stop('failed', `a large spec runs only as slices, and no cut was taken: ${err.message}`, 'plan');
          // Smaller work a planner could not cut is done the way it was before there was a planner.
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
    // A job that stopped at the catch-up was implemented and reviewed: it picks up there.
    const atCatchUp = prior?.catch_up;
    if (atCatchUp) {
      log('the job picks up at the catch-up');
      brief = whole;
      ({ summary, notes, review } = atCatchUp);
      reviewRounds = atCatchUp.review_rounds;
      for (const f of review?.findings ?? []) found.set(`${f.file ?? ''}:${f.problem}`, f);
    } else if (slices.length === 1) {
      brief = whole;
      // A fix picked up again (after a question or an interruption) still has its ask, and the commit it started from.
      if (fix) await implementer(prior ? 'resume' : 'fix', `${prior ? `${resumePrompt(prior, opts.resume?.answer)}\n\n` : ''}${resumeFixPrompt({ ask: fix.ask, foreign, references: fix.references })}`, plan.implement.tier, false, () => handoffFixPrompt({ brief, base: ws.base, cwd: wt, answers, ask: fix.ask, foreign, references: fix.references }));
      else await implementer(prior ? 'resume' : 'implement', prior ? resumePrompt(prior, opts.resume?.answer) : brief, plan.implement.tier, !prior);
    } else {
      if (!prior) log(`${slices.length} slices: ${slices.map((s) => s.title).join('; ')}`);
      for (let i = resumed; i < slices.length; i++) {
        const name = `slice ${i + 1} of ${slices.length}`;
        const only = criteriaSoFar(state.slicing, i)!;
        log(`${name}: ${slices[i]!.title}`);
        inSlice = name;
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
      inSlice = '';
      if (prior && resumed >= slices.length) await implementer('resume', resumePrompt(prior, opts.resume?.answer), plan.implement.tier);
    }

    // ---------------------------------------------------------------- gates
    if (!atCatchUp) await gate();

    // --------------------------------------------------------------- review
    if (atCatchUp) log('review: done before the catch-up stopped to ask');
    else if (plan.review) {
      const { role, tier, effort } = plan.review;
      for (let round = 1; ; round++) {
        const seen = ui ? await shoot(ui, 'review') : undefined;
        log(`review ${round}: ${role}, ${modelFor(factory, tier)}, ${effort} effort`);
        at('review', `${role} · ${tier} tier${round > 1 ? ` · round ${round}` : ''}`);
        const prompt = reviewPrompt({ spec, ws, round, earlier: open, shots: seen, answers, ...(fix ? { ask: fix.ask } : {}) });
        let said: Review | undefined;
        let ended = 'success';
        for (let tries = 0; tries < 2 && !said; tries++) {
          const r = await timed('review', () => deps.agent({ role, tier, effort, prompt, cwd: wt, ...instructions(role), schema: REVIEW_SCHEMA, readOnly: true, timeoutMs: REVIEW_TIMEOUT_MS, ...caps(tier) }));
          record(`review-${round}${tries ? '-retry' : ''}`, role, tier, effort, r);
          restore(wt);
          said = asReview(r.output);
          ended = r.status;
        }
        if (!said) throw new Stop('failed', 'the reviewer gave no review in two tries', sessionCause(ended));
        review = said;
        reviewRounds = round;
        writeJson(join(dir, `review-${round}.json`), said);
        for (const f of said.findings) found.set(`${f.file ?? ''}:${f.problem}`, f);
        open = blockers(said.findings);
        const mine = said.findings.map((f): FindingLog => ({ round, severity: f.severity, ...(f.file ? { file: f.file } : {}), ...(f.line !== undefined ? { line: f.line } : {}), fate: open.includes(f) ? 'open' : 'not-acted-on' }));
        findingLog.push(...mine);
        if (said.status === 'not-ready') throw new Stop('failed', `the reviewer says the work is not ready: ${said.summary}`, 'review', { blockers_left: open.length });
        log(`review ${round}: ${said.findings.length} finding(s), ${open.length} to fix`);
        if (!open.length) break;
        if (round > factory.limits.review_rounds) throw new Stop('failed', `the review still found ${open.length} blocker(s) after its fix round`, 'review', { blockers_left: open.length });
        actedOn += open.length;
        for (const l of mine) if (l.fate === 'open') l.fate = 'fixed';
        await implementer(`review-fix-${round}`, reviewFixPrompt(open), plan.implement.tier);
        await gate();
      }
    } else log('review: skipped for this profile');

    // ------------------------------------------------------------- catch-up
    const merged = catchUp(true);
    if (merged?.conflicts) {
      const answer = opts.resume?.answer;
      await resolveConflicts(merged.latest, merged.conflicts, atCatchUp && prior?.question && answer ? { question: prior.question, answer } : undefined);
    } else if (merged) {
      // The merged branch is new code: every gate runs on it, with fix rounds of its own.
      spentBefore = run.fix_rounds;
      await gate(undefined, `The base moved while the job ran, and Animus merged ${ws.baseBranch} at ${caughtUp} into this branch. The gates failed on the merged branch: make your change work with what the base changed.\n\n`);
    } else if (atCatchUp) await gate(); // The base no longer conflicts and holds nothing new: the pull request still needs the gates' evidence.

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
    stopped = err instanceof Stop ? err : new Stop('failed', err.message);
    log(`${outcome === 'needs-input' ? 'needs input' : 'failed'}: ${reason.split('\n')[0]}`);
  }

  // ------------------------------------------------------------------- PR
  // A failure's draft opens after the same catch-up, so it too has no conflict with the base where the merge is clean.
  if (outcome === 'failed' && git(wt, ['rev-parse', 'HEAD']) !== ws.base) {
    try {
      catchUp();
    } catch (err) {
      if (!(err instanceof AnimusError)) throw err;
      log(`catch-up: ${err.message.split('\n')[0]}`);
    }
  }
  at('pr', outcome === 'needs-input' ? 'pr · stopping to ask' : outcome === 'failed' ? 'pr · writing the failure report' : 'pr · writing the description');
  const head = git(wt, ['rev-parse', 'HEAD']);
  run.head = head;
  run.protected_touched = touchedFiles(wt, ws.base, head).filter((f) => matchesAny(f, repoProfile.protected));
  const all = [...found.values()];
  if (reviewRounds) run.review = { rounds: reviewRounds, findings: all.length, blockers: all.filter((f) => f.severity === 'blocker').length, acted_on: actedOn, open: outcome === 'failed' ? open.length : 0, log: findingLog };
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
    // The issue to close is Helix's for a job submitted from an issue; a fix keeps the line from the job it continues.
    const issue = /^\d+$/.test(process.env.ANIMUS_CLOSES ?? '') ? Number(process.env.ANIMUS_CLOSES) : state.closes;
    if (issue) state.closes = issue;
    if (fix) state.fixes = [...(state.fixes ?? []).filter((f) => f.job !== job), { ask: fix.ask, job, cost_usd: run.cost_usd }];
    const body = prBody({
      job, spec, plan, summary, ...(sliced ? { slices: sliced } : {}), gates: lastGates, gateAttempts: run.gates.length, fixRounds: run.fix_rounds, reviewRounds, open: failed ? open : [],
      protectedTouched: run.protected_touched, escalations: run.escalations, models, cost_usd: run.cost_usd,
      ...(notes ? { notes } : {}), ...(breaking ? { breaking } : {}), ...(review ? { review } : {}), ...(shots ? { shots } : {}), ...(caughtUp ? { caughtUp: { branch: ws.baseBranch, commit: caughtUp, resolved } } : {}), ...(failed && reason ? { failure: reason } : {}),
      // A failure report is a draft, which should not close the issue when merged.
      ...(!failed && issue ? { closes: issue, issueLink: repoProfile.issue_link } : {}),
      ...(state.fixes ? { fixes: state.fixes } : {}),
    });
    writeFileSync(join(dir, 'pr-body.md'), `${body}\n`);
    // A fix that failed pushes nothing: the pull request stays as it was. The one failure that still pushes is the
    // reviewer's refusal on a pull request that was already a draft, which stays a draft with the reasons in its body.
    const held = failed && fix && !(stopped?.cause === 'review' && fix.pr && (deps.prDraft ?? prDraft)(fix.pr, wt) === true);
    if (held) {
      log(`the fix is not pushed and the pull request is as it was; the work is on ${ws.branch}${open.length ? `\nthe reviewer's blockers:\n${listFindings(open)}` : ''}`);
    } else if (!opts.dryRun) {
      try {
        run.pr = await timed('pr', () => deps.publish({ cwd: wt, branch: ws.branch, baseBranch: ws.baseBranch, title: spec.title, body, draft: failed || Boolean(opts.draft) }));
        if (failed) outcome = 'draft-pr';
        log(`${failed ? 'draft pull request with the failure report' : 'pull request'}: ${run.pr}`);
      } catch (err) {
        if (!(err instanceof AnimusError)) throw err;
        outcome = 'failed';
        // The push is never forced: across machines it is what keeps two fixes from overwriting each other.
        reason = fix && err instanceof PushRejected ? 'the branch changed while this fix ran: fix again' : `${reason ? `${reason}\n` : ''}the pull request could not be opened: ${err.message}`;
        log(reason.split('\n').pop()!);
      }
    } else log(`dry run: the pull request's body is in ${join(dir, 'pr-body.md')}; the work is on ${ws.branch}`);
  }

  // -------------------------------------------------------------- the log
  run.outcome = outcome;
  // A draft pull request still ended on its failure; a pull request that could not be opened has no cause but the failure before it, if any.
  if (outcome !== 'pr' && outcome !== 'dry-run') Object.assign(run, { cause: (stopped ?? new Stop('failed', '')).cause }, stopped?.detail);
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
  const pages = pagesOf(target, ui).map((p) => p.name);
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

/** What the session resolving the catch-up's conflicts is told: the files, the base's commits that touched them, the answer when the job asked, then the spec. */
function conflictPrompt(p: { job: string; spec: Spec; ws: Workspace; repo: string; latest: string; files: readonly string[]; commits: string; answered?: { question: string; answer: string } }): string {
  return [
    `Job ${p.job}. You are in a worktree of ${basename(p.repo)} on the branch ${p.ws.branch}. The job's work on this branch is done and reviewed, but ${p.ws.baseBranch} moved while the job ran, and Animus is merging ${p.ws.baseBranch} at ${p.latest} into the branch. The merge is in progress and conflicts in these files:\n${p.files.map((f) => `  ${f}`).join('\n')}`,
    `The commits of ${p.ws.baseBranch} that touched them (\`git show <commit>\` shows one):\n${p.commits || '  (none)'}`,
    `Resolve each conflict so that both the job's change and the base's hold, leave no conflict markers, and commit the merge with \`git commit --no-edit\`. Change nothing the conflicts do not need. Then run \`${animusCommand()} check\` (foreground, Bash timeout 600000). Animus then checks that no markers are left and runs every gate on the merged branch. If you cannot tell how a conflict should be resolved, do not guess: leave the merge as it is, finish with status needs-input, and in question name the file and what you could not decide.`,
    p.answered ? `The job stopped here before to ask: ${p.answered.question}\n\nThe person's answer: ${p.answered.answer}` : '',
    `The job's spec follows.\n\n${p.spec.text.trim()}`,
  ].filter(Boolean).join('\n\n');
}

function reviewFixPrompt(findings: readonly Finding[]): string {
  return `A reviewer that did not write this code read your change against the spec. Fix each of these, commit, run \`${animusCommand()} check\`, and finish again. This is the review's only fix round. If a finding is wrong, say why in your notes instead of changing code for it.\n\n${listFindings(findings)}`;
}

function resumePrompt(prior: JobState, answer?: string): string {
  if (prior.question) return `You stopped this job to ask: ${prior.question}\n\n${answer ? `The person's answer: ${answer}` : 'The person gave no answer; decide as well as you can and say what you assumed in your notes.'}\n\nCarry on from where you stopped, and finish as before.`;
  return `This job was interrupted and is being picked up again. Your earlier commits are on the branch. ${answer ? `From the person: ${answer}\n\n` : ''}Check what is done against the spec, finish the rest, and finish as before.`;
}

function reviewPrompt(p: { spec: Spec; ws: Workspace; round: number; earlier: readonly Finding[]; shots?: string | undefined; answers?: readonly { question: string; answer: string }[]; ask?: string }): string {
  return [
    `You are in the worktree of the finished change. Read the diff with: git diff ${p.ws.base}...HEAD`,
    p.round > 1 ? `This is review ${p.round}, after a fix round. The earlier blockers were:\n${listFindings(p.earlier)}` : '',
    p.shots ?? '',
    `The acceptance criteria, numbered as your answer must number them:\n${criteriaList(p.spec)}`,
    `The spec:\n\n${p.spec.text.trim()}`,
    p.answers?.length ? `While it ran, the job stopped to ask the person who submitted it, and they answered. Their answers decide what the spec left open; judge the work against them as you do the spec:\n${p.answers.map((a) => `- Asked: ${a.question}\n  Answered: ${a.answer}`).join('\n')}` : '',
    p.ask ? reviewAsk(p.ask) : '',
  ].filter(Boolean).join('\n\n');
}

/** Whether a command is on PATH: `animus doctor`-style checks before a run. */
export function onPath(command: string): boolean {
  return spawnSync('/bin/sh', ['-c', `command -v ${command}`], { stdio: 'ignore' }).status === 0;
}
