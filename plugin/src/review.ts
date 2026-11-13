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
};

export type Verdict = { criterion: number; met: boolean; proof: string };

export type Review = { status: 'reviewed' | 'not-ready'; summary: string; criteria: Verdict[]; findings: Finding[] };

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
  },
};

/** The implementer's final answer. */
export type Report = {
  status: 'done' | 'needs-input' | 'failed';
  summary: string;
  question?: string;
  notes?: string;
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
  return { status: o.status === 'not-ready' ? 'not-ready' : 'reviewed', summary: o.summary ?? '', criteria: Array.isArray(o.criteria) ? o.criteria : [], findings: o.findings };
}

export function asReport(output: unknown): Report | undefined {
  const o = output as Partial<Report> | undefined;
  if (!o || typeof o !== 'object' || typeof o.status !== 'string') return undefined;
  return o as Report;
}

/** What goes back to the implementer: blockers it can settle by itself. */
export const blockers = (findings: readonly Finding[]) => findings.filter((f) => f.severity === 'blocker' && !f.for_person);

const where = (f: Finding) => (f.file ? `${f.file}${f.line ? `:${f.line}` : ''}: ` : '');
export const listFindings = (fs: readonly Finding[]) => fs.map((f) => `- [${f.severity}] ${where(f)}${f.problem}${f.fix ? ` Fix: ${f.fix}` : ''}`).join('\n');

export function criteriaList(spec: Pick<Spec, 'criteria'>): string {
  return spec.criteria.map((c, i) => `${i + 1}. ${c.text}${c.commands.map((cmd) => `\n   $ ${cmd}`).join('')}`).join('\n');
}
