// What the display says, worked out from what Helix sent: which jobs go in
// which section, and every label, note and count. No DOM here, so the
// wording is tested without a browser (helix/test/view.test.ts).
import { jobPage } from './pages.ts';
import type { Display, DisplayJob } from './shape.ts';

export type Tone = 'ink' | 'mute' | 'ask' | 'fail';
export type Tick = 'running' | 'ask' | 'failed' | 'queued' | 'ended';

export type Project = { id: string; summary: string; on: boolean; busy: boolean; ticks: Tick[] };

/** Every job on the overview links to its own page. */
export type Live = {
  id: number; page: string; repo: string; person: string; title: string; elapsed: string;
  /** The stage's place in the track; -1 until the job has said where it is. */
  stage: number; stageText: string; stepText: string; stepShort: string; who: string; now: string;
};

export type Waiting = { id: number; page: string; ask: boolean; tag: string; title: string; repo: string; person: string; note: string };

export type Recent = { id: number; page: string; tag: string; tone: Tone; href?: string; title: string; meta: string; reason?: string };

export type View = {
  name: string;
  slots: number; running: number; queued: number; asks: number;
  projects: Project[];
  /** The project picked, when Helix still has one by that name. */
  sel?: { id: string; base: string; gates: string; prs: number; spent: string };
  title: string;
  stages: number;
  /** Shown in place of the three sections when there is no job to list. */
  empty?: { title: string; text: string; free: string };
  live: Live[]; noLive: string;
  waiting: Waiting[];
  recent: Recent[];
};

/** How many of a project's latest jobs its row of ticks shows, and how many ended jobs are listed. */
const TICKS = 10;
const RECENT = 30;

const pad = (n: number) => String(n).padStart(2, '0');

/** Minutes and seconds on a running job: 07:42, and 132:05 once it is past the hour. */
export const clock = (ms: number) => { const s = Math.max(0, Math.floor(ms / 1000)); return `${pad(Math.floor(s / 60))}:${pad(s % 60)}`; };

/** How long something took, to the unit a glance needs: 45s, 22m, 3h 10m. */
export function span(ms: number): string {
  const s = Math.max(0, Math.round(ms / 1000));
  if (s < 60) return `${s}s`;
  const m = Math.floor(s / 60);
  return m < 60 ? `${m}m` : `${Math.floor(m / 60)}h ${pad(m % 60)}m`;
}

const usd = (n: number) => `$${n.toFixed(2)}`;
const isAsk = (j: DisplayJob) => j.state === 'ended' && j.outcome === 'needs-input';
const firstLine = (s: string) => { const line = s.trim().split('\n')[0] ?? ''; return line.length > 240 ? `${line.slice(0, 239)}…` : line; };
const prNumber = (url: string) => /(\d+)\/?$/.exec(url)?.[1];

function tick(j: DisplayJob): Tick {
  if (j.state === 'running') return 'running';
  if (isAsk(j)) return 'ask';
  if (j.state === 'queued' || j.state === 'cancelled') return 'queued';
  return j.outcome === 'failed' ? 'failed' : 'ended';
}

