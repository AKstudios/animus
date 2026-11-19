// What a job page says, worked out from what Helix sent for it: the job's
// facts, stages, slices, checks, review and questions, each as it is shown.
// No DOM here, so the wording is tested without a browser
// (helix/test/job-page.test.ts), as view.ts is.
import { jobPage, personPage } from './pages.ts';
import type { DisplayClosed, DisplayJob, JobPage, LiveSession, ProfilesInfo, TokenCount } from './shape.ts';
import { clock, recent, span, tokens, type Tone } from './view.ts';

export type JobPageView = {
  id: number | string;
  title: string;
  /** The result tag, and the one line under the title: project, person, when it started, and how long a merged PR took to merge. */
  tag: { text: string; tone: Tone };
  line: string;
  /** The same line in parts, the person's linking to their page. */
  lineParts: { text: string; page?: string }[];
  /** `Jobs / <project> / <job>`: the project and the job's own name. */
  trail: { project: string; job: string };
  /** Time taken, cost, gate runs, and slices passed or review rounds. */
  numbers: { k: string; v: string }[];
  /** Each stage that took time: where it starts and how wide it is, as a share of the time; `label` is its name in its part, empty where it does not fit. */
  bar: { name: string; took: string; pct: number; at: number; label: string; on: boolean }[];
  /** The side panel for the job's pull request: its number, state, branch and times; left out for a job with none. */
  pr?: { number: string; href?: string; state: string; tone: Tone; rows: { k: string; v: string }[] };
  /** The Agents panel: cost by role and tier, biggest first, each with its share of the cost as a bar and its sessions, tool calls and tokens. */
  agents: { name: string; cost: string; pct: number; calls: string }[];
  /** Where the time went, opened: each stage with what it took and used, then each agent session placed on the same bar. */
  timeline: { stages: TimelineStage[]; sessions: TimelineSession[]; /** Said when a session has no start time (a job recorded before they were kept) and the sessions are laid end to end. */ note?: string };
  /** While the job runs: where it is now, as one line: the stage, the agent, its model and effort, the time on the stage and the tool in use. */
  now?: string;
  /** The Labels panel's explainer: what every size, difficulty and type runs, the job's own marked; left out when the page was sent no profiles. */
  explain?: Explainer;
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
  /** Each slice with where it is: passed, being worked on now, still to come, or left when the job ended. */
  slices: { title: string; delivers: string; done: boolean; state: 'done' | 'now' | 'next' | 'left' }[];
  checks: { name: string; command: string; tag: string; tone: Tone; detail: string; output?: string }[];
  /** Each finding says its fate: `fixed in round 2`, `still open`, `not acted on`; empty where the run log has none for it. */
  reviews: { title: string; summary: string; findings: { tag: string; tone: Tone; fate: string; where: string; problem: string; fix: string }[] }[];
  questions: { question: string; answer: string; answered: boolean }[];
  /** Each screenshot, named by its file, and where Helix serves it to a token. */
  shots: { name: string; src: string }[];
  log: string;
  /** Said in the log's place when the job printed nothing to it. */
  noLog: string;
  /** One section per stage, in order. */
  stageSections: StageSection[];
  /** Whether each foldable part starts open (`numbers`, `criteria`, `stage-<name>`, `spec`, `log`, `tools`, `questions`), before the person's own choice. */
  open: Record<string, boolean>;
  /** While the job may still write to it, the page reads its log again every two seconds and keeps to its end. */
  follow: boolean;
};

/** One gate run: its checks and criteria as the run printed them; `outcome` is `run 1 failed`. */
export type GateRunView = { outcome: string; ok: boolean; checks: { name: string; command: string; tag: string; tone: Tone; detail: string; output?: string }[] };

/** One stage's section: its state, time, agent sessions and what it produced; only the parts the stage has are set. */
export type StageSection = {
  name: string;
  state: 'done' | 'now' | 'next' | 'skipped';
  /** The state in words: `done`, `now`, `not reached`, `skipped for a fix`. */
  stateText: string;
  took: string;
  sessions: TimelineSession[];
  slices?: JobPageView['slices'];
  /** Implement: the sessions that answered a failed gate or a review, as `gate-fix-1`. */
  fixRounds?: string[];
  /** Gates: `run 1 failed → fix round 1 → run 2 passed`, each run, and the catch-up with the base. */
  gates?: { line: string; runs: GateRunView[]; catchUp: string };
  reviews?: JobPageView['reviews'];
  shots?: JobPageView['shots'];
  pr?: { href?: string; text: string; body: string };
};

