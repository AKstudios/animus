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
  /** `Jobs / <project> / <job>`: the project and the job's own name. */
  trail: { project: string; job: string };
  /** Time taken, cost, gate runs, and slices passed or review rounds. */
  numbers: { k: string; v: string }[];
  /** Each stage that took time: where it starts and how wide it is, as a share of the time; `label` is its name in its part, empty where it does not fit. */
  bar: { name: string; took: string; pct: number; at: number; label: string; on: boolean }[];
  /** The side panel for the job's pull request: its number, state, branch and times; left out for a job with none. */
  pr?: { number: string; href?: string; state: string; tone: Tone; rows: { k: string; v: string }[] };
  /** The Agents panel: cost by role and tier, biggest first, each with its share of the cost as a bar and its sessions and tool calls. */
  agents: { name: string; cost: string; pct: number; calls: string }[];
  /** "What this run taught": the lessons citing the job, each with its state; the panel is left out when none does. */
  taught: { text: string; state: string }[];
  /** A check that was flaky, as the chip says it: `test was flaky once`. */
  flaky: string[];
  /** The folded Tool calls row: its counts, and every session's calls as `animus tools` prints them; left out when the job made none. */
  tools?: { summary: string; text: string };
  /** The side panel of the spec header's size, difficulty and type: only the ones it names. */
  labels: { k: string; v: string }[];
  /** What each heading counts, beside it. */
  notes: { criteria: string; checks: string; review: string };
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
  /** Each finding says its fate: `fixed in round 2`, `still open`, `not acted on`; empty where the run log has none for it. */
  reviews: { title: string; summary: string; findings: { tag: string; tone: Tone; fate: string; where: string; problem: string; fix: string }[] }[];
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
const CHECK: Record<string, [string, Tone]> = { ok: ['✓', 'ink'], fail: ['✗', 'fail'], skip: ['skip', 'mute'] };
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

/** The size, difficulty and type the spec's header (its `---` block) names, in that order. */
export function labelsOf(spec: string): { k: string; v: string }[] {
  const head = /^---\r?\n([\s\S]*?)\r?\n---/.exec(spec)?.[1] ?? '';
  return ['size', 'difficulty', 'type'].flatMap((k) => {
    const v = new RegExp(`^${k}:[ \\t]*(\\S.*)$`, 'm').exec(head)?.[1]?.trim();
    return v ? [{ k, v }] : [];
  });
}

const plural = (n: number, one: string) => `${n} ${n === 1 ? one : `${one}s`}`;

/** What became of a review finding; `next` is the round that took it up. */
const fateOf = (fate: 'fixed' | 'open' | 'not-acted-on' | undefined, next: number) => (fate === 'fixed' ? `fixed in round ${next}` : fate === 'open' ? 'still open' : fate ? 'not acted on' : '');

/** The Pull request panel's rows for what happened after the job; the watch only for a merged PR (`reverted` and `reworked` come from the 30 days after the merge). */
function afterRows(a: JobPage['after'], merged: boolean): { k: string; v: string }[] {
  if (!a) return [];
  const commits = a.human_commits ? `${plural(a.human_commits, 'commit')}${a.lines ? ` · ${plural(a.lines.added, 'line')}` : ''}` : 'no commits';
  const watch = a.reverted ? 'reverted' : a.reworked ? 'reworked' : a.reverted === false ? 'not reverted' : 'watching';
  return [{ k: 'after the job', v: commits }, ...(merged ? [{ k: '30-day watch', v: watch }] : [])];
}

