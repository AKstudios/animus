// `animus fix <pr> "<text>"` (GLOSSARY.md, "Fix"): a new job on the branch of an open pull request a job
// opened. This holds what is particular to it: finding the job it continues, bringing the worktree to the
// branch as GitHub has it, and what the implementer and the reviewer are told.
import { readdirSync } from 'node:fs';
import { hostname } from 'node:os';
import { alive, jobDir, loadProgress, loadState, readRuns, type JobState, type Run } from './log.ts';
import { prState, type PrLookup } from './pr.ts';
import { git, AnimusError, GitError, tryGit } from './proc.ts';
import { revParse } from './git.ts';

/** One fix as the pull request lists it. */
export type FixEntry = { ask: string; job: string; cost_usd: number };

/** The fix on this pull request that is running here or waiting for an answer, if any. */
function activeFix(pr: string): { job: string; what: string } | undefined {
  let names: string[] = [];
  try { names = readdirSync(jobDir('')); } catch { /* no jobs yet */ }
  for (const job of names) {
    const s = loadState(job);
    if (s?.pr !== pr || !s.fix_of) continue;
    if (s.outcome === 'needs-input') return { job, what: 'waiting for an answer' };
    const p = loadProgress(job);
    if (!s.outcome && p?.host === hostname() && p.pid !== undefined && alive(p.pid)) return { job, what: 'running' };
  }
  return undefined;
}

/**
 * The job a fix continues: the latest run in this repo whose pull request is `pr` (a number, `#number` or the URL),
 * and its state. Refuses, with one line, a pull request no job opened, one that is merged or closed, and one that
 * has a fix running or waiting for an answer. `lookup` says whether GitHub has the pull request open.
 */
export function fixTarget(repo: string, pr: string, lookup: PrLookup = prState): { run: Run; state: JobState } {
  const n = /^#?(\d+)$/.exec(pr.trim())?.[1];
  const opened = readRuns().filter((r) => r.repo === repo && r.pr && (r.pr === pr.trim() || (n && r.pr.endsWith(`/${n}`))));
  const run = opened.at(-1);
  if (!run) throw new AnimusError(`no job opened pull request ${pr}, so there is nothing to fix`);
  const github = lookup(run.pr!, repo);
  if (github && github !== 'OPEN') throw new AnimusError(`pull request ${pr} is ${github.toLowerCase()}, so it cannot be fixed`);
  const active = activeFix(run.pr!);
  if (active) throw new AnimusError(`pull request ${pr} has a fix ${active.what}: job ${active.job}`);
  const state = loadState(run.job);
  if (!state) throw new AnimusError(`the folder of job ${run.job}, which opened ${run.pr}, is gone`);
  return { run, state };
}

/**
 * Fetches the branch and resets the worktree to it as GitHub has it: a fix starts from what the pull request
 * holds, not from what an earlier run left locally. Returns the one-line log of the commits GitHub has that the
 * worktree lacked (a hand push, "Update branch"). A clone with no origin has nothing to fetch.
 */
export function syncBranch(worktree: string, branch: string): string {
  if (!tryGit(worktree, ['remote', 'get-url', 'origin'])) return '';
  try {
    git(worktree, ['fetch', '--quiet', 'origin', `+refs/heads/${branch}:refs/remotes/origin/${branch}`]);
  } catch (err) {
    if (!(err instanceof GitError)) throw err;
    throw new AnimusError(`could not fetch ${branch} from GitHub: ${err.message}`);
  }
  const theirs = revParse(worktree, `origin/${branch}`);
  if (!theirs) throw new AnimusError(`${branch} is not on GitHub any more`);
  const foreign = git(worktree, ['log', '--format=%h %s', `HEAD..${theirs}`]);
  git(worktree, ['reset', '--quiet', '--hard', theirs]);
  git(worktree, ['clean', '-fdq']);
  return foreign;
}

const foreignNote = (foreign: string) => (foreign ? `The branch had commits from outside this job, which Animus took from GitHub (a hand push, "Update branch"). Their log:\n${foreign}` : '');

/** The part of a fix every prompt to the implementer carries: what was asked, and what the branch is. */
function ask(p: { ask: string; foreign: string }): string {
  return [
    `A person asked for this change to the open pull request, which this branch is:\n\n${p.ask.trim()}`,
    foreignNote(p.foreign),
    'Make the change, commit, run `animus check` as before and finish as before. Animus runs the gates again for every acceptance criterion in the spec, and a fresh reviewer judges the work against the spec and against this ask.',
  ].filter(Boolean).join('\n\n');
}

/** What the implementer's session is told when the session that opened the pull request carries on. */
export const resumeFixPrompt = ask;

const DIFF_MAX = 60_000;

/** What a fresh session is told when there is no session to carry on: the spec, the pull request's diff, earlier answers, then the ask. */
export function handoffFixPrompt(p: { brief: string; base: string; cwd: string; answers: readonly { question: string; answer: string }[]; ask: string; foreign: string }): string {
  const diff = tryGit(p.cwd, ['diff', `${p.base}...HEAD`]) ?? '';
  return [
    p.brief,
    'This is a fix: an earlier job opened a pull request from this branch, its work is on it, and a person has asked for a change. You are a fresh session, so read what is there before you change anything (`git log --oneline` shows its commits).',
    `The pull request's diff against ${p.base}:\n\n${diff.length > DIFF_MAX ? `${diff.slice(0, DIFF_MAX)}\n… (cut: run \`git diff ${p.base}...HEAD\` for the rest)` : diff}`,
    p.answers.length ? `While it ran, the job stopped to ask the person who submitted it, and they answered:\n${p.answers.map((a) => `- Asked: ${a.question}\n  Answered: ${a.answer}`).join('\n')}` : '',
    ask(p),
  ].filter(Boolean).join('\n\n');
}

/** What the reviewer is told besides the spec. */
export const reviewAsk = (text: string) => `A person asked for this change to the open pull request, and this work is the answer to it. Judge it against the ask as you do against the spec's criteria; the spec's criteria must all still hold:\n\n${text.trim()}`;
