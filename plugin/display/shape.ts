// What the display page reads from its source (ADR 0004): Helix's /display
// answers this shape. It lives with the page, since the plugin never imports
// Helix.
import type { Progress } from '../src/log.ts';
import type { Review } from '../src/review.ts';

/** A job as the display sees it: Helix's row without what is only Helix's business (the spec's path, the pid, the answer's text). */
export type DisplayJob = {
  /** Helix's number, or a local job's own id. */
  id: number | string;
  state: 'queued' | 'waiting' | 'running' | 'ended' | 'cancelled' | 'stopped';
  person: string;
  /** The repository's name in Helix's config. */
  repo: string;
  title: string;
  submitted: string;
  /** When it last went back into the queue: after an answer, or when Helix stopped while it ran. */
  queued?: string;
  started?: string;
  ended?: string;
  /** Animus's own id for the job, once its run has said it. */
  animus_job?: string;
  /** How the run ended: Animus's outcome (pr, draft-pr, needs-input, failed). */
  outcome?: string;
  pr?: string;
  /** A fix: the job it continues (Helix's number, or a local job's id). */
  fix_of?: number | string;
  /** The title of that job, for the line "fix of <title>"; left out where the source does not know it. */
  fix_of_title?: string;
  reason?: string;
  question?: string;
  cost_usd?: number;
  /** Every token its runs' agent sessions used: input, output and cache together. */
  tokens?: number;
  /** Times its gates sent the work back; left out for a job whose gates have not run. */
  fix_rounds?: number;
  /** A stopped job (its process is gone, with no outcome): the command that picks it up again. */
  resume?: string;
  /** Why a queued job is held for room (memory, load or a tier at its limit, with the numbers), or what a waiting job waits for: "waiting for <spec>'s pull request". */
  waiting?: string;
  /** Why a queued job is in the queue a second time. */
  resumed?: 'answer' | 'restart';
  /** Running jobs: the stage and who is working, as the job last said. */
  progress?: Progress;
  /** Running jobs: the last line of the job's output. */
  now?: string;
};

/** One check of a job's latest gate run; a failed one carries all it printed. */
export type JobCheck = { name: string; command: string; status: 'ok' | 'fail' | 'skip'; detail: string; output?: string };

/**
 * What a job page reads: from Helix, GET /jobs/<id>/page-data, with a
 * person's token. Each part the job has not reached yet is left out.
 */
export type JobPage = {
  /** The source's clock, as in Display. */
  at: string;
  stages: readonly string[];
  job: DisplayJob;
  /** The spec as it was submitted. */
  spec?: string;
  /** Wall time per stage in ms, added up over the job's runs that have ended. */
  ms?: Record<string, number>;
  /** When it was cut into more than one slice: each in order, and whether its gates passed. */
  slices?: { title: string; delivers: string; done: boolean }[];
  checks?: JobCheck[];
  /** How many times its gates ran: the job folder's gate run files. */
  gate_runs?: number;
  /** Every gate run's checks, oldest first; the last is `checks`. */
  gate_list?: JobCheck[][];
  /** The description the pull request was opened with (the job folder's pr-body.md). */
  pr_body?: string;
  /** Every review round, first to last. */
  reviews?: Pick<Review, 'summary' | 'findings'>[];
  /** Every question the job asked, with the answer it was given; the one it waits on has none. */
  questions?: { question: string; answer?: string }[];
  /** Its latest screenshots, as named in its shots folder (`build/…`), each served with a token at /jobs/<id>/shots/<name>; `at` is when they were taken. */
  shots?: { at: string; files: string[] };
  /** What GitHub (locally, outcomes.json) said of its PR, and when it opened and merged; left out where it has not said. */
  pr_state?: PrState;
  pr_opened?: string;
  pr_merged?: string;
  /** What the job's run log says of its runs, left out until one has ended. */
  run?: JobRun;
  /** A first attempt's agent sessions so far, before any run record exists: from its tool-call log and progress. Tokens and cost are unknown until a session ends. */
  sessions?: LiveSession[];
  /** What happened to its PR after the job, as outcomes.json says; left out where it has not said. */
  after?: Pick<InsightsOutcome, 'human_commits' | 'reverted' | 'reworked'> & { lines?: { added: number; removed: number } };
  /** The lessons that cite the job, proposed or kept. */
  lessons?: InsightsLesson[];
  /** What the job's run has printed, all of it. */
  log: string;
  /** What every label means: the factory's profiles, for the Labels panel's explainer. */
  profiles?: ProfilesInfo;
};

