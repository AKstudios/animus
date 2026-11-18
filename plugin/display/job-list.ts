// The Jobs page, worked out without the DOM (helix/test/job-list.test.ts):
// which jobs a filter keeps, thirty at a time, and each row's tag and words.
import { JOB_LIST, type DisplayJob, type JobListPage, type PrState } from './shape.ts';
import { recent, type Recent } from './view.ts';

export const RESULTS = ['all', 'merged', 'open', 'failed', 'needs input'] as const;
export type Result = typeof RESULTS[number];
export type JobFilter = { result: Result; project: string; person: string };

/** The filters an address names: a result it does not know is `all`. */
export function filterOf(search: string): JobFilter {
  const q = new URLSearchParams(search);
  const result = q.get('result') as Result;
  return { result: RESULTS.includes(result) ? result : 'all', project: q.get('project') ?? '', person: q.get('person') ?? '' };
}

/** The query string of a filter, with only what is set, so `all` is the bare /jobs. */
export function queryOf(f: JobFilter): string {
  const q = new URLSearchParams(Object.entries(f).filter(([k, v]) => v && !(k === 'result' && v === 'all')));
  return q.size ? `?${q}` : '';
}

const keeps = (j: DisplayJob & { pr_state?: PrState }, result: Result): boolean => {
  if (result === 'merged') return j.pr_state === 'merged';
  if (result === 'open') return j.pr_state === 'open';
  if (result === 'needs input') return j.state === 'ended' && j.outcome === 'needs-input';
  if (result === 'failed') return j.state === 'stopped' || (j.state === 'ended' && (j.outcome ?? 'failed') === 'failed');
  return true;
};

/**
 * One page of the Jobs page: the jobs (any order) that pass the filter,
 * newest first, the JOB_LIST submitted before `before`. `person` is ignored
 * when the source has no people (the local display).
 */
export function listJobs(jobs: readonly (DisplayJob & { pr_state?: PrState })[], f: Partial<JobFilter>, before?: string): Pick<JobListPage, 'jobs' | 'more'> {
  const older = jobs
    .filter((j) => keeps(j, f.result ?? 'all') && (!f.project || j.repo === f.project) && (!f.person || j.person === f.person) && (before === undefined || j.submitted < before))
    .sort((a, b) => (a.submitted < b.submitted ? 1 : a.submitted > b.submitted ? -1 : 0));
  return { jobs: older.slice(0, JOB_LIST), more: older.length > JOB_LIST };
}

/** A row: the tag of the finished list, with a PR still open as `OPEN PR #n`. */
export type JobRow = Recent & { submitted: string };

export function jobListView(p: JobListPage, local: boolean): { rows: JobRow[]; more: boolean } {
  return { more: p.more, rows: p.jobs.map((j) => {
    const { personPage: link, ...row } = recent(j, false);
    const n = j.pr && /(\d+)\/?$/.exec(j.pr)?.[1];
    const tag = n && j.pr_state ? `${j.pr_state === 'open' ? 'OPEN PR' : j.pr_state === 'merged' ? 'MERGED' : 'CLOSED'} #${n}` : row.tag;
    return { ...row, tag, tone: j.pr_state === 'closed' ? 'mute' : row.tone, submitted: j.submitted, ...(local || !link ? {} : { personPage: link }) };
  }) };
}
