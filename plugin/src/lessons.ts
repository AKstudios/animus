// Lessons (docs/specs/insights-2-lessons.md): short sentences a retro proposes
// from the run records and a person keeps or dismisses. They live in
// ANIMUS_HOME/lessons.json, outside every worktree, so no job can change
// them. Scripts decide everything here: ids, who may change what, expiry.
import { existsSync, readFileSync } from 'node:fs';
import { join } from 'node:path';
import { animusHome, writeJson } from './log.ts';
import { AnimusError } from './proc.ts';

export const SCOPES = ['project', 'factory'] as const;
export const LESSON_AGENTS = ['implementer', 'planner', 'reviewer', 'spec'] as const;
export const EXPIRES_DAYS = 60;
const DAY = 24 * 60 * 60 * 1000;

export type Lesson = {
  /** A short number, unique per Animus home and never used twice. */
  id: number;
  text: string;
  scope: (typeof SCOPES)[number];
  /** The project whose retro proposed it; a project lesson is given only there. */
  project: string;
  agent: (typeof LESSON_AGENTS)[number];
  /** The jobs it came from. */
  cites: string[];
  status: 'proposed' | 'kept' | 'dismissed';
  created: string;
  acceptedAt?: string;
  /** When a retro last said it saw the lesson again. */
  lastSeenAt?: string;
  /** Jobs it was given to. */
  uses: number;
};

type Store = { next: number; lessons: Lesson[] };

export const lessonsFile = () => join(animusHome(), 'lessons.json');

const load = (): Store => existsSync(lessonsFile()) ? JSON.parse(readFileSync(lessonsFile(), 'utf8')) as Store : { next: 1, lessons: [] };

export const readLessons = (): Lesson[] => load().lessons;

/** What a lesson is now: a kept one that nothing has refreshed for 60 days is expired. */
export function stateOf(l: Lesson, now: number): 'proposed' | 'kept' | 'expired' | 'dismissed' {
  if (l.status !== 'kept') return l.status;
  return now < expiresAt(l) ? 'kept' : 'expired';
}

/** 60 days after the lesson was accepted or last seen again. */
export const expiresAt = (l: Lesson): number => Math.max(Date.parse(l.acceptedAt ?? l.created), Date.parse(l.lastSeenAt ?? l.acceptedAt ?? l.created)) + EXPIRES_DAYS * DAY;

/** The lessons a project's retro is told about: its own, and every factory lesson. */
export const inScope = (l: Lesson, project: string) => l.scope === 'factory' || l.project === project;

/** Stores new proposals as proposed lessons, with their ids. */
export function addProposals(items: readonly Pick<Lesson, 'text' | 'scope' | 'project' | 'agent' | 'cites'>[], now: number): Lesson[] {
  const store = load();
  const added = items.map((i): Lesson => ({ ...i, id: store.next++, status: 'proposed', created: new Date(now).toISOString(), uses: 0 }));
  store.lessons.push(...added);
  writeJson(lessonsFile(), store);
  return added;
}

function change(id: number, edit: (l: Lesson) => void): Lesson {
  const store = load();
  const l = store.lessons.find((x) => x.id === id);
  if (!l) throw new AnimusError(`no lesson ${id}: animus lessons lists them`);
  edit(l);
  writeJson(lessonsFile(), store);
  return l;
}

/** Keeps a proposed lesson, or an expired one for 60 days more. */
export function accept(id: number, now: number): Lesson {
  return change(id, (l) => {
    if (l.status === 'dismissed') throw new AnimusError(`lesson ${id} was dismissed`);
    if (stateOf(l, now) === 'kept') throw new AnimusError(`lesson ${id} is already kept`);
    l.status = 'kept';
    l.acceptedAt = new Date(now).toISOString();
  });
}

export function dismiss(id: number): Lesson {
  return change(id, (l) => { l.status = 'dismissed'; });
}

/** A retro saw a kept lesson again in these jobs: they join its citations and its 60 days start over. */
export function seenAgain(id: number, cites: readonly string[], now: number): void {
  change(id, (l) => {
    l.cites = [...new Set([...l.cites, ...cites])];
    l.lastSeenAt = new Date(now).toISOString();
  });
}

/** `animus lessons`: proposed, kept and expired lessons, each with how to act on it. Dismissed ones are not listed. */
export function describeLessons(lessons: readonly Lesson[], now: number): string {
  const out: string[] = [];
  for (const state of ['proposed', 'kept', 'expired'] as const) {
    const of = lessons.filter((l) => stateOf(l, now) === state);
    if (!of.length) continue;
    out.push(`${state} (${of.length})`);
    for (const l of of) {
      const left = Math.ceil((expiresAt(l) - now) / DAY);
      const end = state === 'kept' ? `, ${left} day${left === 1 ? '' : 's'} left` : state === 'expired' ? `, expired ${Math.floor((now - expiresAt(l)) / DAY)} days ago: animus lessons accept ${l.id} keeps it again` : `: animus lessons accept ${l.id} or dismiss ${l.id}`;
      out.push(`  ${l.id}  ${l.text}`, `     for the ${l.agent}, ${l.scope === 'factory' ? 'every project' : l.project}; cites ${l.cites.join(', ')}; used ${l.uses}x${end}`);
    }
  }
  return out.join('\n') || 'no lessons yet: animus retro proposes some from the last week of runs';
}
