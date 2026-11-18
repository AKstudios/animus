// What the Insights page says, worked out from what /insights-data sent: the
// last 30 days against the 30 before, each number with its change, the tables,
// and the lessons. No DOM here, so every number and word is tested without a
// browser (helix/test/insights-view.test.ts); app.ts only draws them.
import type { InsightsLesson, InsightsPage, InsightsRun } from './shape.ts';
import { span } from './view.ts';

const DAY = 86_400_000;
/** The days one window covers, and how many the data reaches back. */
export const WINDOW_DAYS = 30;
export const DATA_DAYS = 2 * WINDOW_DAYS;

/** The scope an address names: `?scope=` a project, else the whole factory. */
export const scopeOf = (search: string): string => new URLSearchParams(search).get('scope') || 'factory';
export const insightsPage = (scope: string) => `/insights?scope=${encodeURIComponent(scope)}`;

/** A job: its run lines (a resumed job has more than one) put together. */
type Job = {
  project: string; cls: string; delivered: boolean; merged: boolean; touched: boolean; undone: boolean;
  /** Whether its gates ran, and passed without sending the work back: unknown for a job that never reached them. */
  firstPass?: boolean;
  cause?: string; cost: number; ms: number; last: InsightsRun; runs: InsightsRun[];
};

export type Change = { text: string; tone: 'good' | 'bad' | 'same' };
export type Tile = { label: string; value: string; /** Beside the change: the numbers behind the value. */ note: string; change?: Change };
export type ClassRow = { name: string; jobs: string; merged: string; firstPass: string; perMerged: string };
export type CauseRow = { label: string; count: number; /** Of the jobs that did not deliver, as a width. */ pct: number; tone: 'fail' | 'ask' | 'mute' };
export type AgentRow = { role: string; tier: string; cost: string; calls: string; failed: string };
export type FlakyRow = { name: string; times: string; where: string };
export type ProposedLesson = { id: number; text: string; scope: string; source: string; command: string };
export type KeptLesson = { id: number; text: string; uses: string; used: boolean; where: string };

export type InsightsView = {
  scope: string;
  scopes: { name: string; href: string; on: boolean }[];
  tiles: Tile[];
  classes: ClassRow[];
  causes: CauseRow[];
  /** `10 jobs`, or nothing when every job delivered. */
  causeCount: string;
  agents: AgentRow[];
  /** `72% · 31 of 43`, or nothing when no finding was made. */
  findings: string;
  flaky: FlakyRow[];
  proposed: ProposedLesson[];
  kept: KeptLesson[];
  /** No job ended in the last 30 days in this scope. */
  none: boolean;
};

const CAUSES: Record<string, [string, CauseRow['tone']]> = {
  setup: ['Setup', 'mute'], admit: ['Not admitted', 'mute'], plan: ['Planning', 'mute'], 'needs-input': ['Asked a question', 'ask'],
  gates: ['Gates still failing', 'fail'], review: ['Review blocked', 'mute'], budget: ['Over budget', 'mute'], context: ['Out of context', 'mute'],
  'agent-error': ['Agent error', 'fail'], cancelled: ['Cancelled', 'mute'], interrupted: ['Interrupted', 'mute'],
};

const base = (repo: string) => repo.split('/').filter(Boolean).at(-1) ?? repo;
const sum = (xs: readonly number[]) => xs.reduce((a, b) => a + b, 0);
const usd = (n: number) => `$${n.toFixed(2)}`;
const pct = (n: number, of: number) => (of ? `${Math.round((n / of) * 100)}%` : '—');
const times = (n: number) => (n === 1 ? '1 time' : `${n} times`);

function jobsOf(runs: readonly InsightsRun[], outcomes: InsightsPage['outcomes']): Job[] {
  const byJob = new Map<string, InsightsRun[]>();
  for (const r of [...runs].sort((a, b) => (a.ended < b.ended ? -1 : 1))) byJob.set(r.job, [...(byJob.get(r.job) ?? []), r]);
  return [...byJob.values()].map((rs) => {
    const last = rs.at(-1)!;
    const pr = rs.findLast((r) => r.pr)?.pr;
    const o = pr ? outcomes[pr] : undefined;
    const delivered = last.outcome === 'pr' || last.outcome === 'draft-pr';
    const gates = rs.flatMap((r) => r.gates);
    const merged = delivered && o?.state === 'MERGED';
    return {
      project: base(last.repo), cls: `${last.size} · ${last.difficulty} · ${last.type}`, delivered, merged,
      touched: merged && o!.human_commits > 0, undone: merged && Boolean(o!.reverted || o!.reworked),
      ...(gates.length ? { firstPass: gates.every((g) => g.ok) && sum(rs.map((r) => r.fix_rounds)) === 0 } : {}),
      ...(last.cause ? { cause: last.cause } : {}), cost: sum(rs.map((r) => r.cost_usd)), ms: sum(rs.map((r) => r.ms)), last, runs: rs,
    };
  });
}