export type TimelineStage ={ name: string; took: string; share: string; sessions: number; tokens: string; cost: string };
export type TimelineSession = {
  /** role · model */
  name: string; stage: string; tier: string; effort: string; ok: boolean;
  /** Where its part of the bar starts and how wide it is, in % of the job's time. */
  at: number; pct: number;
  took: string; cost: string; tokens: string;
  /** in, out, cache read and written, turns and tool calls, as one line. */
  detail: string;
  role: string; model: string;
  /** The session's own name in the run, such as `gate-fix-1`. */
  step: string;
  /** Tool calls, and whether any failed. */
  calls: number; errors: number;
  /** The session is working now, with the tool it last used. */
  live: boolean; tool?: string; target?: string;
};

/** One label's row in the explainer: its name, what it runs, and whether this job has it. */
export type ExplainRow = { name: string; text: string; runs: string; on: boolean };
export type Explainer = { models: string; /** This job's own labels, each in one plain sentence saying what it changes in the run. */ mine: { k: string; v: string; text: string }[]; groups: { title: string; rows: ExplainRow[] }[]; /** The agents this job ran, as role · model (tier). */ used: string[] };

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
    const used = as.reduce((n, a) => n + allTokens(a.tokens), 0);
    return { name, cost, pct: total ? Math.round((cost / total) * 100) : 0, calls: [plural(as.length, 'session'), plural(calls, 'tool call'), ...(errors ? [plural(errors, 'error')] : []), ...(used ? [`${tokens(used)} tokens`] : [])].join(' · ') };
  }).sort((a, b) => b.cost - a.cost).map((a) => ({ ...a, cost: `$${a.cost.toFixed(2)}` }));
}

const allTokens = (t: Partial<TokenCount> | undefined) => (t?.input ?? 0) + (t?.output ?? 0) + (t?.cache_read ?? 0) + (t?.cache_write ?? 0);

/** A time as the page shows it, in the viewer's own time and words: `Nov 17, 10:05 AM`, with the year when it is not this one. */
export function when(iso: string, now = Date.now()): string {
  const d = new Date(iso);
  if (Number.isNaN(d.getTime())) return iso;
  const year = d.getFullYear() !== new Date(now).getFullYear();
  return d.toLocaleString(undefined, { month: 'short', day: 'numeric', ...(year ? { year: 'numeric' } : {}), hour: 'numeric', minute: '2-digit' });
}

/** Each stage's line in the opened time bar, and each agent session placed inside its stage's part of the bar, in the order it ran. */
function timelineOf(bar: JobPageView['bar'], agents: NonNullable<JobPage['run']>['agents'], ms: Record<string, number>, live: LiveSession[], now: number, job: DisplayJob): JobPageView['timeline'] {
  const byStage = Map.groupBy(agents, (a) => a.stage);
  const total = Object.values(ms).reduce((a, b) => a + b, 0);
  const stages = bar.map((b) => {
    const as = byStage.get(b.name) ?? [];
    const used = as.reduce((n, a) => n + allTokens(a.tokens), 0);
    const cost = as.reduce((n, a) => n + a.cost_usd, 0);
    return { name: b.name, took: b.took, share: `${Math.round(total ? ((ms[b.name] ?? 0) / total) * 100 : 0)}%`, sessions: as.length, tokens: used ? tokens(used) : '–', cost: as.length ? `$${cost.toFixed(2)}` : '–' };
  });
  // With every session's start time, sessions sit on the job's own span; without, they lie end to end inside their stage's part.
  if (agents.every((a) => a.started) && (agents.length || live.length)) {
    const starts = [...agents.map((a) => ({ at: Date.parse(a.started!), ms: a.ms })), ...live.map((s) => ({ at: Date.parse(s.started), ms: s.ms }))];
    const t0 = Math.min(job.started ? Date.parse(job.started) : Infinity, ...starts.map((s) => s.at));
    const t1 = Math.max(job.ended ? Date.parse(job.ended) : job.state === 'running' ? now : 0, ...starts.map((s) => s.at + s.ms));
    const whole = Math.max(t1 - t0, 1);
    const place = (start: string, took: number) => {
      const at = Math.round(((Date.parse(start) - t0) / whole) * 1000) / 10;
      return { at, pct: Math.min(Math.round((took / whole) * 1000) / 10, 100 - at) };
    };
    const sessions = [
      ...agents.map((a) => ({ ...sessionOf(a), ...place(a.started!, a.ms) })),
      ...live.map((s) => ({
        name: `${s.role} · ${s.model || '–'}`, role: s.role, model: s.model, stage: stageOf(s.stage, s.role), step: s.stage, tier: '', effort: s.effort, ok: true, ...place(s.started, s.ms),
        took: span(s.ms), cost: '–', tokens: '–', detail: plural(s.calls, 'tool call'), calls: s.calls, errors: s.errors, live: s.live, ...(s.tool ? { tool: s.tool, target: s.target ?? '' } : {}),
      })),
    ];
    return { stages, sessions };
  }
  const sessions = bar.flatMap((b) => {
    const as = byStage.get(b.name) ?? [];
    const stageMs = ms[b.name] ?? 0;
    // Sessions of a stage ran one after another; the rest of its time was the script's (gates, git). Sessions that add up to more than the stage are scaled to fit.
    const fit = Math.max(stageMs, as.reduce((n, a) => n + a.ms, 0)) || 1;
    let from = b.at;
    return as.map((a) => {
      const pct = Math.round((a.ms / fit) * b.pct * 10) / 10;
      const part = { ...sessionOf(a), at: from, pct };
      from += pct;
      return part;
    });
  });
  return { stages, sessions, ...(sessions.length ? { note: 'times are durations only' } : {}) };
}

