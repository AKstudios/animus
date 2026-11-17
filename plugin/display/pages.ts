// Which page the display's address names, the person's token, and what a job
// page says when it cannot show the job. Every page is the same index.html;
// the script draws the one the path names. The token is kept in the
// browser's storage under one key and read on every request. Storage can be
// missing or refuse (a locked-down browser), so every read and write is
// guarded: without it the person is signed out. No DOM here, so it is tested
// without a browser (helix/test/display-pages.test.ts).

export type Route = { page: 'overview' } | { page: 'job'; id: number } | { page: 'people'; name?: string };

/** A job's own page. */
export const jobPage = (id: number) => `/jobs/${id}`;

export function route(pathname: string): Route {
  const job = /^\/jobs\/(\d+)$/.exec(pathname);
  if (job) return { page: 'job', id: Number(job[1]) };
  const people = /^\/people(?:\/([^/]+))?$/.exec(pathname);
  try {
    if (people) return people[1] ? { page: 'people', name: decodeURIComponent(people[1]) } : { page: 'people' };
  } catch { /* a name that does not decode: the overview */ }
  return { page: 'overview' };
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
export function jobNotice(id: number, signedIn: boolean, status?: number): { signIn: boolean; text: string } | undefined {
  if (!signedIn) {
    return { signIn: true, text: status === 401 ? `Helix did not take that token, so this browser forgot it. Sign in again to see job #${id}.` : `Sign in to see job #${id}. Paste your Helix token: animus join kept it in ~/.animus/helix.json.` };
  }
  if (status === 404) return { signIn: false, text: `Helix has no job #${id}.` };
  return undefined;
}
