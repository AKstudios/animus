// spec.md: what one job builds. A YAML header carries the labels the
// spec-shaping agent proposed (size, difficulty, type), where the person can
// change them; the body has an "Acceptance criteria" list, and a `$ command`
// line under a criterion is the check that proves it.
import { existsSync, readFileSync } from 'node:fs';
import { basename } from 'node:path';
import { parse } from 'yaml';
import { isRecord, isStrings } from './profile.ts';
import { DIFFICULTIES, SIZES, type Difficulty, type Labels, type Size } from './profiles.ts';
import { AnimusError } from './proc.ts';

export type Criterion = { text: string; commands: string[] };

export type Spec = Labels & {
  title: string;
  /** The branch the job starts from, when not the profile's. */
  base?: string;
  /** For a ui spec: the profile's target and the pages to show. */
  ui: { target?: string; pages: string[] };
  /** Spec files whose pull requests must be merged before this job starts. */
  after: string[];
  /** Design references, repo-relative. */
  design: string[];
  criteria: Criterion[];
  /** The whole file, as the agents read it. */
  text: string;
  /** Labels the header left out, filled with the defaults (medium, routine, feature). */
  defaulted: string[];
};

const ITEM = /^\s{0,3}(?:[-*+]|\d+[.)])\s+(?:\[[ xX]\]\s+)?(.*)$/;
const COMMAND = /^\s*`?\$\s+(.+?)`?\s*$/;

export function loadSpec(file: string): Spec {
  if (!existsSync(file)) throw new AnimusError(`no spec at ${file}`);
  return parseSpec(readFileSync(file, 'utf8'), basename(file));
}

const HEADER_KEYS = ['title', 'size', 'difficulty', 'type', 'base', 'ui', 'after', 'design'];
const UI_KEYS = ['target', 'pages'];

/** The word in `known` closest to `key`, when it is a likely misspelling of it. */
function nearest(key: string, known: readonly string[]): string | undefined {
  const distance = (a: string, b: string) => {
    let row = Array.from({ length: b.length + 1 }, (_, j) => j);
    for (let i = 1; i <= a.length; i++) {
      const next = [i];
      for (let j = 1; j <= b.length; j++) next[j] = Math.min(row[j]! + 1, next[j - 1]! + 1, row[j - 1]! + (a[i - 1] === b[j - 1] ? 0 : 1));
      row = next;
    }
    return row[b.length]!;
  };
  const best = known.map((k) => ({ k, d: distance(key.toLowerCase(), k) })).sort((x, y) => x.d - y.d)[0];
  return best && best.d <= 2 ? best.k : undefined;
}

/**
 * Reads a spec. A spec that is wrong throws; given `problems`, every
 * problem is collected there instead and a stand-in used, and the header is
 * also held to its keys: that is how a spec being admitted is read (admit.ts).
 * Without it a header is read leniently, as for the earlier specs `after:` names.
 */
