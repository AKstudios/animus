// `animus fix <pr> "<text>"` (GLOSSARY.md, "Fix"): a new job on the branch of an open pull request a job
// opened. This holds what is particular to it: finding the job it continues, bringing the worktree to the
// branch as GitHub has it, and what the implementer and the reviewer are told.
import { existsSync, readdirSync, readFileSync } from 'node:fs';
import { hostname } from 'node:os';
import { join } from 'node:path';
import { alive, jobDir, loadProgress, loadState, readRuns, type JobState, type Run } from './log.ts';
import { prSource, prState, SPEC_SUMMARY, type PrLookup, type PrSource, type PrSourceLookup } from './pr.ts';
import { git, AnimusError, GitError, tryGit } from './proc.ts';
import { revParse } from './git.ts';
import { loadJobSkills, whereToRun, type PersonalSkill, type Where } from './personal.ts';

/** One fix as the pull request lists it. */
export type FixEntry = { ask: string; job: string; cost_usd: number };

/** The fix on this pull request that is running here or waiting for an answer, if any. */
export function activeFix(pr: string): { job: string; what: string } | undefined {
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

/** The runs in this repo whose pull request is `pr` (a number, `#number` or the URL), oldest first. */
export function openedHere(repo: string, pr: string): Run[] {
  const n = /^#?(\d+)$/.exec(pr.trim())?.[1];
  return readRuns().filter((r) => r.repo === repo && r.pr && (r.pr === pr.trim() || (n && r.pr.endsWith(`/${n}`))));
}

/**
 * The job a fix continues: the latest run in this repo whose pull request is `pr` (a number, `#number` or the URL),
 * and its state. Refuses, with one line, a pull request no job opened, one that is merged or closed, and one that
 * has a fix running or waiting for an answer. `lookup` says whether GitHub has the pull request open.
 */
export function fixTarget(repo: string, pr: string, lookup: PrLookup = prState): { run: Run; state?: JobState } {
  const run = openedHere(repo, pr).at(-1);
  if (!run) throw new AnimusError(`no job opened pull request ${pr}, so there is nothing to fix`);
  const github = lookup(run.pr!, repo);
  if (github && github !== 'OPEN') throw new AnimusError(`pull request ${pr} is ${github.toLowerCase()}, so it cannot be fixed`);
  const active = activeFix(run.pr!);
  if (active) throw new AnimusError(`pull request ${pr} has a fix ${active.what}: job ${active.job}`);
  const state = loadState(run.job);
  return { run, ...(state ? { state } : {}) };
}

/** Whether `animus start`'s argument is a pull request rather than a spec: no such file, and a number, `#number` or a pull request's URL. */
export const isPr = (arg: string) => !existsSync(arg) && /^(#?\d+|https?:\/\/\S+\/pull\/\d+\/?)$/.test(arg.trim());

/**
 * Where `animus start <pr>` runs a fix: where its session is. On this machine when a job here opened the pull request
 * (`here`, that job); otherwise as for a new job but whatever the config says: Helix when this machine has joined one
 * that has the repository, and else here from the pull request alone. --local and --helix win, and `left` is the one
 * line that says the choice leaves a session behind.
 */
export async function whereToFix(opts: Omit<Parameters<typeof whereToRun>[0], 'config'> & { pr: string; here?: string }): Promise<{ where: Where; why: string; project?: string; left?: string }> {
  const { pr, here, ...where } = opts;
  if (here && opts.asked !== 'helix') return { where: 'local', why: opts.asked ? 'asked for --local' : `job ${here} on this machine opened it, and its session is here` };
  const choice = await whereToRun(where);
  if (here) return { ...choice, left: `the session of job ${here} stays on this machine: Helix runs the fix from the pull request alone` };
  if (opts.asked === 'local') return { ...choice, left: `no job on this machine opened pull request ${pr}: the fix runs here from the pull request alone, without the session of the job that opened it` };
  return choice.where === 'local' ? { ...choice, why: `no job on this machine opened it and ${choice.why}: the fix runs here from the pull request alone` } : choice;
}

/** What a fix that runs from the pull request alone takes from it; author is the GitHub login that opened it. */
export type FromPr = { spec: string; branch: string; baseBranch: string; closes?: number; fixes?: FixEntry[]; author?: string };

/** The spec in the collapsed block an Animus job writes in its pull request's description (pr.ts prBody); undefined when it has none. */
export const specInBody = (body: string): string | undefined =>
  new RegExp(`<details><summary>${SPEC_SUMMARY}</summary>\\n\\n(\`{3,})md\\n([\\s\\S]*?)\\n\\1\\n\\n</details>`).exec(body)?.[2];

/** The spec, branches, Closes line and Fixes list a pull request's description and GitHub give; `what` names the description in the refusal when it holds no spec. */
function fromDescription(found: PrSource, what: string): FromPr {
  const spec = specInBody(found.body);
  if (!spec) throw new AnimusError(`${what} holds no spec (one too long for GitHub's limit is left out), so the fix cannot run`);
  const { closes, fixes } = readBody(found.body);
  return { spec, branch: found.head, baseBranch: found.base, ...(closes ? { closes } : {}), ...(fixes.length ? { fixes } : {}), ...(found.author ? { author: found.author } : {}) };
}

/**
 * A fix of a pull request no job on this machine opened: everything from GitHub, as `fixAlone` has it, and the job it
 * continues named from the description's last line. Refuses, with one line, one that is merged or closed, one with a
 * fix running or waiting here, and one whose description holds no spec.
 */
export function fixFromPr(repo: string, pr: string, lookup: PrSourceLookup = prSource): { of: string; pr: string; alone: FromPr } {
  const found = lookup(pr, repo);
  if (!found) throw new AnimusError(`no job on this machine opened pull request ${pr} and GitHub would not give it, so there is nothing to fix`);
  if (found.state && found.state !== 'OPEN') throw new AnimusError(`pull request ${pr} is ${found.state.toLowerCase()}, so it cannot be fixed`);
  const url = found.url ?? pr;
  const active = activeFix(url);
  if (active) throw new AnimusError(`pull request ${pr} has a fix ${active.what}: job ${active.job}`);
  const alone = fromDescription(found, `no job on this machine opened pull request ${pr}, and its description`);
  return { of: /^Built by Animus, job `([^`]+)`\.$/m.exec(found.body)?.[1] ?? url, pr: url, alone };
}

/**
 * The personal skills a fix runs with: the copy kept in the folder of the job it continues; with that folder gone, the
 * requester's only when they opened the pull request, and none otherwise.
 */
export function fixSkills(of: string, p: { author?: string | undefined; requester: () => string | undefined; theirs: () => PersonalSkill[] }): PersonalSkill[] {
  if (existsSync(jobDir(of))) return loadJobSkills(jobDir(of));
  return p.author && p.author === p.requester() ? p.theirs() : [];
}

/**
 * Whether the fix has only the pull request to go on: the earlier job's folder is gone, or its worktree is and cannot
 * be made again for want of its branch. (A job removes its worktree when it ends; one whose branch is still here is
 * reopened at the same path, which is where its session is filed.) Then the spec comes from the block in the pull
 * request's description, the branch from GitHub, and nothing of the earlier session is left to resume. Undefined
 * when the job's folder and worktree, or its branch, are there.
 */
export function fixAlone(repo: string, run: Run, state: JobState | undefined, lookup: PrSourceLookup = prSource): FromPr | undefined {
  if (state && (existsSync(join(state.workspace.worktree, '.git')) || revParse(repo, state.workspace.branch))) return undefined;
  const found = lookup(run.pr!, repo);
  if (!found) throw new AnimusError(`the earlier job's ${state ? 'worktree' : 'folder'} is gone and GitHub would not give the description of ${run.pr}, so the fix has nothing to go on`);
  return fromDescription(found, `the earlier job's ${state ? 'worktree' : 'folder'} is gone and the description of ${run.pr}`);
}

/** What a pull request's description says a fix must keep: the issue it closes and its list of fixes. */
export function readBody(body: string): { closes?: number; fixes: FixEntry[] } {
  const closes = /^(?:Closes|Refs) #(\d+)$/m.exec(body)?.[1];
  const fixes = [...body.matchAll(/^\| \d+ \| (.*) \| `([^`]+)` \| \$([\d.]+) \|$/gm)].map((m) => ({ ask: m[1]!.replaceAll('\\|', '|'), job: m[2]!, cost_usd: Number(m[3]) }));
  return { ...(closes ? { closes: Number(closes) } : {}), fixes };
}

/** The same, from the pull request's current description: a job from before the state held them has only the pull request to say; none when GitHub will not. */
export function keptFromBody(pr: string, repo: string, lookup: PrSourceLookup = prSource): { closes?: number; fixes: FixEntry[] } | undefined {
  const found = lookup(pr, repo);
  return found && readBody(found.body);
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

/** What a script fetched for the fix (Helix: the pull request's reviews since its last push), one file each, in name order. */
const referencesNote = (dir?: string) => {
  const files = dir && existsSync(dir) ? readdirSync(dir).sort() : [];
  return files.length ? `What reviewers said on the pull request since its last push, which may explain the ask:\n\n${files.map((f) => readFileSync(join(dir!, f), 'utf8').trim()).join('\n\n---\n\n')}` : '';
};

/** The part of a fix every prompt to the implementer carries: what was asked, and what the branch is. */
function ask(p: { ask: string; foreign: string; references?: string | undefined }): string {
  return [
    `A person asked for this change to the open pull request, which this branch is:\n\n${p.ask.trim()}`,
    referencesNote(p.references),
    foreignNote(p.foreign),
    'Make the change, commit, run `animus check` as before and finish as before. Animus runs the gates again for every acceptance criterion in the spec, and a fresh reviewer judges the work against the spec and against this ask.',
  ].filter(Boolean).join('\n\n');
}

/** What the implementer's session is told when the session that opened the pull request carries on. */
export const resumeFixPrompt = ask;

const DIFF_MAX = 60_000;

/** What a fresh session is told when there is no session to carry on: the spec, the pull request's diff, earlier answers, then the ask. */
export function handoffFixPrompt(p: { brief: string; base: string; cwd: string; answers: readonly { question: string; answer: string }[]; ask: string; foreign: string; references?: string | undefined }): string {
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
