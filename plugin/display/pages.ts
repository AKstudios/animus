// Which page the display's address names, and what a job or person page says
// when it cannot show what it names. Every page is the same index.html; the
// script draws the one the path names. Every page reads without a sign-in. No
// DOM here, so it is tested without a browser
// (helix/test/display-pages.test.ts).

export type Route = { page: 'overview' } | { page: 'jobs' } | { page: 'insights' } | { page: 'job'; id: number | string } | { page: 'people'; name?: string };

/** A job's own page: Helix's job numbers, or a local job's own id. */
export const jobPage = (id: number | string) => `/jobs/${encodeURIComponent(id)}`;

export function route(pathname: string): Route {
  if (pathname === '/jobs') return { page: 'jobs' };
  if (pathname === '/insights') return { page: 'insights' };
  const job = /^\/jobs\/([^/]+)$/.exec(pathname);
  const people = /^\/people(?:\/([^/]+))?$/.exec(pathname);
  try {
    if (job) return { page: 'job', id: /^\d+$/.test(job[1]!) ? Number(job[1]) : decodeURIComponent(job[1]!) };
    if (people) return people[1] ? { page: 'people', name: decodeURIComponent(people[1]) } : { page: 'people' };
  } catch { /* a name that does not decode: the overview */ }
  return { page: 'overview' };
}

/** The page a person came to a job or person page from, as its back link names it. */
export type Origin = { name: string; href: string; page: Route['page'] };

/**
 * Where the back link of a job or person page goes: the display page in
 * `referrer` when it is this display's own (same `origin`), else nothing and
 * the page's default. The address keeps its filters and picked project.
 */
export function originOf(referrer: string, origin: string, here: string): Origin | undefined {
  let u: URL;
  try { u = new URL(referrer); } catch { return undefined; }
  if (u.origin !== origin || u.pathname === here) return undefined;
  const r = route(u.pathname);
  const href = u.pathname + u.search + u.hash;
  if (r.page === 'overview') return { name: 'Overview', href, page: r.page };
  if (r.page === 'jobs') return { name: 'Jobs', href, page: r.page };
  if (r.page === 'insights') return { name: 'Insights', href, page: r.page };
  if (r.page === 'people') return { name: r.name ?? 'People', href, page: r.page };
  return { name: typeof r.id === 'number' ? `Job #${r.id}` : r.id, href, page: r.page };
}

/** What a job page says in place of the job, or nothing when it has the job. `status` is how Helix answered for its data. */
export function jobNotice(id: number | string, status?: number, local = false): string | undefined {
  if (status !== 404) return undefined;
  return local ? `This machine has no job ${id}.` : `Helix has no job #${id}.`;
}

/** A person's own page. */
export const personPage = (name: string) => `/people/${encodeURIComponent(name)}`;

/** What a person's page says in place of the person, or nothing when it has them. `status` is how Helix answered for its data. */
export function personNotice(name: string, status?: number, local = false): string | undefined {
  if (status !== 404) return undefined;
  return local ? `No job on this machine names ${name}.` : `Helix has never heard of ${name}.`;
}
