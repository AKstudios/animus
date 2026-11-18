// What the people list says, worked out from what Helix sent: each person's
// numbers as they are shown. No DOM here, so the wording is tested without a
// browser (helix/test/person-page.test.ts), as view.ts is.
import { OUTCOMES, when } from './job-view.ts';
import { jobPage, personPage } from './pages.ts';
import type { PeoplePage, PersonPage } from './shape.ts';

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
  jobs: { id: number; title: string; page: string; repo: string; tag: string; submitted: string; href?: string }[];
  more: boolean;
  activity: { when: string; text: string; page?: string; note?: string }[];
};

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
      id: j.id, title: j.title, page: jobPage(j.id), repo: j.repo, submitted: when(j.submitted),
      tag: (j.state === 'ended' && j.outcome ? OUTCOMES[j.outcome] ?? j.outcome : j.state),
      ...(j.pr && /^https?:\/\//.test(j.pr) ? { href: j.pr } : {}),
    })),
    more: older.jobs.length ? older.more : p.more,
    activity: p.activity.map(said),
  };
}

/**
 * The older jobs to keep when the newest thirty are read again after SHOW MORE:
 * a job a newer one has pushed out of the newest thirty joins them, so no job
 * falls between the two lists.
 */
export function keepOlder(before: PersonPage, older: PersonPage['jobList'], next: PersonPage): PersonPage['jobList'] {
  const oldest = next.jobList.at(-1)?.id ?? Infinity;
  return [...before.jobList.filter((j) => j.id < oldest), ...older];
}