function recent(j: DisplayJob): Recent {
  const n = j.pr ? prNumber(j.pr) : undefined;
  const pr = j.pr ? `PR${n ? ` #${n}` : ''}` : '';
  const [tag, tone]: [string, Tone] = j.state === 'cancelled' ? ['CANCELLED', 'mute']
    : j.outcome === 'pr' ? [pr || 'PR', 'ink']
    : j.outcome === 'draft-pr' ? [`DRAFT ${pr || 'PR'}`, 'ask']
    : j.outcome === 'dry-run' ? ['DRY RUN', 'mute']
    : ['FAILED', 'fail'];
  const took = j.started && j.ended ? span(Date.parse(j.ended) - Date.parse(j.started)) : '';
  return {
    id: j.id, page: jobPage(j.id), tag, tone, title: j.title,
    meta: [j.repo, j.person, took, j.cost_usd !== undefined ? usd(j.cost_usd) : ''].filter(Boolean).join(' · '),
    ...(j.pr && /^https?:\/\//.test(j.pr) ? { href: j.pr } : {}),
    ...(j.reason && j.outcome !== 'pr' ? { reason: firstLine(j.reason) } : {}),
  };
}

/** The display for one moment: `now` is Helix's clock in ms, `picked` the project chosen in the list. */
export function view(d: Display, picked: string | null, now: number): View {
  const sel = d.repos.find((r) => r.name === picked);
  const shown = sel ? d.jobs.filter((j) => j.repo === sel.name) : d.jobs;
  const count = (jobs: readonly DisplayJob[], t: Tick) => jobs.filter((j) => tick(j) === t && j.state !== 'cancelled').length;
  const line = d.jobs.filter((j) => j.state === 'queued');
  const running = count(d.jobs, 'running');

  const live = shown.filter((j) => j.state === 'running').map((j): Live => {
    const stage = j.progress ? d.stages.indexOf(j.progress.stage) : -1;
    return {
      id: j.id, page: jobPage(j.id), repo: j.repo, person: j.person, title: j.title,
      elapsed: j.started ? clock(now - Date.parse(j.started)) : '',
      stage,
      stageText: stage < 0 ? 'STARTING' : d.stages[stage]!.toUpperCase(),
      stepText: stage < 0 ? '' : `step ${stage + 1} of ${d.stages.length}`,
      stepShort: stage < 0 ? '' : `${stage + 1}/${d.stages.length}`,
      who: j.progress?.who ?? 'starting',
      now: j.now ?? '',
    };
  });

  const waiting = [
    ...shown.filter(isAsk).map((j): Waiting => ({ id: j.id, page: jobPage(j.id), ask: true, tag: 'NEEDS INPUT', title: j.title, repo: j.repo, person: j.person, note: j.question ?? 'It stopped to ask, and did not say what.' })),
    ...shown.filter((j) => j.state === 'queued').map((j): Waiting => {
      const waited = now - Date.parse(j.queued ?? j.submitted);
      const why = j.resumed === 'answer' ? 'Has its answer and carries on from where it stopped. '
        : j.resumed === 'restart' ? 'Helix stopped while it ran, so it carries on from where it stopped. ' : '';
      return {
        id: j.id, page: jobPage(j.id), ask: false, tag: j.resumed ? 'QUEUED AGAIN' : 'QUEUED', title: j.title, repo: j.repo, person: j.person,
        note: `${why}Position ${line.indexOf(j) + 1} in the queue, waiting ${waited < 60_000 ? 'less than a minute' : span(waited)}.`,
      };
    }),
  ];

  const ended = shown.filter((j) => (j.state === 'ended' || j.state === 'cancelled') && !isAsk(j)).reverse();

  return {
    name: d.name,
    slots: d.slots, running, queued: line.length, asks: d.jobs.filter(isAsk).length,
    projects: d.repos.map((r) => {
      const mine = d.jobs.filter((j) => j.repo === r.name);
      const [run, q, a] = [count(mine, 'running'), count(mine, 'queued'), count(mine, 'ask')];
      const parts = [run ? `${run} running` : '', q ? `${q} queued` : '', a ? `${a} ${a === 1 ? 'ask' : 'asks'}` : ''].filter(Boolean);
      return { id: r.name, summary: parts.join(' · ') || 'idle', on: r.name === sel?.name, busy: run > 0, ticks: mine.slice(-TICKS).map(tick) };
    }),
    ...(sel ? { sel: {
      id: sel.name, base: sel.base ?? '', gates: sel.gates?.join(', ') ?? '',
      prs: shown.filter((j) => j.pr).length,
      spent: usd(shown.reduce((sum, j) => sum + (j.cost_usd ?? 0), 0)),
    } } : {}),
    title: sel ? sel.name : 'All projects',
    stages: d.stages.length,
    ...(shown.length ? {} : { empty: {
      title: sel ? `No jobs for ${sel.name} yet` : 'Nothing is running',
      text: sel ? 'Nobody has sent this project a spec. From its folder, run:' : 'No job has been submitted to this machine yet. From any project, send a spec:',
      free: `${d.slots - running} of ${d.slots} slots free`,
    } }),
    live,
    noLive: sel ? 'No agent is working on this project.' : `No agent is working right now. ${d.slots === 1 ? 'The one slot is' : `All ${d.slots} slots are`} free.`,
    waiting,
    recent: ended.slice(0, RECENT).map(recent),
  };
}
