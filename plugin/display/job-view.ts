// What a job page says, worked out from what Helix sent for it: the job's
// facts, stages, slices, checks, review and questions, each as it is shown.
// No DOM here, so the wording is tested without a browser
// (helix/test/job-page.test.ts), as view.ts is.
import { jobPage, personPage } from './pages.ts';
import type { DisplayClosed, JobPage } from './shape.ts';
import { clock, recent, span, type Tone } from './view.ts';

export type JobPageView = {
  id: number | string;
  title: string;
  /** The result tag, and the one line under the title: project, person, when it started, and how long a merged PR took to merge. */
  tag: { text: string; tone: Tone };
  line: string;
  /** Time taken, cost, gate runs, and slices passed or review rounds. */
  numbers: { k: string; v: string }[];
  /** Each stage that took time, its width the share of the time, with its time beneath. */
  bar: { name: string; took: string; pct: number; on: boolean }[];
  /** The spec's acceptance criteria in its words, each with its `acceptance-<n>` check; empty when the spec cannot be read that way. */
  criteria: { text: string; tag: string; tone: Tone; command: string; output?: string }[];
  /** The checks that are not a criterion's, as small tags; a failed one has its output. */
  pills: { name: string; tag: string; tone: Tone; command: string; output?: string }[];
  /** The header's facts, in order: only the ones the job has. */
  facts: { k: string; v: string; href?: string; /** Another page of the display. */ page?: string }[];
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
  /** Said in the log's place when the job printed nothing to it. */
  noLog: string;
  /** While the job may still write to it, the page reads its log again every two seconds and keeps to its end. */
  follow: boolean;
};

export const OUTCOMES: Record<string, string> = { pr: 'pull request', 'draft-pr': 'draft pull request', 'dry-run': 'dry run', 'needs-input': 'needs input', failed: 'failed' };
const CHECK: Record<string, [string, Tone]> = { ok: ['ok', 'ink'], fail: ['FAIL', 'fail'], skip: ['skip', 'mute'] };
const SEVERITY: Record<string, Tone> = { blocker: 'fail', 'should-fix': 'ask', note: 'mute' };

/** The items of the spec's "Acceptance criteria" list, in its words (the `$ command` lines left out). */
export function criteriaOf(spec: string): string[] {
  const items: string[] = [];
  let on = false;
  for (const line of spec.split('\n')) {
    if (/^#+\s/.test(line)) { on = /^#+\s*acceptance criteria\s*$/i.test(line); continue; }
    if (!on) continue;
    const item = /^\s*\d+[.)]\s+(.*)$/.exec(line);
    if (item) items.push(item[1]!.trim());
    else if (items.length && line.trim() && !line.trim().startsWith('$')) items[items.length - 1] += ` ${line.trim()}`;
  }
  return items;
}

/** A time as the page shows it: in UTC, so every screen that shows the job says the same. */
export const when = (iso: string) => `${iso.slice(0, 10)} ${iso.slice(11, 16)} UTC`;

