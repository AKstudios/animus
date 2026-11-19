// What the people list says, worked out from what Helix sent: each person's
// numbers as they are shown. No DOM here, so the wording is tested without a
// browser (helix/test/person-page.test.ts), as view.ts is.
import { OUTCOMES, when } from './job-view.ts';
import { jobPage, personPage } from './pages.ts';
import type { PeoplePage, PersonPage, Usage } from './shape.ts';
import { tokens } from './view.ts';

export type PeopleRow = { name: string; page: string; github: string; joined: string; jobs: string; prs: string; spent: string; last: string };

/** What each kind of activity is called on a page. */
export const KINDS: Record<string, string> = {
  submitted: 'submitted a job', answered: 'answered a job', cancelled: 'cancelled a job', joined: 'joined',
  left: 'left', 'project-added': 'added a project', 'project-removed': 'removed a project',
  drafted: 'started a draft', 'draft-revised': 'revised a draft', 'draft-discarded': 'discarded a draft','channel-project': 'set a channel\'s project',
};

export function peopleView(p: PeoplePage): { rows: PeopleRow[] } {
  return { rows: p.people.map((x) => ({
    name: x.name, page: personPage(x.name), github: x.github ?? '',
    // Blank for a person who joined before the day was kept.
    joined: x.joined?.slice(0, 10) ?? '',
    jobs: String(x.jobs), prs: String(x.prs), spent: `$${x.spent.toFixed(2)}`,
    last: x.last ? `${when(x.last.at)} · ${KINDS[x.last.kind] ?? x.last.kind}` : '',
  })) };
}

export type PersonView = {
  name: string;
  /** Said when the person is no longer on Helix. */
  left?: string;
  facts: { k: string; v: string }[];
  jobs: { id: number | string; title: string; page: string; repo: string; tag: string; submitted: string; href?: string; /** Cost and tokens, where its runs said. */ used: string }[];
  more: boolean;
  activity: { when: string; text: string; page?: string; note?: string }[];
  /** What their runs used, left out where no run log is kept for them. */
  usage?: UsageView;
};

/** A person's usage as strings ready to draw: totals, then by model and by role with each one's share of the cost, then a bar per day. */
export type UsageView = {
  totals: { k: string; v: string }[];
  /** Input, output and cache, each with its share of all tokens. */
  split: { k: string; v: string; pct: number }[];
  models: { name: string; sessions: string; cost: string; tokens: string; pct: number }[];
  roles: { name: string; sessions: string; cost: string; tokens: string; pct: number }[];
  /** One per day, oldest first: its height as a share of the busiest day's cost. */
  days: { day: string; label: string; cost: string; tokens: string; pct: number }[];
};

const usd = (n: number) => `$${n.toFixed(2)}`;
const MONTHS = ['Jan', 'Feb', 'Mar', 'Apr', 'May', 'Jun', 'Jul', 'Aug', 'Sep', 'Oct', 'Nov', 'Dec'];

export function usageView(u: Usage): UsageView {
  const all = u.tokens.input + u.tokens.output + u.tokens.cache_read + u.tokens.cache_write;
  const share = (n: number, of: number) => (of ? Math.round((n / of) * 1000) / 10 : 0);
  const row = (x: { sessions: number; cost_usd: number; tokens: number }) => ({ sessions: `${x.sessions} ${x.sessions === 1 ? 'session' : 'sessions'}`, cost: usd(x.cost_usd), tokens: tokens(x.tokens), pct: share(x.cost_usd, u.cost_usd) });
  const top = Math.max(0, ...u.days.map((d) => d.cost_usd));
  const split: [string, number][] = [['input', u.tokens.input], ['output', u.tokens.output], ['cache read', u.tokens.cache_read], ['cache written', u.tokens.cache_write]];
  return {
    totals: [
      { k: 'runs', v: String(u.runs) }, { k: 'spent', v: usd(u.cost_usd) }, { k: 'tokens', v: tokens(all) },
      { k: 'per run', v: u.runs ? usd(u.cost_usd / u.runs) : '–' },
    ],
    split: split.map(([k, n]) => ({ k, v: tokens(n), pct: share(n, all) })),
    models: u.models.map((m) => ({ name: m.model || 'unknown', ...row(m) })),
    roles: u.roles.map((r) => ({ name: r.role, ...row(r) })),
    days: u.days.map((d) => ({ day: d.day, label: `${MONTHS[Number(d.day.slice(5, 7)) - 1]} ${Number(d.day.slice(8, 10))}`, cost: usd(d.cost_usd), tokens: tokens(d.tokens), pct: top ? share(d.cost_usd, top) : 0 })),
  };
}

