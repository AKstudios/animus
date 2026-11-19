// Which page the display's address names, the person's token, and what a job
// page says when it cannot show the job. Every page is the same index.html;
// the script draws the one the path names. The token is kept in the
// browser's storage under one key and read on every request. Storage can be
// missing or refuse (a locked-down browser), so every read and write is
// guarded: without it the person is signed out. No DOM here, so it is tested
// without a browser (helix/test/display-pages.test.ts).

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

/** The browser's storage: a function, since even reaching it can throw. */
export type Kept = () => Pick<Storage, 'getItem' | 'setItem' | 'removeItem'>;

const KEY = 'helix-token';

export function readToken(storage: Kept): string | null {
  try { return storage().getItem(KEY) || null; } catch { return null; }
}

/** Keeps a token; false when there is none or the browser will not keep it. */
export function keepToken(storage: Kept, token: string): boolean {
  const t = token.trim();
  if (!t) return false;
  try { storage().setItem(KEY, t); return true; } catch { return false; }
}

export function forgetToken(storage: Kept): void {
  try { storage().removeItem(KEY); } catch { /* nothing was kept */ }
}

/** Keeps a token given in the address as #token=…; true when there was one, and the address must lose it whether it was kept or not. */
export function takeToken(hash: string, storage: Kept): boolean {
  const given = /^#token=(.*)$/.exec(hash)?.[1];
  if (given === undefined) return false;
  try { keepToken(storage, decodeURIComponent(given)); } catch { /* does not decode: not kept */ }
  return true;
}

/** What a job page says in place of the job, or nothing when it has the job. `status` is how Helix answered for its data. */
export function jobNotice(id: number | string, signedIn: boolean, status?: number, local = false): { signIn: boolean; text: string } | undefined {
  // The local display has no sign-in: its job pages are read as they are.
  if (local) return status === 404 ? { signIn: false, text: `This machine has no job ${id}.` } : undefined;
  if (!signedIn) {
    return { signIn: true, text: status === 401 ? `Helix did not take that token, so this browser forgot it. Sign in again to see job #${id}.` : `Sign in to see job #${id}. Paste your Helix token: animus join kept it in ~/.animus/helix.json.` };
  }
  if (status === 404) return { signIn: false, text: `Helix has no job #${id}.` };
  return undefined;
}

/** A person's own page. */
export const personPage = (name: string) => `/people/${encodeURIComponent(name)}`;

/** What the people list says in place of the list, or nothing when it has it. `status` is how Helix answered for its data. */
export function peopleNotice(signedIn: boolean, status?: number, local = false): string | undefined {
  if (local || signedIn) return undefined;
  return status === 401 ? 'Helix did not take that token, so this browser forgot it. Sign in again to see who is on this Helix.' : 'Sign in to see who is on this Helix. Paste your Helix token: animus join kept it in ~/.animus/helix.json.';
}

/** What a person's page says in place of the person, or nothing when it has them. `status` is how Helix answered for its data. */
export function personNotice(name: string, signedIn: boolean, status?: number, local = false): string | undefined {
  if (local) return status === 404 ? `No job on this machine names ${name}.` : undefined;
  if (!signedIn) {
    return status === 401 ? `Helix did not take that token, so this browser forgot it. Sign in again to see ${name}.` : `Sign in to see ${name}. Paste your Helix token: animus join kept it in ~/.animus/helix.json.`;
  }
  return status === 404 ? `Helix has never heard of ${name}.` : undefined;
}

/** What the Jobs page says in place of the list, or nothing when it has it. `status` is how Helix answered for its data. */
export function jobsNotice(signedIn: boolean, status?: number, local = false): string | undefined {
  if (local || signedIn) return undefined;
  return status === 401 ? 'Helix did not take that token, so this browser forgot it. Sign in again to see every job.' : 'Sign in to see every job. Paste your Helix token: animus join kept it in ~/.animus/helix.json.';
}

/** What the Insights page says in place of its numbers, or nothing when it has them. `status` is how Helix answered for its data. */
export function insightsNotice(signedIn: boolean, status?: number, local = false): string | undefined {
  if (local || signedIn) return undefined;
  return status === 401 ? 'Helix did not take that token, so this browser forgot it. Sign in again to see Insights.' : 'Sign in to see Insights. Paste your Helix token: animus join kept it in ~/.animus/helix.json.';
}