/** The job page for one moment: `now` is Helix's clock in ms; `local` for the local display, which has no people pages. */
export function jobView(p: JobPage, now: number, local = false, closed?: DisplayClosed): JobPageView {
  const j = p.job;
  const pr = j.pr ? /(\d+)\/?$/.exec(j.pr)?.[1] : undefined;
  const facts = [
    { k: 'project', v: j.repo }, { k: 'person', v: j.person, ...(local ? {} : { page: personPage(j.person) }) }, { k: 'state', v: j.state },
    ...(j.outcome ? [{ k: 'outcome', v: OUTCOMES[j.outcome] ?? j.outcome }] : []),
    ...(j.resume ? [{ k: 'carry on', v: j.resume }] : []),
    ...(j.pr ? [{ k: 'PR', v: pr ? `#${pr}` : j.pr, ...(/^https?:\/\//.test(j.pr) ? { href: j.pr } : {}) }] : []),
    ...(j.fix_of !== undefined ? [{ k: 'fixes', v: `job #${j.fix_of}`, page: jobPage(j.fix_of) }] : []),
    ...(j.cost_usd !== undefined ? [{ k: 'cost', v: `$${j.cost_usd.toFixed(2)}` }] : []),
    { k: 'submitted', v: when(j.submitted) },
    ...(j.started ? [{ k: 'started', v: when(j.started) }] : []),
    ...(j.ended ? [{ k: 'ended', v: when(j.ended) }] : []),
    ...(j.started && j.ended ? [{ k: 'took', v: span(Date.parse(j.ended) - Date.parse(j.started)) }]
      : j.started && j.state === 'running' ? [{ k: 'running for', v: clock(now - Date.parse(j.started)) }] : []),
  ];
  const checks = (p.checks ?? []).map((c) => {
    const [tag, tone] = CHECK[c.status]!;
    return { name: c.name, command: c.command, tag, tone, detail: c.detail, ...(c.output !== undefined ? { output: c.output } : {}) };
  });
  const wanted = criteriaOf(p.spec ?? '');
  const byName = new Map(checks.map((c) => [c.name, c]));
  const readable = wanted.length > 0 && checks.some((c) => /^acceptance-\d+$/.test(c.name));
  const criteria = readable ? wanted.map((text, i) => {
    const c = byName.get(`acceptance-${i + 1}`);
    return c ? { text, tag: c.tag, tone: c.tone, command: c.command, ...(c.output !== undefined ? { output: c.output } : {}) } : { text, tag: 'not run', tone: 'mute' as Tone, command: '' };
  }) : [];
  const used = new Set(readable ? wanted.map((_, i) => `acceptance-${i + 1}`) : []);
  const took = j.started && j.ended ? span(Date.parse(j.ended) - Date.parse(j.started)) : j.started && j.state === 'running' ? clock(now - Date.parse(j.started)) : '–';
  const total = Object.values(p.ms ?? {}).reduce((a, b) => a + b, 0);
  const merged = closed?.merged && j.ended ? Math.max(0, Date.parse(closed.at) - Date.parse(j.ended)) : undefined;
  const done = (p.slices ?? []).filter((s) => s.done).length;
  const { tag, tone } = recent(j, local, closed);
  return {
    id: j.id, title: j.title, facts,
    tag: { text: tag, tone },
    line: [j.repo, j.person, j.started ? `started ${when(j.started)}` : `submitted ${when(j.submitted)}`, ...(merged !== undefined ? [`merged after ${span(merged)}`] : [])].join(' · '),
    numbers: [
      { k: 'time taken', v: took }, { k: 'cost', v: j.cost_usd !== undefined ? `$${j.cost_usd.toFixed(2)}` : '–' },
      { k: 'gate runs', v: String(p.gate_runs ?? 0) },
      p.slices?.length ? { k: 'slices passed', v: `${done} of ${p.slices.length}` } : { k: 'review rounds', v: String(p.reviews?.length ?? 0) },
    ],
    bar: p.stages.flatMap((name) => {
      const ms = p.ms?.[name] ?? 0;
      return ms > 0 ? [{ name, took: span(ms), pct: Math.round((ms / total) * 1000) / 10, on: j.state === 'running' && j.progress?.stage === name }] : [];
    }),
    criteria,
    pills: checks.filter((c) => !used.has(c.name)).map(({ detail: _d, ...c }) => c),
    ...(j.reason ? { reason: j.reason } : {}),
    spec: p.spec ?? '',
    stages: p.stages.map((name) => ({ name, took: p.ms?.[name] !== undefined ? span(p.ms[name]) : '', on: j.state === 'running' && j.progress?.stage === name })),
    slices: p.slices ?? [],
    checks,
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
    noLog: local ? 'Its output went to the terminal it ran in; this display keeps no log of it.' : 'It has printed nothing yet.',
    follow: j.state === 'running' || j.state === 'queued',
  };
}

/** Whether a scrolled box shows its end, give or take a few pixels: the log keeps to its end only while it does. */
export const atEnd = (el: { scrollTop: number; scrollHeight: number; clientHeight: number }) => el.scrollHeight - el.scrollTop - el.clientHeight < 4;