/** Input, output and cache tokens, as the run log keeps them. */
export type TokenCount = { input: number; output: number; cache_read: number; cache_write: number };

/** The factory's profiles as the display explains them: which models each tier means and what every size, difficulty and type runs. */
export type ProfilesInfo = {
  provider: string;
  /** Tier to model, for the provider in use. */
  models: Record<string, string>;
  planner?: { tier: string; effort: string; sizes: string[] };
  sizes: { name: string; looks_like?: string; setup?: string; gates?: string; review?: string }[];
  difficulties: { name: string; signals?: string; tier: string; effort: string; review?: string; sizes?: Record<string, { tier?: string; effort?: string }> }[];
  /** Only the types that run. */
  types: { name: string; reviewer?: string; evidence?: string[]; prove?: string }[];
};

/** A job's runs put together, for its page: fix rounds, each gate run's flaky checks, each agent session with its calls, each review finding's fate, and `animus tools` as text. */
export type JobRun = {
  fix_rounds: number;
  gates: { flaky: string[] }[];
  /** Each agent session in the order it ran, with its stage, model, wall time and tokens. */
  agents: { stage: string; role: string; tier: string; model: string; effort: string; /** When it began (ISO); left out of a run recorded before that was kept. */ started?: string; ok: boolean; ms: number; turns: number; tokens: TokenCount; cost_usd: number; calls: number; errors: number }[];
  findings: { round: number; severity: string; fate: 'fixed' | 'open' | 'not-acted-on' }[];
  tools: { calls: number; errors: number; text: string };
};

/** An agent session of a job still on its first attempt; `live` is the one working now, with the tool it last used. */
export type LiveSession = { stage: string; role: string; model: string; effort: string; started: string; ms: number; calls: number; errors: number; live: boolean; tool?: string; target?: string };

/** An open pull request one of Helix's jobs opened, as GitHub lists it now. */
export type DisplayPr = { /** Helix's number, or a local job's own id. */ job: number | string; repo: string; person: string; number: number; title: string; url: string; draft: boolean; created: string };

/** A PR one of Helix's jobs opened that GitHub lists as closed: merged or not, and when. */
export type DisplayClosed = { /** Helix's number, or a local job's own id. */ job: number | string; number: number; merged: boolean; at: string };

export type DisplayRepo ={ name: string; base?: string; gates?: string[] };

export type Display = {
  name: string;
  /** The local display's release and process id, so `animus ui` can tell an older one from itself. */
  version?: string;
  pid?: number;
  /** The source's clock, so a display with another clock still counts elapsed time right. */
  at: string;
  slots: number;
  stages: readonly string[];
  repos: DisplayRepo[];
  jobs: DisplayJob[];
  /** Open PRs the jobs opened, any order; left out by a source that does not ask GitHub. */
  prs?: DisplayPr[];
  /** The latest closed PRs of those jobs, as GitHub lists them; a job not here has no answer from GitHub. */
  closed?: DisplayClosed[];
  /** Set by the local display (`animus ui`): this machine's jobs, no sign-in, listed by project rather than as a queue. */
  local?: true;
};

/** One person on the people list: from Helix, GET /people/page-data, with a person's token. */
export type PersonRow = {
  name: string;
  /** The login their GitHub token signed in as when they joined. */
  github?: string;
  /** The day they joined (ISO); left out for a person who joined before it was kept. */
  joined?: string;
  jobs: number;
  /** Jobs that opened a pull request. */
  prs: number;
  spent: number;
  /** The newest thing they did, when anything is kept. */
  last?: { at: string; kind: string };
};

export type PeoplePage = { at: string; people: PersonRow[] };