export function parseSpec(text: string, name = 'spec.md', problems?: string[]): Spec {
  const fail = (what: string): void => {
    if (!problems) throw new AnimusError(`${name}: ${what}`);
    problems.push(what);
  };
  let header: Record<string, unknown> = {};
  let body = text;
  const m = /^---\r?\n([\s\S]*?)\r?\n---\r?\n?/.exec(text);
  if (m) {
    body = text.slice(m[0].length);
    let raw: unknown = {};
    try { raw = parse(m[1]!) ?? {}; } catch (err) { fail(`its header is not YAML: ${(err as Error).message}`); }
    if (isRecord(raw)) header = raw; else fail('its header must be a mapping (size, difficulty, type)');
  }
  if (problems) {
    const unknown = (keys: readonly string[], found: Record<string, unknown>, where: string) => {
      for (const key of Object.keys(found).filter((k) => !keys.includes(k))) {
        const hint = nearest(key, keys);
        fail(`${where}${key} is not a key of a spec's header${hint ? `: did you mean ${where}${hint}?` : ''} (it takes ${keys.map((k) => `${where}${k}`).join(', ')})`);
      }
    };
    unknown(HEADER_KEYS, header, '');
    if (isRecord(header.ui)) unknown(UI_KEYS, header.ui, 'ui.');
  }
  const defaulted: string[] = [];
  const label = <T extends string>(key: string, allowed: readonly T[] | undefined, fallback: T): T => {
    const v = header[key];
    if (v === undefined) { defaulted.push(key); return fallback; }
    if (typeof v !== 'string' || (allowed && !allowed.includes(v as T))) { fail(`${key} must be ${allowed ? `one of ${allowed.join(', ')}` : 'a word'}`); return fallback; }
    return v as T;
  };
  const size = label<Size>('size', SIZES, 'medium');
  const difficulty = label<Difficulty>('difficulty', DIFFICULTIES, 'routine');
  const type = label<string>('type', undefined, 'feature');

  const heading = /^#\s+(.+)$/m.exec(body)?.[1]?.trim();
  let title = typeof header.title === 'string' ? header.title.trim() : heading;
  if (!title) { fail('needs a title: `title:` in the header, or a first-level heading'); title = 'untitled'; }

  const spec: Spec = { title, size, difficulty, type, ui: { pages: [] }, after: [], design: [], criteria: criteria(body), text, defaulted };
  if (header.base !== undefined) {
    if (typeof header.base !== 'string') fail('base must be a branch name');
    else spec.base = header.base;
  }
  if (header.ui !== undefined) {
    if (!isRecord(header.ui)) fail('ui must be a mapping: { target, pages }');
    else {
      if (header.ui.target !== undefined && typeof header.ui.target !== 'string') fail('ui.target must be the name of a ui target in the profile');
      if (typeof header.ui.target === 'string') spec.ui.target = header.ui.target;
      const pages = typeof header.ui.pages === 'string' ? [header.ui.pages] : header.ui.pages ?? [];
      if (!isStrings(pages)) fail('ui.pages must list page names from the profile, or paths starting with /');
      else spec.ui.pages = pages;
    }
  }
  if (header.after !== undefined) {
    const after = typeof header.after === 'string' ? [header.after] : header.after;
    if (!isStrings(after)) fail('after must name the spec file (or files) this one runs after');
    else spec.after = after;
  }
  if (header.design !== undefined) {
    const design = typeof header.design === 'string' ? [header.design] : header.design;
    if (!isStrings(design)) fail('design must list files or folders in the repo');
    else spec.design = design;
  }
  if (!spec.criteria.length) fail('needs an "Acceptance criteria" heading with a list under it; each item is one criterion, and a `$ command` line under it is its check');
  return spec;
}

/** The list under the "Acceptance criteria" heading, up to the next heading of its level or above. */
function criteria(body: string): Criterion[] {
  const lines = body.split(/\r?\n/);
  const start = lines.findIndex((l) => /^#{1,6}\s+acceptance criteria\b/i.test(l));
  if (start < 0) return [];
  const level = /^#+/.exec(lines[start]!)![0].length;
  const out: Criterion[] = [];
  let fenced = false;
  for (const line of lines.slice(start + 1)) {
    if (/^\s*```/.test(line)) { fenced = !fenced; continue; }
    const h = /^(#+)\s/.exec(line);
    if (h && !fenced && h[1]!.length <= level) break;
    const command = COMMAND.exec(line);
    const item = fenced ? null : ITEM.exec(line);
    const last = out.at(-1);
    if (item && !/^\s{4,}/.test(line)) {
      const inline = COMMAND.exec(item[1]!);
      if (inline && last) last.commands.push(inline[1]!);
      else out.push({ text: item[1]!.trim(), commands: [] });
    } else if (command && last) last.commands.push(command[1]!);
    else if (item && last) {
      const nested = COMMAND.exec(item[1]!);
      if (nested) last.commands.push(nested[1]!);
      else last.text += ` ${item[1]!.trim()}`;
    } else if (line.trim() && last && !fenced) last.text += ` ${line.trim()}`;
  }
  return out;
}