/** Cost by role and tier, biggest first, each with its share of the cost. */
function agentsOf(agents: NonNullable<JobPage['run']>['agents']): JobPageView['agents'] {
  const total = agents.reduce((n, a) => n + a.cost_usd, 0);
  return [...Map.groupBy(agents, (a) => `${a.role} · ${a.tier}`)].map(([name, as]) => {
    const cost = as.reduce((n, a) => n + a.cost_usd, 0);
    const [calls, errors] = [as.reduce((n, a) => n + a.calls, 0), as.reduce((n, a) => n + a.errors, 0)];
    return { name, cost, pct: total ? Math.round((cost / total) * 100) : 0, calls: [plural(as.length, 'session'), plural(calls, 'tool call'), ...(errors ? [plural(errors, 'error')] : [])].join(' · ') };
  }).sort((a, b) => b.cost - a.cost).map((a) => ({ ...a, cost: `$${a.cost.toFixed(2)}` }));
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
  let from = 0;
  const bar = p.stages.flatMap((name) => {
    const ms = p.ms?.[name] ?? 0;
    if (ms <= 0) return [];
    const pct = Math.round((ms / total) * 1000) / 10;
    const text = name === 'implement' && (p.slices?.length ?? 0) > 1 ? `${name} · ${plural(p.slices!.length, 'slice')}` : name === 'gates' && (p.gate_runs ?? 0) > 1 ? `${name} ×${p.gate_runs}` : name;
    const part = { name, took: span(ms), pct, at: from, label: pct >= text.length + 2 ? text : '', on: j.state === 'running' && j.progress?.stage === name };
    from += pct;
    return [part];
  });
  const state = p.pr_state ?? (closed ? (closed.merged ? 'merged' : 'closed') : undefined);
  const mergedAt = p.pr_merged ?? (closed?.merged ? closed.at : undefined);
  const found = (p.reviews ?? []).reduce((n, r) => n + r.findings.length, 0);
  const failed = checks.filter((c) => c.tone === 'fail').length;
  return {
    id: j.id, title: j.title, facts, trail: { project: j.repo, job: String(j.animus_job ?? j.id) },
    tag: { text: tag, tone },
    line: [j.repo, j.person, j.started ? `started ${when(j.started)}` : `submitted ${when(j.submitted)}`, ...(merged !== undefined ? [`merged after ${span(merged)}`] : [])].join(' · '),
    numbers: [
      { k: 'time taken', v: took }, { k: 'cost', v: j.cost_usd !== undefined ? `$${j.cost_usd.toFixed(2)}` : '–' },
      { k: `fix ${p.run?.fix_rounds === 1 ? 'round' : 'rounds'} · ${plural(p.gate_runs ?? 0, 'gate run')}`, v: p.run ? String(p.run.fix_rounds) : '–' },
      p.slices?.length ? { k: 'slices passed', v: `${done} of ${p.slices.length}` } : { k: 'review rounds', v: String(p.reviews?.length ?? 0) },
    ],
    bar,
    ...(j.pr ? { pr: {
      number: pr ? `#${pr}` : j.pr, ...(/^https?:\/\//.test(j.pr) ? { href: j.pr } : {}),
      state: state ?? 'open', tone: (state === 'merged' ? 'merged' : state === 'closed' ? 'mute' : 'open') as Tone,
      rows: [{ k: 'branch', v: `animus/${j.animus_job ?? j.id}` }, ...(p.pr_opened ? [{ k: 'opened', v: when(p.pr_opened) }] : []), ...(mergedAt ? [{ k: 'merged', v: when(mergedAt) }] : []), ...afterRows(p.after, state === 'merged')],
    } } : {}),
    agents: agentsOf(p.run?.agents ?? []),
    taught: (p.lessons ?? []).map((l) => ({ text: l.text, state: l.status === 'proposed' ? `Proposed · animus lessons accept ${l.id}` : `Kept · used ${l.uses}×` })),
    flaky: [...Map.groupBy((p.run?.gates ?? []).flatMap((g) => g.flaky), (n) => n)].map(([name, at]) => `${name} was flaky ${at.length === 1 ? 'once' : at.length === 2 ? 'twice' : `${at.length} times`}`),
    ...(p.run?.tools.text ? { tools: { summary: `${p.run.tools.calls} · ${plural(p.run.tools.errors, 'error')}`, text: p.run.tools.text } } : {}),
    labels: labelsOf(p.spec ?? ''),
    notes: {
      criteria: `${criteria.filter((c) => c.tone === 'ink').length} of ${criteria.length} proven`,
      checks: !checks.length ? '' : failed ? `${failed} failed on the last run` : 'all passed on the last run',
      review: p.reviews?.length ? `${plural(p.reviews.length, 'round')} · ${plural(found, 'finding')}` : '',
    },
    criteria,
    pills: checks.filter((c) => !used.has(c.name)).map(({ detail: _d, ...c }) => c),
    ...(j.reason ? { reason: j.reason } : {}),
    spec: p.spec ?? '',
    stages: p.stages.map((name) => ({ name, took: p.ms?.[name] !== undefined ? span(p.ms[name]) : '', on: j.state === 'running' && j.progress?.stage === name })),
    slices: p.slices ?? [],
    checks,
    reviews: (p.reviews ?? []).map((r, i) => ({
      title: `Review ${i + 1}`, summary: r.summary,
      findings: r.findings.map((f, n) => ({
        tag: f.severity.toUpperCase(), tone: SEVERITY[f.severity] ?? 'mute', fate: fateOf(p.run?.findings.filter((l) => l.round === i + 1)[n]?.fate, i + 2),
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
    follow: j.state === 'running' || j.state === 'queued' || j.state === 'waiting',
  };
}

/** Whether a scrolled box shows its end, give or take a few pixels: the log keeps to its end only while it does. */
export const atEnd = (el: { scrollTop: number; scrollHeight: number; clientHeight: number }) => el.scrollHeight - el.scrollTop - el.clientHeight < 4;