const median = (xs: number[]) => { const s = [...xs].sort((a, b) => a - b); return s.length ? (s[(s.length - 1) >> 1]! + s[s.length >> 1]!) / 2 : undefined; };

type Sums = { jobs: number; delivered: number; merged: number; untouched: number; gated: number; first: number; undone: number; cost: number; median?: number; flaky: number };

function sums(jobs: readonly Job[]): Sums {
  const merged = jobs.filter((j) => j.merged);
  const gated = jobs.filter((j) => j.firstPass !== undefined);
  return {
    jobs: jobs.length, delivered: jobs.filter((j) => j.delivered).length, merged: merged.length, untouched: merged.filter((j) => !j.touched).length,
    gated: gated.length, first: gated.filter((j) => j.firstPass).length, undone: merged.filter((j) => j.undone).length,
    cost: sum(jobs.map((j) => j.cost)), flaky: flakyOf(jobs).length,
    ...(median(jobs.map((j) => j.ms)) !== undefined ? { median: median(jobs.map((j) => j.ms))! } : {}),
  };
}

/** A share's change in whole points between what the two windows show; none when either has no share. `lower`: a fall is better. */
function points(now: [number, number], before: [number, number], lower = false): Change | undefined {
  if (!now[1] || !before[1]) return undefined;
  const d = Math.round((now[0] / now[1]) * 100) - Math.round((before[0] / before[1]) * 100);
  return { text: d ? `${d > 0 ? '+' : '−'}${Math.abs(d)} pts` : '0 pts', tone: !d ? 'same' : (d > 0) !== lower ? 'good' : 'bad' };
}

/** A cost's change in dollars; a fall is better. */
function dollars(now: number | undefined, before: number | undefined): Change | undefined {
  if (now === undefined || before === undefined) return undefined;
  const d = Math.round((now - before) * 100) / 100;
  return { text: d ? `${d > 0 ? '+' : '−'}${usd(Math.abs(d))}` : usd(0), tone: !d ? 'same' : d < 0 ? 'good' : 'bad' };
}

function flakyOf(jobs: readonly Job[]): (FlakyRow & { n: number; last: string })[] {
  const seen = new Map<string, { project: string; name: string; n: number; last: string }>();
  for (const j of jobs) for (const r of j.runs) for (const g of r.gates) for (const name of g.flaky) {
    const k = `${j.project}\u0000${name}`;
    const s = seen.get(k) ?? { project: j.project, name, n: 0, last: '' };
    s.n++;
    if (r.ended > s.last) s.last = r.ended;
    seen.set(k, s);
  }
  return [...seen.values()].sort((a, b) => b.n - a.n || (a.last < b.last ? 1 : -1)).map((s) => ({ name: s.name, times: times(s.n), where: s.project, n: s.n, last: s.last }));
}

/** How long ago, to the unit a glance needs: 12m, 5h, 2d. */
export function ago(iso: string, now: number): string {
  const ms = Math.max(0, now - Date.parse(iso));
  return ms >= DAY ? `${Math.floor(ms / DAY)}d ago` : ms >= 3_600_000 ? `${Math.floor(ms / 3_600_000)}h ago` : `${Math.floor(ms / 60_000)}m ago`;
}

