// The display's own files (helix/ui), served as they are: no build step.
// Its scripts are TypeScript like everything else here, with their types
// stripped as they are sent. They hold no data: every number on the display
// comes from /display, which needs a token.
import { existsSync, readFileSync, statSync } from 'node:fs';
import { stripTypeScriptTypes } from 'node:module';
import { dirname, extname, join } from 'node:path';
import { fileURLToPath } from 'node:url';

const UI = join(dirname(fileURLToPath(import.meta.url)), '..', 'ui');

const TYPES: Record<string, string> = {
  '.html': 'text/html; charset=utf-8',
  '.css': 'text/css; charset=utf-8',
  '.ts': 'text/javascript; charset=utf-8',
  '.woff2': 'font/woff2',
};

export type Asset = { type: string; body: Buffer | string; cache: string };

const stripped = new Map<string, { mtime: number; text: string }>();

/** The file a path names, or nothing: only names in helix/ui and its fonts folder, never a path that climbs out. */
export function asset(pathname: string): Asset | undefined {
  const name = pathname === '/' ? 'index.html' : /^\/ui\/((?:fonts\/)?[A-Za-z0-9][A-Za-z0-9._-]*)$/.exec(pathname)?.[1];
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
