// What the display shows (helix/ui): every job with where it is now, the
// slots, and each repository's base branch and gates. Read fresh on every
// request from the table, Animus's job files and each clone's profile, so
// Helix keeps nothing for it.
import { statSync } from 'node:fs';
import { hostname } from 'node:os';
import { join } from 'node:path';
import { STAGES, type Progress } from '../../plugin/src/log.ts';
import { loadProfile, PROFILE_PATH } from '../../plugin/src/profile.ts';
import type { Config } from './config.ts';
import type { HelixJob, Store } from './store.ts';
import type { Supervisor } from './supervisor.ts';

/** A job without what is only Helix's business: the spec's path, the pid, the answer's text. */
export type DisplayJob = Omit<HelixJob, 'spec' | 'pid' | 'answer' | 'draft' | 'interrupted'> & {
  /** Why a queued job is in the queue a second time. */
  resumed?: 'answer' | 'restart';
  /** Running jobs: the stage and who is working, as the job last said. */
  progress?: Progress;
  /** Running jobs: the last line of the job's output. */
  now?: string;
};

export type DisplayRepo = { name: string; base?: string; gates?: string[] };

export type Display = {
  name: string;
  /** Helix's clock, so a display with another clock still counts elapsed time right. */
  at: string;
  slots: number;
  stages: readonly string[];
  repos: DisplayRepo[];
  jobs: DisplayJob[];
};

/** The most jobs the display is sent, newest kept. */
const SHOWN = 200;

const profiles = new Map<string, { mtime: number; repo: DisplayRepo }>();

/** A repository's base and gate names from its profile, read again only when the file changes. */
function repoOf(name: string, dir: string): DisplayRepo {
  let mtime = 0;
  try { mtime = statSync(join(dir, PROFILE_PATH)).mtimeMs; } catch { /* no profile: the defaults */ }
  const known = profiles.get(dir);
  if (known && known.mtime === mtime && known.repo.name === name) return known.repo;
  let repo: DisplayRepo = { name };
  try {
    const p = loadProfile(dir);
    repo = { name, base: p.base, gates: Object.keys(p.commands) };
  } catch { /* a profile that does not parse fails its jobs, not the display */ }
  profiles.set(dir, { mtime, repo });
  return repo;
}

function jobOf(job: HelixJob, supervisor: Supervisor): DisplayJob {
  const { spec: _spec, pid: _pid, answer, draft: _draft, interrupted: _interrupted, ...shown } = job;
  if (job.state === 'queued' && job.animus_job) return { ...shown, resumed: answer ? 'answer' : 'restart' };
  if (job.state !== 'running') return shown;
  const progress = supervisor.progress(job);
  const now = supervisor.log(job.id, 1).trim();
  return {
    ...shown,
    // What a resumed job said before it stopped is not where it is now.
    ...(progress && job.started && progress.at >= job.started ? { progress } : {}),
    ...(now ? { now } : {}),
  };
}

export function display(opts: { config: Config; store: Store; supervisor: Supervisor }): Display {
  const { config, store, supervisor } = opts;
  return {
    name: config.name ?? hostname(),
    at: new Date().toISOString(),
    slots: config.slots,
    stages: STAGES,
    repos: Object.entries(config.repos).map(([name, dir]) => repoOf(name, dir)),
    jobs: store.list(SHOWN).map((j) => jobOf(j, supervisor)),
  };
}
