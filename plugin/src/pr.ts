// The pull request: its body built by script from what the job recorded, with
// the evidence for each acceptance criterion, and the push that opens it.
// A job that failed after its fix rounds gets a draft with the failure report,
// so the work is not lost. The factory never merges.
import { spawnSync } from 'node:child_process';
import { existsSync, readFileSync, rmSync } from 'node:fs';
import { basename, join } from 'node:path';
import type { CheckResult } from './gates.ts';
import type { Plan } from './profiles.ts';
import { ANSI, git, AnimusError } from './proc.ts';
import type { Finding, Review } from './review.ts';
import type { Spec } from './spec.ts';

export type PrInput = {
  job: string;
  spec: Spec;
  plan: Plan;
  /** The implementer's one-sentence account of the change. */
  summary: string;
  notes?: string;
  /** The last gate run. */
  gates: readonly CheckResult[];
  gateAttempts: number;
  fixRounds: number;
  review?: Review;
  reviewRounds: number;
  /** Blockers still open when the job stopped. */
  open: readonly Finding[];
  protectedTouched: readonly string[];
  /** Screenshot files and the folder they are in; urls once they are pushed, by file. */
  shots?: { dir: string; files: readonly string[]; urls?: Record<string, string>; branch?: string };
  escalations: readonly { size?: string; difficulty?: string; why: string }[];
  /** A job done in more than one slice: each slice's title, and its session's summary once its gates passed. */
  slices?: readonly { title: string; summary?: string }[];
  /** The base commit the branch was caught up to before the push, when the base had moved, and the files whose conflicts an implementer resolved. */
  caughtUp?: { branch: string; commit: string; resolved?: readonly string[] };
  /** Why the job failed; makes this a failure report. */
  failure?: string;
  /** The issue the job was submitted from: merging the pull request closes it. */
  closes?: number;
  /** How the pull request names that issue (the profile's issue_link); `Closes` when absent. */
  issueLink?: 'closes' | 'refs';
  /** Every fix on the pull request so far, oldest first, the one that built this body last. */
  fixes?: readonly { ask: string; job: string; cost_usd: number }[];
  models: string;
  cost_usd: number;
};

const cell = (text: string) => text.replace(/\s*\n\s*/g, ' ').replace(/\|/g, '\\|');
const where = (f: Finding) => (f.file ? `\`${f.file}${f.line ? `:${f.line}` : ''}\` ` : '');
const finding = (f: Finding) => `${where(f)}${f.problem}${f.fix ? ` (fix: ${f.fix})` : ''}`;
const OUTPUT_LINES = 25;

function tail(output: string): string {
  const lines = output.replace(ANSI, '').trimEnd().split('\n').map((l) => (l.length > 200 ? `${l.slice(0, 200)}…` : l));
  return (lines.length > OUTPUT_LINES ? ['…', ...lines.slice(-OUTPUT_LINES)] : lines).join('\n').replaceAll('```', "'''");
}

