// The display's own files, served as they are: no build step. They are the
// plugin's (plugin/display, ADR 0004), so Helix and a laptop show the same
// page. Its scripts are TypeScript like everything else here, with their types
// stripped as they are sent. They hold no data: every number on the display
// comes from /display, or a job page's from /jobs/<id>/page-data.
import { existsSync, readFileSync, statSync } from 'node:fs';
import { stripTypeScriptTypes } from 'node:module';
import { dirname, extname, join } from 'node:path';
import { fileURLToPath } from 'node:url';

const UI = join(dirname(fileURLToPath(import.meta.url)), '..', 'display');

/** The display loads only what its source serves and talks only to it. A job's screenshots are fetched by the page and shown as blobs. */
export const CSP = "default-src 'none'; script-src 'self'; style-src 'self'; font-src 'self'; img-src 'self' data: blob:; connect-src 'self'; base-uri 'none'; form-action 'none'";

const TYPES: Record<string, string> = {
  '.html': 'text/html; charset=utf-8',
  '.css': 'text/css; charset=utf-8',
  '.ts': 'text/javascript; charset=utf-8',
  '.woff2': 'font/woff2',
};

export type Asset = { type: string; body: Buffer | string; cache: string };

const stripped = new Map<string, { mtime: number; text: string }>();

/** The display's pages besides `/`: each is the same index.html, and its script draws the one the path names (pages.ts). */
const PAGES = /^\/(?:jobs(?:\/[^/]+)?|people(?:\/[^/]+)?)$/;

/**
 * The file a path names, or nothing: only names in plugin/display and its
 * fonts folder, never a path that climbs out. A page other than `/` is sent
 * only to a browser asking for HTML, since `/jobs/<id>` is also Helix's API.
 */
export function asset(pathname: string, accept = ''): Asset | undefined {
  const page = pathname === '/' || (PAGES.test(pathname) && accept.includes('text/html'));
  const name = page ? 'index.html' : /^\/ui\/((?:fonts\/)?[A-Za-z0-9][A-Za-z0-9._-]*)$/.exec(pathname)?.[1];
  if (!name) return undefined;
  const type = TYPES[extname(name)];
  const file = join(UI, name);
  if (!type || !existsSync(file)) return undefined;
  if (type === 'font/woff2') return { type, body: readFileSync(file), cache: 'public, max-age=604800' };
  if (extname(name) !== '.ts') return { type, body: readFileSync(file, 'utf8'), cache: 'no-cache' };
  const mtime = statSync(file).mtimeMs;
  let known = stripped.get(file);
  if (!known || known.mtime !== mtime) {
    known = { mtime, text: stripTypeScriptTypes(readFileSync(file, 'utf8')) };
    stripped.set(file, known);
  }
  return { type, body: known.text, cache: 'no-cache' };
}