/** The pipeline stage a session belongs to: the planner plans, the implementer implements (slices, fixes, catch-up), the rest review. */
export const stageOf = (stage: string, role: string) => (role === 'planner' ? 'plan' : role === 'implementer' ? 'implement' : /^(setup|plan|implement|gates|review|evidence|pr)/.exec(stage)?.[0] ?? 'review');

const DOING: Record<string, string> = { setup: 'Setting up', plan: 'Planning', implement: 'Implementing', gates: 'Running the gates', review: 'Reviewing', evidence: 'Gathering evidence', pr: 'Opening the PR' };

/** The Now line: `Implementing slice 2 of 3 · implementer · opus, high effort · 4m · now: Edit plugin/display/app.ts`; the agent and tool only where the job has them. */
function nowOf(pr: NonNullable<DisplayJob['progress']>, live: LiveSession | undefined, now: number): string {
  const slice = /slice \d+ of \d+/.exec(pr.who)?.[0];
  return [
    `${DOING[pr.stage] ?? pr.stage}${slice ? ` ${slice}` : ''}`,
    ...(pr.model ? [pr.who.split(' · ')[0]!, `${pr.model}${pr.effort ? `, ${pr.effort} effort` : ''}`] : []),
    span(now - Date.parse(pr.at)),
    ...(live?.tool ? [`now: ${live.tool}${live.target ? ` ${live.target}` : ''}`] : []),
  ].join(' · ');
}

/** A finished agent session as a row, without where it sits on the bar. */
const sessionOf = (a: NonNullable<JobPage['run']>['agents'][number]) => ({
  name: `${a.role} · ${a.model || a.tier}`, role: a.role, model: a.model || a.tier, stage: stageOf(a.stage, a.role), step: a.stage, tier: a.tier, effort: a.effort, ok: a.ok,
  took: span(a.ms), cost: `$${a.cost_usd.toFixed(2)}`, tokens: tokens(allTokens(a.tokens)), calls: a.calls, errors: a.errors, live: false,
  detail: [`in ${tokens(a.tokens.input)}`, `out ${tokens(a.tokens.output)}`, `cache read ${tokens(a.tokens.cache_read)}`, `cache written ${tokens(a.tokens.cache_write)}`, plural(a.turns, 'turn'), plural(a.calls, 'tool call')].join(' · '),
});

