// What the people list says, worked out from what Helix sent: each person's
// numbers as they are shown. No DOM here, so the wording is tested without a
// browser (helix/test/person-page.test.ts), as view.ts is.
import { when } from './job-view.ts';
import { personPage } from './pages.ts';
import type { PeoplePage } from './shape.ts';

export type PeopleRow = { name: string; page: string; github: string; joined: string; jobs: string; prs: string; spent: string; last: string };

/** What each kind of activity is called on a page. */
export const KINDS: Record<string, string> = {
  submitted: 'submitted a job', answered: 'answered a job', cancelled: 'cancelled a job', joined: 'joined',
  left: 'left', 'project-added': 'added a project', 'project-removed': 'removed a project',
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