export function prBody(p: PrInput): string {
  const out: string[] = [];
  if (p.failure) out.push(`**This job failed and needs you.** ${p.failure.split('\n')[0]}`, '');
  if (p.slices?.length) {
    out.push('Done in this order, each slice by a fresh session and gated before the next began:', '');
    p.slices.forEach((x, i) => out.push(`${i + 1}. **${cell(x.title)}**: ${x.summary ? cell(x.summary) : '*not finished*'}`));
    out.push('');
  } else if (p.summary) out.push(p.summary, '');
  if (p.closes) out.push(`${p.issueLink === 'refs' ? 'Refs' : 'Closes'} #${p.closes}`, '');

  const here: string[] = [];
  if (p.failure && p.failure.includes('\n')) here.push(`- The failure in full:\n\n\`\`\`\n${tail(p.failure)}\n\`\`\``);
  for (const f of p.open) here.push(`- Still open after the review's fix round: ${finding(f)}`);
  for (const f of p.review?.findings.filter((x) => x.for_person) ?? []) here.push(`- The reviewer asks you: ${finding(f)}`);
  if (p.caughtUp?.resolved?.length) here.push(`- Conflicts with ${p.caughtUp.branch} that the implementer resolved: ${p.caughtUp.resolved.map((f) => `\`${f}\``).join(', ')}. No reviewer read the resolution; the gates passed on it.`);
  if (p.protectedTouched.length) here.push(`- Changes under protected paths: ${p.protectedTouched.map((f) => `\`${f}\``).join(', ')}`);
  for (const e of p.escalations) here.push(`- The implementer raised the job to ${[e.size, e.difficulty].filter(Boolean).join(', ')}: ${e.why}`);
  const unproved = p.spec.criteria.flatMap((c, i) => (c.commands.length ? [] : [i + 1]));
  if (unproved.length) here.push(`- ${unproved.length === 1 ? `Criterion ${unproved[0]} has` : `Criteria ${unproved.join(', ')} have`} no check command: ${p.review ? 'only the reviewer judged ' : 'nothing checked '}${unproved.length === 1 ? 'it' : 'them'}.`);
  if (!p.review && !p.failure) here.push(`- Not reviewed: a ${p.plan.size} job skips the review.`);
  if (p.notes) here.push(`- From the implementer: ${cell(p.notes)}`);
  out.push('## Review here', '', ...(here.length ? here : ['Nothing flagged: the gates passed, and the review found nothing to fix.']), '');

  if (p.fixes?.length) out.push('## Fixes', '', '| # | Ask | Job | Cost |', '| --- | --- | --- | --- |', ...p.fixes.map((f, i) => `| ${i + 1} | ${cell(f.ask)} | \`${f.job}\` | $${f.cost_usd.toFixed(2)} |`), '');

  out.push('## Acceptance criteria', '', '| # | Criterion | Check | Reviewer |', '| --- | --- | --- | --- |');
  p.spec.criteria.forEach((c, i) => {
    const ran = p.gates.filter((g) => g.criterion === i + 1);
    const check = !c.commands.length ? 'no command' : !ran.length ? 'not run' : ran.map((g) => `${g.ok ? 'passed' : '**failed**'}: \`${cell(g.command)}\``).join('<br>');
    const v = p.review?.criteria.find((x) => x.criterion === i + 1);
    out.push(`| ${i + 1} | ${cell(c.text)} | ${check} | ${v ? `${v.met ? 'met' : '**not met**'}: ${cell(v.proof)}` : p.review ? 'no verdict' : 'not reviewed'} |`);
  });
  out.push('');

  const ran = p.gates.filter((g) => !g.skipped);
  if (ran.length) {
    out.push(`<details><summary>Evidence: the output of ${ran.length} check(s), captured by Animus on the final commit</summary>`, '');
    for (const g of ran) out.push(`**${g.name}** ${g.ok ? 'passed' : 'failed'} in ${(g.ms / 1000).toFixed(1)}s: \`${g.command}\``, '', '```', tail(g.output), '```', '');
    out.push('</details>', '');
  }
  const skipped = p.gates.filter((g) => g.skipped);
  if (skipped.length) out.push(`Skipped: ${skipped.map((g) => `${g.name} (${g.output})`).join('; ')}.`, '');

  if (p.shots?.files.length) {
    const urls = p.shots.urls;
    out.push('## Screenshots', '', `Animus took these of the running app on the final commit${p.review ? ', and the reviewer looked at them' : ''}. Each is one window high; a taller page comes in numbered parts from the top.`, '');
    for (const f of p.shots.files) {
      const name = basename(f).replace(/\.[^.]+$/, '');
      const url = urls?.[f];
      const width = Number(/@(\d+)x/.exec(name)?.[1] ?? 0);
      if (url) out.push(`**${name}**`, '', width && width <= 500 ? `<img src="${url}" alt="${name}" width="${width}">` : `![${name}](${url})`, '');
      else out.push(`- \`${f}\``);
    }
    out.push(urls ? `The images are on the branch \`${p.shots.branch}\`, which is not part of this change. Delete it when you no longer need them.` : `The images were not pushed. They are on the machine that ran the job, in \`${p.shots.dir}\`.`, '');
  }
  const followUps = p.review?.findings.filter((f) => f.severity === 'should-fix' && !f.for_person) ?? [];
  if (followUps.length) out.push('## Follow-ups', '', 'Should-fix findings that did not go back for a fix:', '', ...followUps.map((f) => `- ${finding(f)}`), '');

  const review = !p.review ? 'no review' : `${p.reviewRounds} review round(s): ${p.review.summary}`;
  out.push('## Run', '', `- Profile: ${p.plan.size}, ${p.plan.difficulty}, ${p.plan.type}`, `- Models: ${p.models}`, `- Gates: ${p.gateAttempts} run(s), sent back ${p.fixRounds} time(s)`, `- Review: ${cell(review)}`, ...(p.caughtUp ? [`- Caught up with ${p.caughtUp.branch} at ${p.caughtUp.commit}, merged in before the push`] : []), `- Cost: $${p.cost_usd.toFixed(2)} (API-equivalent)`, '', `Built by Animus, job \`${p.job}\`.`);
  const body = out.join('\n');
  // The spec rides along, so a fix can run from the pull request alone; fenced longer than any fence it holds.
  const fence = '`'.repeat(Math.max(3, ...[...p.spec.text.matchAll(/`+/g)].map((m) => m[0].length + 1)));
  const spec = `\n\n<details><summary>${SPEC_SUMMARY}</summary>\n\n${fence}md\n${p.spec.text.trim()}\n${fence}\n\n</details>`;
  return body.length + spec.length <= BODY_LIMIT ? body + spec : `${body}\n\nThe spec is not in this description: with it, the description would pass GitHub's limit of ${BODY_LIMIT.toLocaleString('en-US')} characters.`;
}

/** The summary of the collapsed block that holds the job's spec. */
export const SPEC_SUMMARY = 'The spec this job ran from';
/** The most characters GitHub takes in a pull request's description. */
export const BODY_LIMIT = 65_536;

export type Publish = (p: { cwd: string; branch: string; baseBranch: string; title: string; body: string; draft: boolean }) => string;

/** Pushes the job's branch and opens its pull request, or updates the one already open. Returns its URL. */
export const publish: Publish = ({ cwd, branch, baseBranch, title, body, draft }) => {
  try {
    git(cwd, ['push', '--quiet', '-u', 'origin', `${branch}:${branch}`]);
  } catch (err) {
    throw new AnimusError(`could not push ${branch}: ${(err as Error).message}`);
  }
  const found = gh(cwd, ['pr', 'view', branch, '--json', 'url,isDraft', '--jq', '"\\(.url) \\(.isDraft)"'], undefined, true);
  if (found) {
    const [existing, isDraft] = found.split(' ') as [string, string];
    gh(cwd, ['pr', 'edit', branch, '--body-file', '-'], body);
    // The pull request ends as a draft only when the job failed, whatever an earlier attempt left.
    if (draft !== (isDraft === 'true')) gh(cwd, ['pr', 'ready', branch, ...(draft ? ['--undo'] : [])]);
    return existing;
  }
  return gh(cwd, ['pr', 'create', '--base', baseBranch, '--head', branch, '--title', title, '--body-file', '-', ...(draft ? ['--draft'] : [])], body)!;
};

function gh(cwd: string, args: string[], input?: string, quiet = false): string | undefined {
  // On Helix with its GitHub App, the token is read as it is now: it may have been renewed since the job started.
  const live = process.env.ANIMUS_GH_TOKEN_FILE;
  const env = live && existsSync(live) ? { ...process.env, GH_TOKEN: readFileSync(live, 'utf8').trim() } : undefined;
  const r = spawnSync('gh', args, { cwd, input, encoding: 'utf8', ...(env ? { env } : {}) });
  if (r.error) throw new AnimusError((r.error as NodeJS.ErrnoException).code === 'ENOENT' ? 'gh is not installed; see https://cli.github.com' : `gh ${args.slice(0, 2).join(' ')}: ${r.error.message}`);
  if (r.status !== 0) {
    if (quiet) return undefined;
    throw new AnimusError(`gh ${args.slice(0, 2).join(' ')}: ${(r.stderr || r.stdout).trim()}`);
  }
  return r.stdout.trim().split('\n').pop();
}

export type PrState = 'OPEN' | 'MERGED' | 'CLOSED';

export type PrLookup = (url: string, cwd: string) => PrState | undefined;

/** Whether a pull request is open, merged or closed; undefined when GitHub cannot say. */
export const prState: PrLookup = (url, cwd) => {
  const state = gh(cwd, ['pr', 'view', url, '--json', 'state', '--jq', '.state'], undefined, true);
  return state === 'OPEN' || state === 'MERGED' || state === 'CLOSED' ? state : undefined;
};

/** What GitHub records about a pull request. commits holds each commit's committer date. */
export type PrFacts = { state: PrState; createdAt: string; closedAt?: string; mergedAt?: string; mergeCommit?: string; baseRefName: string; commits: string[]; /** The pull request's last commit. */ head?: string };

export const prFacts = (url: string, cwd: string): PrFacts | undefined => {
  const out = gh(cwd, ['pr', 'view', url, '--json', 'state,createdAt,closedAt,mergedAt,mergeCommit,baseRefName,commits,headRefOid'], undefined, true);
  if (!out) return undefined;
  const j = JSON.parse(out) as { state: PrState; createdAt: string; closedAt: string | null; mergedAt: string | null; mergeCommit: { oid: string } | null; baseRefName: string; headRefOid?: string; commits: { committedDate: string }[] };
  return {
    state: j.state, createdAt: j.createdAt, baseRefName: j.baseRefName, commits: j.commits.map((c) => c.committedDate),
    ...(j.headRefOid ? { head: j.headRefOid } : {}),
    ...(j.closedAt ? { closedAt: j.closedAt } : {}), ...(j.mergedAt ? { mergedAt: j.mergedAt } : {}), ...(j.mergeCommit ? { mergeCommit: j.mergeCommit.oid } : {}),
  };
};

export const evidenceBranch = (job: string) => `animus-evidence/${job}`;

export type Evidence = (p: { cwd: string; job: string; dir: string; files: readonly string[] }) => Record<string, string>;

/**
 * Makes a job's screenshots visible in its pull request. GitHub's CLI cannot
 * attach images, so they go in one commit with no parent on a branch of their
 * own, built through a scratch index so no worktree is touched, and the body
 * links each by that commit. The job's own branch never holds them. Returns
 * each file's URL.
 */
export const pushEvidence: Evidence = ({ cwd, job, dir, files }) => {
  const remote = git(cwd, ['remote', 'get-url', 'origin']);
  const repo = /github\.com[:/]([^/]+\/[^/]+?)(?:\.git)?\/?$/.exec(remote)?.[1];
  if (!repo) throw new AnimusError(`origin (${remote}) is not a GitHub repository, so the screenshots cannot be linked`);
  const index = join(git(cwd, ['rev-parse', '--absolute-git-dir']), 'animus-evidence-index');
  const run = (args: string[]) => {
    const r = spawnSync('git', args, { cwd, encoding: 'utf8', env: { ...process.env, GIT_INDEX_FILE: index } });
    if (r.status !== 0) throw new AnimusError(`git ${args[0]}: ${(r.stderr || r.stdout).trim()}`);
    return r.stdout.trim();
  };
  try {
    rmSync(index, { force: true });
    for (const f of files) run(['update-index', '--add', '--cacheinfo', `100644,${run(['hash-object', '-w', join(dir, f)])},${basename(f)}`]);
    const commit = run(['commit-tree', run(['write-tree']), '-m', `Screenshots for Animus job ${job}`]);
    run(['push', '--quiet', 'origin', `+${commit}:refs/heads/${evidenceBranch(job)}`]);
    return Object.fromEntries(files.map((f) => [f, `https://github.com/${repo}/blob/${commit}/${encodeURIComponent(basename(f))}?raw=true`]));
  } finally {
    rmSync(index, { force: true });
  }
};

/** The newest pull request in the repo titled exactly this, in any state; undefined when there is none or GitHub cannot say. */
export type PrFind = (title: string, cwd: string) => { url: string; state: PrState } | undefined;

export const findPrByTitle: PrFind = (title, cwd) => {
  const out = gh(cwd, ['pr', 'list', '--state', 'all', '--search', `"${title.replaceAll('"', ' ')}" in:title`, '--limit', '100', '--json', 'url,state,title,createdAt'], undefined, true);
  if (!out) return undefined;
  const all = JSON.parse(out) as { url: string; state: PrState; title: string; createdAt: string }[];
  return all.filter((p) => p.title === title).sort((a, b) => b.createdAt.localeCompare(a.createdAt))[0];
};
