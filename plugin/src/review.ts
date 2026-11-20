// The review: a fresh session that did not write the code, given the spec and
// the diff, answering in a fixed shape. The schema and grading come from
// orbit's review.ts; the loop around it is the pipeline's.
import type { Spec } from './spec.ts';

export type Finding = {
  severity: 'blocker' | 'should-fix' | 'note';
  file?: string;
  line?: number;
  problem: string;
  fix?: string;
  /** A product or intent question the spec does not settle: for the person, not the implementer. */
  for_person?: boolean;
  cause?: string;
  /** The acceptance criterion (from 1) this finding is about. */
  criterion?: number;
};

export type Verdict = { criterion: number; met: boolean; proof: string };

/** `settled`: on a fix handed issues, the numbers of those the work settles. */
export type Review = { status: 'reviewed' | 'not-ready'; summary: string; criteria: Verdict[]; findings: Finding[]; settled?: number[] };

export const REVIEW_SCHEMA = {
  type: 'object',
  required: ['status', 'summary', 'criteria', 'findings'],
  properties: {
    status: { enum: ['reviewed', 'not-ready'] },
    summary: { type: 'string' },
    criteria: {
      type: 'array',
      items: {
        type: 'object',
        required: ['criterion', 'met', 'proof'],
        properties: { criterion: { type: 'integer' }, met: { type: 'boolean' }, proof: { type: 'string' } },
      },
    },
    findings: {
      type: 'array',
      items: {
        type: 'object',
        required: ['severity', 'problem'],
        properties: {
          severity: { enum: ['blocker', 'should-fix', 'note'] },
          file: { type: 'string' },
          line: { type: 'integer' },
          problem: { type: 'string' },
          fix: { type: 'string' },
          for_person: { type: 'boolean' },
          cause: { enum: ['spec', 'context', 'implementation', 'tests', 'environment'] },
        },
      },
    },
    settled: { type: 'array', items: { type: 'integer' } },
  },
};

/** The implementer's final answer. */
export type Report = {
  status: 'done' | 'needs-input' | 'failed';
  summary: string;
  question?: string;
  notes?: string;
  breaking?: string;
  escalate?: { size?: string; difficulty?: string; why: string };
};

export const REPORT_SCHEMA = {
  type: 'object',
  required: ['status', 'summary'],
  properties: {
    status: { enum: ['done', 'needs-input', 'failed'] },
    summary: { type: 'string' },
    question: { type: 'string' },
    notes: { type: 'string' },
    breaking: { type: 'string' },
    escalate: {
      type: 'object',
      required: ['why'],
      properties: { size: { enum: ['small', 'medium', 'large'] }, difficulty: { enum: ['hard', 'risky'] }, why: { type: 'string' } },
    },
  },
};

export function asReview(output: unknown): Review | undefined {
  const o = output as Partial<Review> | undefined;
  if (!o || typeof o !== 'object' || !Array.isArray(o.findings)) return undefined;
  const criteria = Array.isArray(o.criteria) ? o.criteria : [];
  // An unmet criterion is a blocker whether or not the reviewer filed one: a blocker that gives its number already covers it.
  const unmet = criteria
    .filter((v) => v.met === false && !o.findings!.some((f) => f.criterion === v.criterion))
    .map((v): Finding => ({ severity: 'blocker', criterion: v.criterion, problem: `Criterion ${v.criterion} is not met: ${v.proof}`, cause: 'implementation' }));
  const settled = Array.isArray(o.settled) ? o.settled.filter((n) => Number.isInteger(n)) : [];
  return { status: o.status === 'not-ready' ? 'not-ready' : 'reviewed', summary: o.summary ?? '', criteria, findings: [...o.findings, ...unmet], ...(settled.length ? { settled } : {}) };
}

export function asReport(output: unknown): Report | undefined {
  const o = output as Partial<Report> | undefined;
  if (!o || typeof o !== 'object' || typeof o.status !== 'string') return undefined;
  return o as Report;
}

/** What goes back to the implementer: blockers it can settle by itself. */
export const blockers = (findings: readonly Finding[]) => findings.filter((f) => f.severity === 'blocker' && !f.for_person);
export const shouldFix = (findings: readonly Finding[]) => findings.filter((f) => f.severity === 'should-fix' && !f.for_person);

const where = (f: Finding) => (f.file ? `${f.file}${f.line ? `:${f.line}` : ''}: ` : '');
export const listFindings = (fs: readonly Finding[]) => fs.map((f) => `- [${f.severity}] ${where(f)}${f.problem}${f.fix ? ` Fix: ${f.fix}` : ''}`).join('\n');

export function criteriaList(spec: Pick<Spec, 'criteria'>): string {
  return spec.criteria.map((c, i) => `${i + 1}. ${c.text}${c.commands.map((cmd) => `\n   $ ${cmd}`).join('')}`).join('\n');
}