/** A job on a person's page: Helix's number, or a local job's own id. */
export type PersonJob = { id: number | string } & Pick<DisplayJob, 'title' | 'repo' | 'state' | 'submitted'> & Partial<Pick<DisplayJob, 'outcome' | 'pr' | 'cost_usd' | 'tokens'>>;

/** What a person's runs used: cost and tokens in all, by model, by role, and by day over the last USAGE_DAYS days. */
export type Usage = {
  runs: number;
  cost_usd: number;
  tokens: TokenCount;
  models: { model: string; sessions: number; cost_usd: number; tokens: number }[];
  roles: { role: string; sessions: number; cost_usd: number; tokens: number }[];
  days: { day: string; cost_usd: number; tokens: number }[];
};

/** How many days a person's page charts. */
export const USAGE_DAYS = 30;

/** The most jobs a person's page is sent at a time. */
export const PERSON_JOBS = 30;

/**
 * One person's page: from Helix, GET /people/<name>/page-data, with a
 * person's token. `jobs` are newest first, at most PERSON_JOBS, those before
 * the job in `?before=`; `more` says older ones remain. `left` is there for
 * someone no longer on Helix, with when they left if that was kept.
 */
export type PersonPage = PersonRow & {
  /** The source's clock, as in Display. */
  at: string;
  left?: { at?: string };
  jobList: PersonJob[];
  more: boolean;
  /** Everything they did that Helix kept, newest first. */
  activity: { at: string; kind: string; detail?: Record<string, string | number> }[];
  /** What their runs used, from their run log; left out where none is kept. */
  usage?: Usage;
};

/** What a job's pull request became, as the Jobs page knows it: left out when GitHub has not said. */
export type PrState = 'open' | 'merged' | 'closed';

/** The most jobs the Jobs page is sent at a time. */
export const JOB_LIST = 30;

/**
 * The Jobs page's data: from Helix, GET /job-list, with a person's token, and
 * from the local display without one. `jobs` are newest first, at most
 * JOB_LIST, those submitted before `?before=`; `more` says older ones remain.
 */
export type JobListPage = { at: string; jobs: ListJob[]; more: boolean; totals: JobTotals };

/** A job on the Jobs page: with what GitHub (locally, outcomes.json) said of its PR, and when it merged. */
export type ListJob = DisplayJob & { pr_state?: PrState; pr_merged?: string };

/** Everything the filters match, not only the rows sent. */
export type JobTotals = { jobs: number; merged: number; failed: number; cost_usd: number; tokens: number };

/** One run-log line as the Insights page needs it: the task class, how it ended, what it cost, its gates, agents and review. */
export type InsightsRun = {
  job: string; repo: string; size: string; difficulty: string; type: string; ended: string;
  outcome: string; cause?: string; cost_usd: number;
  /** Wall time of the whole run, in ms. */
  ms: number;
  pr?: string; fix_rounds: number;
  /** Each gate run: whether it passed (a flaky check counts as passed) and the checks that were flaky. */
  gates: { ok: boolean; flaky: string[] }[];
  /** Each agent session, with its tool calls from the run log's `tools` summary; `calls` and `errors` are left out when the session recorded none. */
  agents: { role: string; tier: string; cost_usd: number; calls?: number; errors?: number }[];
  review: { findings: number; acted_on: number } | null;
};

/** What became of a pull request, as outcomes.json says. */
export type InsightsOutcome = { state: 'OPEN' | 'MERGED' | 'CLOSED'; human_commits: number; reverted?: boolean; reworked?: boolean };

/** A lesson that is waiting for a yes or kept; `expires` is when a kept one runs out (lessons.ts expiresAt). */
export type InsightsLesson = { id: number; text: string; scope: 'project' | 'factory'; project: string; cites: string[]; status: 'proposed' | 'kept'; uses: number; expires: string };

/**
 * The Insights page's data: from Helix, GET /insights-data?scope=, with a
 * person's token, and from the local display without one. `scope` is
 * `factory` or a project's name; `runs` are those of the last 60 days that
 * ended in it, `outcomes` those of their PRs, `lessons` the ones in scope.
 */
export type InsightsPage = { at: string; scope: string; projects: string[]; runs: InsightsRun[]; outcomes: Record<string, InsightsOutcome>; lessons: InsightsLesson[] };