/** What every label runs, from the factory's profiles, with this job's labels and the agents it ran marked. */
function explainerOf(p: ProfilesInfo, labels: { k: string; v: string }[], agents: NonNullable<JobPage['run']>['agents']): Explainer {
  const on = (k: string, v: string) => labels.some((l) => l.k === k && l.v === v);
  const model = (tier: string, effort?: string) => `${p.models[tier] ?? tier} (${tier}${effort ? `, ${effort} effort` : ''})`;
  const sizes = p.sizes.map((x) => ({
    name: x.name, text: x.looks_like ?? '', on: on('size', x.name),
    runs: [
      ...(p.planner?.sizes.includes(x.name) ? [`planner ${model(p.planner.tier, p.planner.effort)}`] : []),
      `review ${!x.review || x.review === 'none' ? 'none' : model(x.review)}`,
      ...(x.setup ? [`setup ${x.setup}`] : []), ...(x.gates ? [`gates ${x.gates}`] : []),
    ].join(' · '),
  }));
  const difficulties = p.difficulties.map((x) => ({
    name: x.name, text: x.signals ?? '', on: on('difficulty', x.name),
    runs: [
      `implementer ${model(x.tier, x.effort)}`,
      ...Object.entries(x.sizes ?? {}).map(([size, o]) => `${size}: ${model(o.tier ?? x.tier, o.effort ?? x.effort)}`),
      ...(x.review ? [`always reviewed by ${model(x.review)}`] : []),
    ].join(' · '),
  }));
  const types = p.types.map((x) => ({
    name: x.name, text: '', on: on('type', x.name),
    runs: [
      ...(x.reviewer ? [`reviewer ${x.reviewer}`] : []), ...(x.evidence?.length ? [`evidence ${x.evidence.join(', ')}`] : []),
      ...(x.prove === 'fails-on-base' ? ['its tests must fail on the base first'] : []),
    ].join(' · ') || 'the standard path',
  }));
  const tier = (t: string) => `a ${t}-tier model (${p.models[t] ?? t})`;
  const sentence = (k: string, v: string): string => {
    if (k === 'size') {
      const x = p.sizes.find((z) => z.name === v);
      const parts = [...(p.planner?.sizes.includes(v) ? ['a planner cuts the work into slices'] : []), ...(x?.review && x.review !== 'none' ? [`${tier(x.review)} reviews it`] : [])];
      return parts.join(', then ') || 'no planner and no extra review: the spec goes to the implementer as it is';
    }
    if (k === 'difficulty') {
      const x = p.difficulties.find((z) => z.name === v);
      return x ? `${tier(x.tier)} implements each slice, at ${x.effort} effort${x.review ? `, and ${tier(x.review)} always reviews it` : ''}` : '';
    }
    const x = p.types.find((z) => z.name === v);
    const who = x?.reviewer ? `a ${x.reviewer.replace(/-reviewer$/, '').replace(/^ui$/, 'UI')} reviewer ${x.evidence?.includes('screenshots') ? 'checks screenshots of the pages' : 'reviews the change'}` : '';
    return [who, ...(x?.prove === 'fails-on-base' ? ['its tests must fail on the base first'] : [])].filter(Boolean).join('; ') || 'it takes the standard path';
  };
  return {
    mine: labels.map((l) => ({ ...l, text: sentence(l.k, l.v) })).filter((l) => l.text),
    models: Object.entries(p.models).map(([tier, m]) => `${tier} = ${m}`).join(' · '),
    groups: [{ title: 'Size', rows: sizes }, { title: 'Difficulty', rows: difficulties }, { title: 'Type', rows: types }],
    used: [...new Set(agents.map((a) => `${a.role} · ${a.model || a.tier} (${a.tier})`))],
  };
}

