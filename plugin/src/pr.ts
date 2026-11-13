// The pull request: its body built by script from what the job recorded, with
// the evidence for each acceptance criterion, and the push that opens it.
// A job that failed after its fix rounds gets a draft with the failure report,
// so the work is not lost. The factory never merges.
import { spawnSync } from 'node:child_process';
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
  /** Screenshot files, and the folder on the machine that ran the job. */
  shots?: { dir: string; files: readonly string[] };
  escalations: readonly { size?: string; difficulty?: string; why: string }[];
  /** Why the job failed; makes this a failure report. */
  failure?: string;
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
  if (p.summary) out.push(p.summary, '');

  const here: string[] = [];
  if (p.failure && p.failure.includes('\n')) here.push(`- The failure in full:\n\n\`\`\`\n${tail(p.failure)}\n\`\`\``);
  for (const f of p.open) here.push(`- Still open after the review's fix round: ${finding(f)}`);
  for (const f of p.review?.findings.filter((x) => x.for_person) ?? []) here.push(`- The reviewer asks you: ${finding(f)}`);
  if (p.protectedTouched.length) here.push(`- Changes under protected paths: ${p.protectedTouched.map((f) => `\`${f}\``).join(', ')}`);
  for (const e of p.escalations) here.push(`- The implementer raised the job to ${[e.size, e.difficulty].filter(Boolean).join(', ')}: ${e.why}`);
  const unproved = p.spec.criteria.flatMap((c, i) => (c.commands.length ? [] : [i + 1]));
  if (unproved.length) here.push(`- ${unproved.length === 1 ? `Criterion ${unproved[0]} has` : `Criteria ${unproved.join(', ')} have`} no check command: ${p.review ? 'only the reviewer judged ' : 'nothing checked '}${unproved.length === 1 ? 'it' : 'them'}.`);
  if (!p.review && !p.failure) here.push(`- Not reviewed: a ${p.plan.size} job skips the review.`);
  if (p.notes) here.push(`- From the implementer: ${cell(p.notes)}`);
  out.push('## Review here', '', ...(here.length ? here : ['Nothing flagged: the gates passed, and the review found nothing to fix.']), '');

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
    out.push('## Screenshots', '', `Animus took ${p.shots.files.length} screenshot(s) of the running app on the final commit${p.review ? ', and the reviewer looked at them' : ''}. GitHub's CLI cannot attach images, so they are on the machine that ran the job, in \`${p.shots.dir}\`:`, '', ...p.shots.files.map((f) => `- \`${f}\``), '');
  }
  const followUps = p.review?.findings.filter((f) => f.severity === 'should-fix' && !f.for_person) ?? [];
  if (followUps.length) out.push('## Follow-ups', '', 'Should-fix findings that did not go back for a fix:', '', ...followUps.map((f) => `- ${finding(f)}`), '');

  const review = !p.review ? 'no review' : `${p.reviewRounds} review round(s): ${p.review.summary}`;
  out.push('## Run', '', `- Profile: ${p.plan.size}, ${p.plan.difficulty}, ${p.plan.type}`, `- Models: ${p.models}`, `- Gates: ${p.gateAttempts} run(s), sent back ${p.fixRounds} time(s)`, `- Review: ${cell(review)}`, `- Cost: $${p.cost_usd.toFixed(2)} (API-equivalent)`, '', `Built by Animus, job \`${p.job}\`.`);
  return out.join('\n');
}

export type Publish = (p: { cwd: string; branch: string; baseBranch: string; title: string; body: string; draft: boolean }) => string;

/** Pushes the job's branch and opens its pull request, or updates the one already open. Returns its URL. */
export const publish: Publish = ({ cwd, branch, baseBranch, title, body, draft }) => {
  try {
    git(cwd, ['push', '--quiet', '-u', 'origin', `${branch}:${branch}`]);
  } catch (err) {
    throw new AnimusError(`could not push ${branch}: ${(err as Error).message}`);
  }
  const existing = gh(cwd, ['pr', 'view', branch, '--json', 'url', '--jq', '.url'], undefined, true);
  if (existing) {
    gh(cwd, ['pr', 'edit', branch, '--body-file', '-'], body);
    return existing;
  }
  return gh(cwd, ['pr', 'create', '--base', baseBranch, '--head', branch, '--title', title, '--body-file', '-', ...(draft ? ['--draft'] : [])], body)!;
};

function gh(cwd: string, args: string[], input?: string, quiet = false): string | undefined {
  const r = spawnSync('gh', args, { cwd, input, encoding: 'utf8' });
  if (r.error) throw new AnimusError('gh is not installed; see https://cli.github.com');
  if (r.status !== 0) {
    if (quiet) return undefined;
    throw new AnimusError(`gh ${args.slice(0, 2).join(' ')}: ${(r.stderr || r.stdout).trim()}`);
  }
  return r.stdout.trim().split('\n').pop();
}