export function insightsView(p: InsightsPage, now = Date.parse(p.at)): InsightsView {
  const all = jobsOf(p.runs, p.outcomes);
  const within = (from: number, to: number) => all.filter((j) => Date.parse(j.last.ended) > now - to * DAY && Date.parse(j.last.ended) <= now - from * DAY);
  const jobs = within(0, WINDOW_DAYS);
  const before = within(WINDOW_DAYS, DATA_DAYS);
  const s = sums(jobs);
  const b = sums(before);
  // With no job in the 30 days before, there is nothing to compare with.
  const vs = <T>(f: (x: Sums) => T | undefined): T | undefined => (b.jobs ? f(b) : undefined);
  const perMerged = (x: Sums) => (x.merged ? x.cost / x.merged : undefined);
  const cost = dollars(perMerged(s), vs(perMerged));
  const flaky = flakyOf(jobs);

  const tile = (label: string, value: string, note: string, change?: Change): Tile => ({ label, value, note, ...(change ? { change } : {}) });
  const share = (n: (x: Sums) => number, of: (x: Sums) => number, lower = false) => (b.jobs ? points([n(s), of(s)], [n(b), of(b)], lower) : undefined);
  const tiles = [
    tile('Merge rate', pct(s.merged, s.delivered), `${s.merged} of ${s.delivered}`, share((x) => x.merged, (x) => x.delivered)),
    tile('Merged untouched', pct(s.untouched, s.merged), 'no commit after the job', share((x) => x.untouched, (x) => x.merged)),
    tile('Gates pass first time', pct(s.first, s.gated), `${flaky.length} flaky check${flaky.length === 1 ? '' : 's'}`, share((x) => x.first, (x) => x.gated)),
    tile('Cost per merged PR', perMerged(s) === undefined ? '—' : usd(perMerged(s)!), s.median === undefined ? 'no job time' : `median ${span(s.median)}`, cost),
    tile('Reverted or reworked', pct(s.undone, s.merged), `${s.undone} of ${s.merged} · 30-day watch`, share((x) => x.undone, (x) => x.merged, true)),
  ];

  const classes = [...Map.groupBy(jobs, (j) => j.cls)].map(([name, js]) => ({ name, js, s: sums(js) }))
    .sort((x, y) => y.s.jobs - x.s.jobs || (x.name < y.name ? -1 : 1))
    .map(({ name, s: c }): ClassRow => ({ name, jobs: String(c.jobs), merged: pct(c.merged, c.delivered), firstPass: pct(c.first, c.gated), perMerged: c.merged ? usd(c.cost / c.merged) : '—' }));

  // A dry run is not a failure to deliver.
  const undelivered = jobs.filter((j) => !j.delivered && j.last.outcome !== 'dry-run');
  const causes = [...Map.groupBy(undelivered, (j) => j.cause ?? 'unknown')].map(([cause, js]): CauseRow => {
    const [label, tone] = CAUSES[cause] ?? ['Unknown', 'mute'];
    return { label, count: js.length, pct: Math.round((js.length / undelivered.length) * 100), tone };
  }).sort((x, y) => y.count - x.count || (x.label < y.label ? -1 : 1));

  const agentRuns = jobs.flatMap((j) => j.runs.flatMap((r) => r.agents));
  const totalCost = sum(agentRuns.map((a) => a.cost_usd));
  const agents = [...Map.groupBy(agentRuns, (a) => `${a.role}\u0000${a.tier}`)].map(([, as]) => {
    const calls = sum(as.map((a) => a.calls));
    return { role: as[0]!.role, tier: as[0]!.tier, spent: sum(as.map((a) => a.cost_usd)), calls, errors: sum(as.map((a) => a.errors)) };
  }).sort((x, y) => y.spent - x.spent).map((a): AgentRow => ({ role: a.role, tier: a.tier, cost: pct(a.spent, totalCost), calls: a.calls.toLocaleString('en-US'), failed: pct(a.errors, a.calls) }));

  const reviews = jobs.flatMap((j) => (j.last.review ? [j.last.review] : []));
  const found = sum(reviews.map((r) => r.findings));
  const acted = sum(reviews.map((r) => r.acted_on));

  const where = (l: InsightsLesson) => (l.scope === 'factory' ? 'factory' : l.project);
  return {
    scope: p.scope,
    scopes: ['factory', ...p.projects].map((name) => ({ name, href: insightsPage(name), on: name === p.scope })),
    tiles, classes, causes, causeCount: undelivered.length ? `${undelivered.length} job${undelivered.length === 1 ? '' : 's'}` : '',
    agents, findings: found ? `${pct(acted, found)} · ${acted} of ${found}` : '', flaky: flaky.map(({ name, times: t, where: w, last }) => ({ name, times: t, where: `${w} · last ${ago(last, now)}` })),
    proposed: p.lessons.filter((l) => l.status === 'proposed').map((l) => ({ id: l.id, text: l.text, scope: where(l), source: `Seen in ${l.cites.length} job${l.cites.length === 1 ? '' : 's'}: ${l.cites.join(', ')}`, command: `animus lessons accept ${l.id}` })),
    kept: p.lessons.filter((l) => l.status === 'kept' && Date.parse(l.expires) > now).map((l): KeptLesson => {
      const left = Math.ceil((Date.parse(l.expires) - now) / DAY);
      return { id: l.id, text: l.text, uses: `Used ${l.uses}×`, used: l.uses > 0, where: `${where(l)} · expires in ${left}d` };
    }),
    none: !jobs.length,
  };
}