/** What one activity says, with the job it names as a link and an answer's text as its note. */
function said(a: PersonPage['activity'][number]): PersonView['activity'][number] {
  const d = a.detail ?? {};
  const job = typeof d.job === 'number' ? d.job : undefined;
  const text = [KINDS[a.kind] ?? a.kind, job !== undefined ? `#${job}` : '', typeof d.repo === 'string' ? `for ${d.repo}` : '', typeof d.project === 'string' ? d.project : ''].filter(Boolean).join(' ');
  return { when: when(a.at), text, ...(job !== undefined ? { page: jobPage(job) } : {}), ...(typeof d.answer === 'string' ? { note: d.answer } : {}) };
}

/** A person's page for what Helix sent, plus the jobs read after it (older ones) and whether more are left after those. */
export function personView(p: PersonPage, older: { jobs: PersonPage['jobList']; more: boolean } = { jobs: [], more: p.more }): PersonView {
  const row = peopleView({ at: p.at, people: [p] }).rows[0]!;
  return {
    name: p.name,
    ...(p.left ? { left: p.left.at ? `${p.name} left Helix on ${p.left.at.slice(0, 10)}.` : `${p.name} has left Helix.` } : {}),
    facts: [
      ...(row.github ? [{ k: 'github', v: row.github }] : []), ...(row.joined ? [{ k: 'joined', v: row.joined }] : []),
      { k: 'jobs', v: row.jobs }, { k: 'PRs opened', v: row.prs }, { k: 'spent', v: row.spent }, ...(row.last ? [{ k: 'last activity', v: row.last }] : []),
    ],
    jobs: [...p.jobList, ...older.jobs].map((j) => ({
      id: j.id, title: j.title, page: jobPage(j.id), repo: j.repo, submitted: when(j.submitted, Date.parse(p.at)),
      used: [j.cost_usd !== undefined ? usd(j.cost_usd) : '', j.tokens ? `${tokens(j.tokens)} tokens` : ''].filter(Boolean).join(' · '),
      tag: (j.state === 'ended' && j.outcome ? OUTCOMES[j.outcome] ?? j.outcome : j.state),
      ...(j.pr && /^https?:\/\//.test(j.pr) ? { href: j.pr } : {}),
    })),
    more: older.jobs.length ? older.more : p.more,
    activity: p.activity.map(said),
    ...(p.usage ? { usage: usageView(p.usage) } : {}),
  };
}

/**
 * The older jobs to keep when the newest thirty are read again after SHOW MORE:
 * a job a newer one has pushed out of the newest thirty joins them, so no job
 * falls between the two lists.
 */
export function keepOlder(before: PersonPage, older: PersonPage['jobList'], next: PersonPage): PersonPage['jobList'] {
  const last = next.jobList.at(-1);
  // Helix's jobs are numbered in order; a local job's id is a name, so its time decides.
  const isOlder = (j: PersonPage['jobList'][number]) => !last || (typeof j.id === 'number' && typeof last.id === 'number' ? j.id < last.id : j.submitted < last.submitted);
  return [...before.jobList.filter(isOlder), ...older];
}
