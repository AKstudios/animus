// Should-fix issues (GLOSSARY.md, docs/adr/0012): the GitHub issue opened for
// each should-fix finding when a job's pull request opens, as the job's person.
// The pull request's "Needs you" lists them, and that list is the only record.
import { gh } from './pr.ts';
import { AnimusError } from './proc.ts';
import type { Finding } from './review.ts';

export const SHOULD_FIX_LABEL = 'should-fix';

export type ShouldFixIssue = { number: number; title: string };

/** Opens one should-fix issue per finding, in order, linked to the pull request, and stops at the first GitHub refuses: the issues opened before it, and why. */
export type OpenIssues = (p: { cwd: string; pr: string; findings: readonly Finding[] }) => { issues: ShouldFixIssue[]; error?: string };

/** GitHub takes at most 256 characters in an issue's title. */
const issueTitle = (f: Finding) => { const t = f.problem.replace(/\s+/g, ' ').trim(); return t.length > 256 ? `${t.slice(0, 255)}…` : t; };

const issueBody = (f: Finding, pr: string) => [
  f.file ? `In \`${f.file}${f.line ? `:${f.line}` : ''}\`:` : '', f.problem, f.fix ? `Suggested fix: ${f.fix}` : '',
  `Raised by the review of ${pr}. Settle it by hand, or ask a fix for it on that pull request.`,
].filter(Boolean).join('\n\n');

export const openIssues: OpenIssues = ({ cwd, pr, findings }) => {
  const issues: ShouldFixIssue[] = [];
  try {
    // Made when the repository lacks it; where it is already there gh refuses, and the label is left as its owner set it.
    gh(cwd, ['label', 'create', SHOULD_FIX_LABEL, '--color', 'fbca04', '--description', 'A should-fix finding of an Animus review'], undefined, true);
    for (const f of findings) {
      const title = issueTitle(f);
      const url = gh(cwd, ['issue', 'create', '--title', title, '--label', SHOULD_FIX_LABEL, '--body-file', '-'], issueBody(f, pr)) ?? '';
      const number = Number(/\/issues\/(\d+)$/.exec(url)?.[1]);
      if (!number) throw new AnimusError(`gh issue create printed no issue's address: ${url}`);
      issues.push({ number, title });
    }
    return { issues };
  } catch (err) {
    if (!(err instanceof AnimusError)) throw err;
    return { issues, error: err.message };
  }
};

/** An issue as GitHub has it now, for a fix whose ask hands it the issue. */
export type IssueText = { number: number; title: string; body: string; open: boolean };

/** Reads one issue as the job's person; undefined when GitHub will not give it. */
export type ReadIssue = (p: { cwd: string; number: number }) => IssueText | undefined;

export const readIssue: ReadIssue = ({ cwd, number }) => {
  try {
    // The body has newlines, which gh's output is cut at: ask for JSON on one line.
    const out = gh(cwd, ['issue', 'view', String(number), '--json', 'title,body,state', '--jq', '[.title,.body,.state]|@json'], undefined, true);
    if (!out) return undefined;
    const [title, body, state] = JSON.parse(out) as [string, string, string];
    return { number, title, body, open: state === 'OPEN' };
  } catch (err) {
    if (!(err instanceof AnimusError)) throw err;
    return undefined;
  }
};

/** The issues a fix's ask hands it: the numbers it names; else, on the word should-fix, every open should-fix issue the pull request lists (`open` says to leave out closed ones). */
export function issuesAsked(ask: string, listed: readonly ShouldFixIssue[]): { numbers: number[]; open: boolean } {
  const named = [...new Set([...ask.matchAll(/#(\d+)\b/g)].map((m) => Number(m[1])))];
  if (named.length) return { numbers: named, open: false };
  return { numbers: /\bshould-fix\b/i.test(ask) ? listed.map((i) => i.number) : [], open: true };
}

/** Whether an issue holds this finding: the same problem (its title) and file (named first in its body, as openIssues writes it). An issue whose body is unread is judged by its title. */
export const sameFinding = (f: Finding, issue: { title: string; body?: string | undefined }) =>
  issue.title === issueTitle(f) && (issue.body === undefined || /^In `([^`]+?)(?::\d+)?`:/.exec(issue.body)?.[1] === f.file);

/** The should-fix issues a pull request's description lists under "Needs you" (pr.ts writes them). */
export function issuesInBody(body: string): ShouldFixIssue[] {
  // The acceptance criteria always follow it; the spec further down may hold lines of the same shape.
  const needs = /^## Needs you\n([^]*?)^## /m.exec(body)?.[1] ?? '';
  return [...needs.matchAll(/^- Should fix: #(\d+) (.+)$/gm)].map((m) => ({ number: Number(m[1]), title: m[2]! }));
}

/** The should-fix issues fixes of a pull request settled, from its description's `Closes #N (should-fix)` lines (pr.ts writes them). */
export const settledInBody = (body: string): number[] => [...body.matchAll(/^(?:Closes|Refs) #(\d+) \(should-fix\)$/gm)].map((m) => Number(m[1]));
