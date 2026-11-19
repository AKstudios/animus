// The Jobs page, worked out without the DOM (helix/test/job-list.test.ts):
// which jobs a filter keeps, thirty at a time, and each row's tag and words.
import { JOB_LIST, type JobListPage, type JobTotals, type ListJob } from './shape.ts';
import { recent, span, type Recent } from './view.ts';

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

const keeps = (j: ListJob, result: Result): boolean => {
  if (result === 'merged') return j.pr_state === 'merged';
  if (result === 'open') return j.pr_state === 'open';
  if (result === 'needs input') return j.state === 'ended' && j.outcome === 'needs-input';
  if (result === 'failed') return j.state === 'stopped' || (j.state === 'ended' && (j.outcome ?? 'failed') === 'failed');
  return true;
};

/**
 * One page of the Jobs page: the jobs (any order) that pass the filter,
 * newest first, the JOB_LIST submitted before `before`; `totals` count all
 * that pass the filter. `person` is ignored when the source has no people (the local display).
 */
export function listJobs(jobs: readonly ListJob[], f: Partial<JobFilter>, before?: string): Pick<JobListPage, 'jobs' | 'more' | 'totals'> {
  const matched = jobs
    .filter((j) => keeps(j, f.result ?? 'all') && (!f.project || j.repo === f.project) && (!f.person || j.person === f.person))
    .sort((a, b) => (a.submitted < b.submitted ? 1 : a.submitted > b.submitted ? -1 : 0));
  const older = matched.filter((j) => before === undefined || j.submitted < before);
  const totals: JobTotals = {
    jobs: matched.length, merged: matched.filter((j) => j.pr_state === 'merged').length,
    failed: matched.filter((j) => keeps(j, 'failed')).length, cost_usd: matched.reduce((sum, j) => sum + (j.cost_usd ?? 0), 0),
  };
  return { jobs: older.slice(0, JOB_LIST), more: older.length > JOB_LIST, totals };
}

/** A row of the table: the finished list's tag, with a PR as GitHub last said; took, cost and to merge are `—` when unknown. */
export type JobRow = Recent & { submitted: string; took: string; /** Times the gates sent the work back; — before they ran. */ fixes: string; cost: string; toMerge: string; /** Under the title. */ why?: string };

/** The totals above the table, as strings ready to draw. */
export type Totals = { jobs: string; merged: string; mergedShare: string; failed: string; spent: string; perMerged: string };

export type JobListView = { rows: JobRow[]; /** The row each day heading goes before. */ days: { at: number; heading: string }[]; more: boolean; totals: Totals };

const usd = (n: number) => `$${n.toFixed(2)}`;
const DAYS = ['Sun', 'Mon', 'Tue', 'Wed', 'Thu', 'Fri', 'Sat'];
const MONTHS = ['Jan', 'Feb', 'Mar', 'Apr', 'May', 'Jun', 'Jul', 'Aug', 'Sep', 'Oct', 'Nov', 'Dec'];

/** A day's heading, in the viewer's own time: Today, Yesterday, then `Mon 16 Nov`. */
export function dayHeading(iso: string, now: number): string {
  const d = new Date(iso);
  const n = new Date(now);
  const ago = Math.round((Date.UTC(n.getFullYear(), n.getMonth(), n.getDate()) - Date.UTC(d.getFullYear(), d.getMonth(), d.getDate())) / 86_400_000);
  return ago === 0 ? 'Today' : ago === 1 ? 'Yesterday' : `${DAYS[d.getDay()]} ${d.getDate()} ${MONTHS[d.getMonth()]}`;
}

export function jobListView(p: JobListPage, local: boolean, now = Date.parse(p.at)): JobListView {
  const rows = p.jobs.map((j): JobRow => {
    const { personPage: link, ...row } = recent(j, false);
    const n = j.pr && /(\d+)\/?$/.exec(j.pr)?.[1];
    const tag = n && j.pr_state ? `${j.pr_state === 'open' ? 'Open' : j.pr_state === 'merged' ? 'Merged' : 'Closed'} #${n}` : row.tag;
    const why = j.state === 'running' ? (j.progress ? j.progress.stage[0]!.toUpperCase() + j.progress.stage.slice(1) : 'Starting')
      : j.state === 'ended' && j.outcome === 'needs-input' ? j.question ?? 'It stopped to ask, and did not say what.'
      : j.pr_state === 'open' ? 'Waiting for review' : j.pr_state === 'closed' ? 'Closed without merging' : row.reason;
    const end = j.state === 'running' ? now : j.ended ? Date.parse(j.ended) : undefined;
    return {
      ...row, tag, tone: j.pr_state === 'closed' ? 'mute' : j.pr_state === 'merged' ? 'merged' : j.pr_state === 'open' ? 'open' : row.tone, submitted: j.submitted,
      took: j.started && end !== undefined ? span(end - Date.parse(j.started)) : '—',
      fixes: j.fix_rounds === undefined ? '—' : String(j.fix_rounds),
      cost: j.cost_usd !== undefined ? usd(j.cost_usd) : '—',
      toMerge: j.pr_merged && j.ended ? span(Date.parse(j.pr_merged) - Date.parse(j.ended)) : '—',
      ...(why ? { why } : {}), ...(local || !link ? {} : { personPage: link }),
    };
  });
  const days = rows.flatMap((r, at) => {
    const heading = dayHeading(r.submitted, now);
    return at && heading === dayHeading(rows[at - 1]!.submitted, now) ? [] : [{ at, heading }];
  });
  const t = p.totals;
  return { rows, days, more: p.more, totals: {
    jobs: String(t.jobs), merged: String(t.merged), mergedShare: t.jobs ? `${Math.round((t.merged / t.jobs) * 100)}%` : '—', failed: String(t.failed),
    spent: usd(t.cost_usd), perMerged: t.merged ? usd(t.cost_usd / t.merged) : '—',
  } };
}