/** The job page for one moment: `now` is Helix's clock in ms; `local` for the local display, which keeps no log. */
export function jobView(p: JobPage, now: number, local = false, closed?: DisplayClosed): JobPageView {
  const j = p.job;
  const pr = j.pr ? /(\d+)\/?$/.exec(j.pr)?.[1] : undefined;
  const facts = [
    { k: 'project', v: j.repo }, ...(j.person ? [{ k: 'person', v: j.person, page: personPage(j.person) }] : []), { k: 'state', v: j.state },
    ...(j.outcome ? [{ k: 'outcome', v: OUTCOMES[j.outcome] ?? j.outcome }] : []),
    ...(j.resume ? [{ k: 'carry on', v: j.resume }] : []),
    ...(j.pr ? [{ k: 'PR', v: pr ? `#${pr}` : j.pr, ...(/^https?:\/\//.test(j.pr) ? { href: j.pr } : {}) }] : []),
    ...(j.fix_of !== undefined ? [{ k: 'fixes', v: j.fix_of_title ?? `job ${typeof j.fix_of === 'number' ? '#' : ''}${j.fix_of}`, page: jobPage(j.fix_of) }] : []),
    ...(j.cost_usd !== undefined ? [{ k: 'cost', v: `$${j.cost_usd.toFixed(2)}` }] : []),
    { k: 'submitted', v: when(j.submitted, now) },
    ...(j.started ? [{ k: 'started', v: when(j.started, now) }] : []),
    ...(j.ended ? [{ k: 'ended', v: when(j.ended, now) }] : []),
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
  const usedTokens = (p.run?.agents ?? []).reduce((n, a) => n + allTokens(a.tokens), 0) || j.tokens || 0;
  const labels = labelsOf(p.spec ?? '');
  const lineParts = [
    { text: j.repo }, ...(j.person ? [{ text: j.person, page: personPage(j.person) }] : []),
    { text: j.started ? `started ${when(j.started, now)}` : `submitted ${when(j.submitted, now)}` }, ...(merged !== undefined ? [{ text: `merged after ${span(merged)}` }] : []),
  ];
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
  const nowLine = j.state === 'running' && j.progress ? nowOf(j.progress, p.sessions?.find((s) => s.live), now) : undefined;
  const state = p.pr_state ?? (closed ? (closed.merged ? 'merged' : 'closed') : undefined);
  const mergedAt = p.pr_merged ?? (closed?.merged ? closed.at : undefined);
  const timeline = timelineOf(bar, p.run?.agents ?? [], p.ms ?? {}, p.run ? [] : p.sessions ?? [], now, j);
  const sliceRows = (p.slices ?? []).map((s, i) => ({ ...s, state: (s.done ? 'done' : j.state === 'running' && i === done ? 'now' : j.state === 'running' || j.state === 'queued' ? 'next' : 'left') as 'done' | 'now' | 'next' | 'left' }));
  const reviewRows = (p.reviews ?? []).map((r, i) => ({
    title: `Review ${i + 1}`, summary: r.summary,
    findings: r.findings.map((f, n) => ({
      tag: f.severity.toUpperCase(), tone: SEVERITY[f.severity] ?? 'mute', fate: fateOf(p.run?.findings.filter((l) => l.round === i + 1)[n]?.fate, i + 2),
      where: f.file ? `${f.file}${f.line ? `:${f.line}` : ''}` : '', problem: f.problem, fix: f.fix ?? '',
    })),
  }));
  const shotRows = (p.shots?.files ?? []).map((f) => ({
    name: (f.split('/').at(-1) ?? f).replace(/\.[^.]+$/, ''),
    src: `/jobs/${encodeURIComponent(j.id)}/shots/${f.split('/').map(encodeURIComponent).join('/')}`,
  }));
  const asRun = (list: typeof checks, n: number): GateRunView => {
    const ok = !list.some((c) => c.tone === 'fail');
    return { outcome: `run ${n} ${ok ? 'passed' : 'failed'}`, ok, checks: list };
  };
  const runList = p.gate_list?.length ? p.gate_list.map((l) => l.map((c) => { const [tag, tone] = CHECK[c.status]!; return { name: c.name, command: c.command, tag, tone, detail: c.detail, ...(c.output !== undefined ? { output: c.output } : {}) }; })) : checks.length ? [checks] : [];
  const gateRuns = runList.map((l, i) => asRun(l, i + 1));
  const caught = (p.log.match(/catch-up: merged /g) ?? []).length;
  const running = j.state === 'running';
  const at = p.stages.indexOf(j.progress?.stage ?? '');
  const lastMs = p.stages.reduce((n, s, i) => ((p.ms?.[s] ?? 0) > 0 ? i : n), -1);
  const stageSections: StageSection[] = p.stages.map((name, i) => {
    const sessions = timeline.sessions.filter((s) => s.stage === name);
    const ms = p.ms?.[name] ?? 0;
    const own = running && at >= 0 ? (i < at ? 'done' : i === at ? 'now' : 'next') : ms > 0 || sessions.length ? 'done' : lastMs > i ? 'skipped' : 'next';
    const state = own;
    const kind = name === 'plan' && j.fix_of !== undefined ? ' for a fix' : ' for this kind of job';
    const stateText = state === 'skipped' ? `skipped${kind}` : state === 'next' ? 'not reached' : state;
    const took = ms > 0 ? span(ms) : state === 'now' && j.progress ? span(now - Date.parse(j.progress.at)) : '–';
    const part: StageSection = { name, state, stateText, took, sessions };
    if (name === 'plan' && sliceRows.length) part.slices = sliceRows;
    if (name === 'implement') {
      if (sliceRows.length) part.slices = sliceRows;
      part.fixRounds = sessions.filter((s) => /^(gate-fix|review-fix)/.test(s.step)).map((s) => s.step);
    }
    if (name === 'gates' && gateRuns.length) {
      const line = gateRuns.map((r, n) => (n < gateRuns.length - 1 ? `${r.outcome} → fix round ${n + 1}` : r.outcome)).join(' → ');
      part.gates = { line, runs: gateRuns, catchUp: caught ? `caught up with the base ${caught === 1 ? 'once' : `${caught} times`}` : 'the base did not move' };
    }
    if (name === 'review' && reviewRows.length) part.reviews = reviewRows;
    if (name === 'evidence' && shotRows.length) part.shots = shotRows;
    if (name === 'pr' && (j.pr || p.pr_body)) part.pr = { ...(j.pr && /^https?:\/\//.test(j.pr) ? { href: j.pr } : {}), text: j.pr ? (pr ? `#${pr}` : j.pr) : 'No pull request', body: p.pr_body ?? '' };
    return part;
  });
  const open: Record<string, boolean> = {
    numbers: true, criteria: !running, spec: false, log: running || j.state === 'queued' || j.state === 'waiting', tools: false, questions: false,
    ...Object.fromEntries(stageSections.map((s) => [`stage-${s.name}`, s.state === 'now'])),
  };
  const found = (p.reviews ?? []).reduce((n, r) => n + r.findings.length, 0);
  const failed = checks.filter((c) => c.tone === 'fail').length;
  return {
    id: j.id, title: j.title, facts, trail: { project: j.repo, job: String(j.animus_job ?? j.id) },
    tag: { text: tag, tone },
    line: lineParts.map((x) => x.text).join(' · '),
    lineParts,
    numbers: [
      { k: 'time taken', v: took }, { k: 'cost', v: j.cost_usd !== undefined ? `$${j.cost_usd.toFixed(2)}` : '–' },
      { k: `fix ${p.run?.fix_rounds === 1 ? 'round' : 'rounds'} · ${plural(p.gate_runs ?? 0, 'gate run')}`, v: p.run ? String(p.run.fix_rounds) : '–' },
      p.slices?.length ? { k: 'slices passed', v: `${done} of ${p.slices.length}` } : { k: 'review rounds', v: String(p.reviews?.length ?? 0) },
      { k: 'tokens', v: usedTokens ? tokens(usedTokens) : '–' },
    ],
    bar,
    ...(j.pr ? { pr: {
      number: pr ? `#${pr}` : j.pr, ...(/^https?:\/\//.test(j.pr) ? { href: j.pr } : {}),
      state: state ?? 'open', tone: (state === 'merged' ? 'merged' : state === 'closed' ? 'mute' : 'open') as Tone,
      rows: [{ k: 'branch', v: `animus/${j.animus_job ?? j.id}` }, ...(p.pr_opened ? [{ k: 'opened', v: when(p.pr_opened, now) }] : []), ...(mergedAt ? [{ k: 'merged', v: when(mergedAt, now) }] : []), ...afterRows(p.after, state === 'merged')],
    } } : {}),
    agents: agentsOf(p.run?.agents ?? []),
    timeline,
    ...(nowLine ? { now: nowLine } : {}),
    ...(p.profiles ? { explain: explainerOf(p.profiles, labels, p.run?.agents ?? []) } : {}),
    taught: (p.lessons ?? []).map((l) => ({ text: l.text, state: l.status === 'proposed' ? `Proposed · animus lessons accept ${l.id}` : `Kept · used ${l.uses}×` })),
    flaky: [...Map.groupBy((p.run?.gates ?? []).flatMap((g) => g.flaky), (n) => n)].map(([name, at]) => `${name} was flaky ${at.length === 1 ? 'once' : at.length === 2 ? 'twice' : `${at.length} times`}`),
    ...(p.run?.tools.text ? { tools: { summary: `${p.run.tools.calls} · ${plural(p.run.tools.errors, 'error')}`, text: p.run.tools.text } } : {}),
    labels,
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
    // The slice being worked on is the first one not passed, while the job runs.
    slices: sliceRows,
    checks,
    reviews: reviewRows,
    questions: (p.questions ?? []).map((q) => ({ question: q.question, answer: q.answer ?? 'Not answered yet.', answered: q.answer !== undefined })),
    shots: shotRows,
    stageSections,
    open,
    log: p.log,
    noLog: local ? 'It has printed nothing yet, or it ran in a terminal and kept no log.' : 'It has printed nothing yet.',
    follow: j.state === 'running' || j.state === 'queued' || j.state === 'waiting',
  };
}

/** Whether a scrolled box shows its end, give or take a few pixels: the log keeps to its end only while it does. */
export const atEnd = (el: { scrollTop: number; scrollHeight: number; clientHeight: number }) => el.scrollHeight - el.scrollTop - el.clientHeight < 4;
