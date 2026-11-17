// What a job page says, worked out from what Helix sent for it: the job's
// facts, stages, slices, checks, review and questions, each as it is shown.
// No DOM here, so the wording is tested without a browser
// (helix/test/job-page.test.ts), as view.ts is.
import type { JobPage } from './shape.ts';
import { clock, span, type Tone } from './view.ts';

export type JobPageView = {
  id: number | string;
  title: string;
  /** The header's facts, in order: only the ones the job has. */
  facts: { k: string; v: string; href?: string }[];
  /** Why it failed or stopped, when it said. */
  reason?: string;
  spec: string;
  /** Every stage, with how long the job spent in it; `on` is the one it is in now. */
  stages: { name: string; took: string; on: boolean }[];
  slices: { title: string; delivers: string; done: boolean }[];
  checks: { name: string; command: string; tag: string; tone: Tone; detail: string; output?: string }[];
  reviews: { title: string; summary: string; findings: { tag: string; tone: Tone; where: string; problem: string; fix: string }[] }[];
  questions: { question: string; answer: string; answered: boolean }[];
  /** Each screenshot, named by its file, and where Helix serves it to a token. */
  shots: { name: string; src: string }[];
  log: string;
  /** While the job may still write to it, the page reads its log again every two seconds and keeps to its end. */
  follow: boolean;
};

const OUTCOMES: Record<string, string> = { pr: 'pull request', 'draft-pr': 'draft pull request', 'dry-run': 'dry run', 'needs-input': 'needs input', failed: 'failed' };
const CHECK: Record<string, [string, Tone]> = { ok: ['ok', 'ink'], fail: ['FAIL', 'fail'], skip: ['skip', 'mute'] };
const SEVERITY: Record<string, Tone> = { blocker: 'fail', 'should-fix': 'ask', note: 'mute' };

/** A time as the page shows it: in UTC, so every screen that shows the job says the same. */
const when = (iso: string) => `${iso.slice(0, 10)} ${iso.slice(11, 16)} UTC`;

/** The job page for one moment: `now` is Helix's clock in ms. */
export function jobView(p: JobPage, now: number): JobPageView {
  const j = p.job;
  const pr = j.pr ? /(\d+)\/?$/.exec(j.pr)?.[1] : undefined;
  const facts = [
    { k: 'project', v: j.repo }, { k: 'person', v: j.person }, { k: 'state', v: j.state },
    ...(j.outcome ? [{ k: 'outcome', v: OUTCOMES[j.outcome] ?? j.outcome }] : []),
    ...(j.resume ? [{ k: 'carry on', v: j.resume }] : []),
    ...(j.pr ? [{ k: 'PR', v: pr ? `#${pr}` : j.pr, ...(/^https?:\/\//.test(j.pr) ? { href: j.pr } : {}) }] : []),
    ...(j.cost_usd !== undefined ? [{ k: 'cost', v: `$${j.cost_usd.toFixed(2)}` }] : []),
    { k: 'submitted', v: when(j.submitted) },
    ...(j.started ? [{ k: 'started', v: when(j.started) }] : []),
    ...(j.ended ? [{ k: 'ended', v: when(j.ended) }] : []),
    ...(j.started && j.ended ? [{ k: 'took', v: span(Date.parse(j.ended) - Date.parse(j.started)) }]
      : j.started && j.state === 'running' ? [{ k: 'running for', v: clock(now - Date.parse(j.started)) }] : []),
  ];
  return {
    id: j.id, title: j.title, facts,
    ...(j.reason ? { reason: j.reason } : {}),
    spec: p.spec ?? '',
    stages: p.stages.map((name) => ({ name, took: p.ms?.[name] !== undefined ? span(p.ms[name]) : '', on: j.state === 'running' && j.progress?.stage === name })),
    slices: p.slices ?? [],
    checks: (p.checks ?? []).map((c) => {
      const [tag, tone] = CHECK[c.status]!;
      return { name: c.name, command: c.command, tag, tone, detail: c.detail, ...(c.output !== undefined ? { output: c.output } : {}) };
    }),
    reviews: (p.reviews ?? []).map((r, i) => ({
      title: `Review ${i + 1}`, summary: r.summary,
      findings: r.findings.map((f) => ({
        tag: f.severity.toUpperCase(), tone: SEVERITY[f.severity] ?? 'mute',
        where: f.file ? `${f.file}${f.line ? `:${f.line}` : ''}` : '', problem: f.problem, fix: f.fix ?? '',
      })),
    })),
    questions: (p.questions ?? []).map((q) => ({ question: q.question, answer: q.answer ?? 'Not answered yet.', answered: q.answer !== undefined })),
    shots: (p.shots?.files ?? []).map((f) => ({
      name: (f.split('/').at(-1) ?? f).replace(/\.[^.]+$/, ''),
      src: `/jobs/${encodeURIComponent(j.id)}/shots/${f.split('/').map(encodeURIComponent).join('/')}`,
    })),
    log: p.log,
    follow: j.state === 'running' || j.state === 'queued',
  };
}

/** Whether a scrolled box shows its end, give or take a few pixels: the log keeps to its end only while it does. */
export const atEnd = (el: { scrollTop: number; scrollHeight: number; clientHeight: number }) => el.scrollHeight - el.scrollTop - el.clientHeight < 4;
