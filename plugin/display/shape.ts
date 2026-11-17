// What the display page reads from its source (ADR 0004): Helix's /display
// answers this shape. It lives with the page, since the plugin never imports
// Helix.
import type { Progress } from '../src/log.ts';
import type { Review } from '../src/review.ts';

/** A job as the display sees it: Helix's row without what is only Helix's business (the spec's path, the pid, the answer's text). */
export type DisplayJob = {
  id: number;
  state: 'queued' | 'running' | 'ended' | 'cancelled';
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
  reason?: string;
  question?: string;
  cost_usd?: number;
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
  /** Every review round, first to last. */
  reviews?: Pick<Review, 'summary' | 'findings'>[];
  /** Every question the job asked, with the answer it was given; the one it waits on has none. */
  questions?: { question: string; answer?: string }[];
  /** What the job's run has printed, all of it. */
  log: string;
};

export type DisplayRepo ={ name: string; base?: string; gates?: string[] };

export type Display = {
  name: string;
  /** The source's clock, so a display with another clock still counts elapsed time right. */
  at: string;
  slots: number;
  stages: readonly string[];
  repos: DisplayRepo[];
  jobs: DisplayJob[];
};
