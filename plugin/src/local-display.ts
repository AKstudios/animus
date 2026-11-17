// What the local display (`animus ui`) shows: every job folder under Animus's
// home, in the shape Helix's display answers (ADR 0004). A job has an outcome
// once its state says so; without one it is running only if the process that
// wrote its progress is alive on this machine, and stopped otherwise.
import { readdirSync, readFileSync, statSync } from 'node:fs';
import { hostname } from 'node:os';
import { basename, join } from 'node:path';
import type { DisplayJob } from '../display/shape.ts';
import { animusHome, jobDir, loadProgress, loadState, readRuns } from './log.ts';

/** True for a live process; EPERM means it exists under another user. */
const alive = (pid: number): boolean => {
  try { process.kill(pid, 0); return true; } catch (e) { return (e as NodeJS.ErrnoException).code === 'EPERM'; }
};

/** Every job this machine's Animus has a folder for, newest first. */
export function localJobs(): DisplayJob[] {
  let names: string[] = [];
  try { names = readdirSync(join(animusHome(), 'jobs')); } catch { /* no jobs yet */ }
  const runs = readRuns();
  return names.flatMap((id): DisplayJob[] => {
    const state = loadState(id);
    const progress = loadProgress(id);
    if (!state && !progress) return [];
    const mine = runs.filter((r) => r.job === id);
    const last = mine.at(-1);
    let title = last?.title;
    if (!title && state) { try { title = /^# (.+)$/m.exec(readFileSync(state.spec, 'utf8'))?.[1]; } catch { /* the job's copy is gone */ } }
    const running = !state?.outcome && progress?.host === hostname() && progress.pid !== undefined && alive(progress.pid);
    const submitted = mine[0]?.started ?? progress?.at ?? statSync(jobDir(id)).mtime.toISOString();
    return [{
      id, person: last?.submitter ?? '', repo: state ? basename(state.repo) : last ? basename(last.repo) : '', title: title ?? id, submitted,
      state: state?.outcome ? 'ended' : running ? 'running' : 'stopped',
      ...(last?.started ? { started: last.started } : {}), ...(last?.ended ? { ended: last.ended } : {}),
      ...(state?.outcome ? { outcome: state.outcome } : {}), ...(last?.pr ? { pr: last.pr } : {}),
      ...(last?.reason ? { reason: last.reason } : {}), ...(state?.question ? { question: state.question } : {}),
      ...(last ? { cost_usd: last.cost_usd } : {}),
      ...(running && progress ? { progress } : {}), ...(!state?.outcome && !running ? { resume: `animus resume ${id}` } : {}),
    }];
  }).sort((a, b) => (a.submitted < b.submitted ? 1 : -1));
}
