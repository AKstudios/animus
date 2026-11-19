// What a person does with the jobs of this machine's queue (local-queue.ts):
// look at them, answer one that asked, cancel one, and be told what needs them.
// Helix has the same words (`animus status`, `result`, `answer`, `cancel`); here
// they read and write queue.db, and the loop picks the change up on its next look.
import { existsSync, readFileSync } from 'node:fs';
import { basename } from 'node:path';
import { uptime } from 'node:os';
import { alive } from './log.ts';
import { kill, logFile } from './local-loop.ts';
import type { LocalJob, LocalQueue } from './local-queue.ts';
import { AnimusError } from './proc.ts';

const how = (j: LocalJob) => (j.state === 'ended' ? j.outcome ?? 'ended' : j.state);
const firstLine = (text: string) => text.split('\n')[0]!;

/** The job with this id, or why there is none. */
export function localJob(queue: LocalQueue, id: string): LocalJob {
  const job = /^\d+$/.test(id) ? queue.get(Number(id)) : undefined;
  if (!job) throw new AnimusError(`no job ${id} in this machine's queue`);
  return job;
}

/** `animus status`: one line per job, newest last. A job held for room, or for an earlier spec, says why. */
export function describeLocalJobs(list: readonly LocalJob[]): string {
  if (!list.length) return 'no jobs';
  const rows = list.map((j) => [String(j.id), basename(j.repo), how(j), j.title, j.pr ?? j.question ?? j.waiting ?? (j.reason ? firstLine(j.reason).slice(0, 60) : '')]);
  const widths = rows[0]!.map((_, i) => Math.max(...rows.map((row) => row[i]!.length)));
  return rows.map((row) => row.map((cell, i) => cell.padEnd(widths[i]!)).join('  ').trimEnd()).join('\n');
}

/** `animus status <id>`: the job, then the end of its log. */
export function describeLocalJob(j: LocalJob, logTail?: string): string {
  return [
    `job ${j.id}: ${j.title}`,
    `  ${how(j)}${j.pr ? `: ${j.pr}` : ''}`,
    `  on ${basename(j.repo)}, queued ${j.submitted.slice(0, 16).replace('T', ' ')}`,
    ...(j.waiting ? [`  ${j.waiting}`] : []),
    ...(j.question ? [`  it asks: ${j.question}`, `  answer with: animus answer ${j.id} "<your answer>"`] : []),
    ...(j.reason ? [`  reason: ${firstLine(j.reason)}`] : []),
    ...(logTail ? ['', logTail] : []),
  ].join('\n');
}

/** The end of a job's log, as the loop wrote it. */
export const logTail = (id: number, lines = 20): string =>
  existsSync(logFile(id)) ? readFileSync(logFile(id), 'utf8').trimEnd().split('\n').slice(-lines).join('\n') : '';

/**
 * What needs the person, most pressing first: questions a job is waiting on,
 * then failures and pull requests that came after they last looked. Empty
 * when nothing does.
 */
export function needsYou(queue: LocalQueue): string[] {
  const since = queue.seen() ? Date.parse(queue.seen()!) : 0;
  const ended = queue.inState('ended');
  const fresh = ended.filter((j) => Date.parse(j.ended ?? '') > since);
  const lines = [
    ...ended.filter((j) => j.outcome === 'needs-input').map((j) => `job ${j.id} asks: ${j.question ?? j.title}\n  answer with: animus answer ${j.id} "<your answer>"`),
    ...fresh.filter((j) => j.outcome === 'failed').map((j) => `job ${j.id} failed: ${j.title}${j.reason ? `\n  ${firstLine(j.reason)}` : ''}`),
    ...fresh.filter((j) => j.pr && (j.outcome === 'pr' || j.outcome === 'draft-pr')).map((j) => `job ${j.id} opened a pull request: ${j.pr}\n  ${j.title}`),
  ];
  return lines.length ? ['needs you:', ...lines.map((l) => `  ${l}`)] : [];
}

/** `animus answer`: a job that asked a question is queued again, to resume with the answer. */
export function answerLocal(queue: LocalQueue, id: string, text: string): LocalJob {
  const job = localJob(queue, id);
  if (job.state !== 'ended' || job.outcome !== 'needs-input') throw new AnimusError(`job ${id} is not waiting for an answer`);
  const { outcome: _o, question: _q, reason: _r, ended: _e, ...rest } = job;
  const queued: LocalJob = { ...rest, state: 'queued', queued: new Date().toISOString(), answer: text };
  queue.save(queued);
  return queued;
}

/** `animus cancel`: a job not yet over ends cancelled; one running has its process ended, whichever process started it. */
export function cancelLocal(queue: LocalQueue, id: string): LocalJob {
  const job = localJob(queue, id);
  if (job.state === 'ended' || job.state === 'cancelled') throw new AnimusError(`job ${id} has already ${job.state === 'cancelled' ? 'been cancelled' : 'ended'}`);
  const { pid, waiting: _w, ...rest } = job;
  const cancelled: LocalJob = { ...rest, state: 'cancelled', ended: new Date().toISOString() };
  // Saved first: the loop, seeing the process end, leaves a cancelled job as it is.
  queue.save(cancelled);
  // A pid from before the machine last started names nothing of ours now, and may name something else.
  if (job.state === 'running' && pid && job.started && Date.parse(job.started) > Date.now() - uptime() * 1000 && alive(pid)) kill(pid);
  return cancelled;
}
