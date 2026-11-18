// What the display says, worked out from what Helix sent: which jobs go in
// which section, and every label, note and count. No DOM here, so the
// wording is tested without a browser (helix/test/view.test.ts).
import { jobPage, personPage } from './pages.ts';
import type { Display, DisplayClosed, DisplayJob, DisplayPr } from './shape.ts';

export type Tone = 'ink' | 'mute' | 'ask' | 'fail';
export type Tick = 'running' | 'ask' | 'failed' | 'queued' | 'ended';

export type Project = { id: string; summary: string; on: boolean; busy: boolean; ticks: Tick[] };

/** Every job on the overview links to its own page, and the person who submitted it to theirs (personPage). */
export type Live = {
  id: number | string; page: string; repo: string; person: string; /** Helix only: the local display has no people pages. */ personPage?: string; title: string; elapsed: string;
  /** What the card names the job by, joined with " · " when drawn: the project, and the person when there is one. */
  by: { text: string; page?: string }[];
  /** The stage's place in the track; -1 until the job has said where it is. */
  stage: number; stageText: string; stepText: string; stepShort: string; who: string; now: string;
};

export type Waiting = { id: number | string; page: string; ask: boolean; tag: string; title: string; repo: string; person: string; personPage?: string; note: string };

/** meta: how long it took and what it cost; the project and person are drawn from repo and person. */
export type Recent = { id: number | string; page: string; tag: string; /** Local display: the pull request the tag names, on GitHub. */ href?: string; tone: Tone; title: string; repo: string; person: string; personPage?: string; meta: string; reason?: string };

/** An open pull request on the overview; it links to GitHub and to the job that opened it. */
export type Pr = { id: number; page: string; href: string; tag: string; draft: boolean; title: string; repo: string; person: string; personPage: string };

export type View = {
  name: string;
  slots: number; running: number; queued: number; asks: number;
  projects: Project[];
  /** The project picked, when Helix still has one by that name. */
  sel?: { id: string; base: string; gates: string; prs: number; spent: string };
  title: string;
  stages: number;
  /** Nothing runs or waits in line and no project is picked: the overview shows the synchronizing helix. A job that only waits for an answer does not count. */
  idle: boolean;
  /** Shown in place of the three sections when there is no job to list. */
  empty?: { title: string; text: string; free: string; command: string };
  /** The local display: it has no slots or queue to show, and lists every job by project instead of PRs and FINISHED. */
  local: boolean;
  /** Whether the header links to the people pages: Helix has them, the local display does not. */
  people: boolean;
  /** Local display: every job of the shown projects, newest first, grouped by project in the order of their newest job. */
  byProject: { project: string; jobs: Recent[] }[];
  live: Live[]; noLive: string;
  waiting: Waiting[];
  /** The newest open PRs the jobs opened. */
  prs: Pr[];
  /** The newest jobs that ended or were cancelled, apart from those waiting for an answer or with an open PR. */
  finished: Recent[];
};

/** How many of a project's latest jobs its row of ticks shows, how many finished jobs are listed, and how many open PRs. */
const TICKS = 10;
const FINISHED = 30;
const PRS = 10;

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

function tick(j: DisplayJob): Tick {
  if (j.state === 'running') return 'running';
  if (j.state === 'stopped') return 'failed';
  if (isAsk(j)) return 'ask';
  if (j.state === 'queued' || j.state === 'cancelled') return 'queued';
  return j.outcome === 'failed' ? 'failed' : 'ended';
}

/** Finished is where every job that is over is read, but one waiting for an answer (Waiting) or with its PR open (Pr). */
const isOver = (j: DisplayJob) => j.state === 'cancelled' || j.state === 'stopped' || (j.state === 'ended' && !isAsk(j));

const LISTED: Record<string, [string, Tone]> = {
  running: ['RUNNING', 'ink'], queued: ['QUEUED', 'mute'], stopped: ['STOPPED', 'fail'], cancelled: ['CANCELLED', 'mute'],
  pr: ['PR', 'ink'], 'draft-pr': ['DRAFT PR', 'ink'], 'dry-run': ['DRY RUN', 'mute'], 'needs-input': ['NEEDS INPUT', 'ask'], failed: ['FAILED', 'fail'],
};

/** A row of a job in any state; a stopped one says how to carry on. */
/** A person's page to link to: Helix has them, the local display does not. */
const people = (person: string, local: boolean) => (local ? {} : { personPage: personPage(person) });

function recent(j: DisplayJob, local = false, closed?: DisplayClosed): Recent {
  const [tag, tone] = LISTED[j.state === 'ended' ? j.outcome ?? 'failed' : j.state] ?? ['ENDED', 'mute'];
  const took = j.started && j.ended ? span(Date.parse(j.ended) - Date.parse(j.started)) : '';
  // Helix lists open PRs apart; only the local display tags a job with its pull request.
  const number = local && j.pr ? /(\d+)\/?$/.exec(j.pr)?.[1] : undefined;
  const made = {
    id: j.id, page: jobPage(j.id), tag: number ? `${tag} #${number}` : tag, ...(number && /^https?:\/\//.test(j.pr!) ? { href: j.pr } : {}), tone, title: j.title, repo: j.repo, person: j.person, ...people(j.person, local),
    meta: [took, j.cost_usd !== undefined ? usd(j.cost_usd) : ''].filter(Boolean).join(' · '),
    ...(j.resume ? { reason: `It stopped before it ended. To carry on: ${j.resume}` } : j.reason ? { reason: firstLine(j.reason) } : {}),
  };
  // A PR GitHub has not answered about stays `PR #n`, never guessed.
  const n = !local && j.pr && (j.outcome === 'pr' || j.outcome === 'draft-pr') ? /(\d+)\/?$/.exec(j.pr)?.[1] : undefined;
  if (!n) return made;
  return closed ? { ...made, tag: `${closed.merged ? 'MERGED' : 'CLOSED'} #${n}`, tone: closed.merged ? 'ink' : 'mute' } : { ...made, tag: `PR #${n}` };
}

function pr(p: DisplayPr): Pr {
  return { id: p.job, page: jobPage(p.job), href: p.url, tag: `${p.draft ? 'DRAFT ' : ''}PR #${p.number}`, draft: p.draft, title: p.title, repo: p.repo, person: p.person, personPage: personPage(p.person) };
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
      id: j.id, page: jobPage(j.id), repo: j.repo, person: j.person, ...people(j.person, d.local === true), title: j.title,
      by: [{ text: j.repo }, ...(j.person ? [{ text: j.person, ...(d.local ? {} : { page: personPage(j.person) }) }] : [])],
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
    ...shown.filter(isAsk).map((j): Waiting => ({ id: j.id, page: jobPage(j.id), ask: true, tag: 'NEEDS INPUT', title: j.title, repo: j.repo, person: j.person, ...people(j.person, d.local === true), note: j.question ?? 'It stopped to ask, and did not say what.' })),
    ...shown.filter((j) => j.state === 'queued').map((j): Waiting => {
      const waited = now - Date.parse(j.queued ?? j.submitted);
      const why = j.resumed === 'answer' ? 'Has its answer and carries on from where it stopped. '
        : j.resumed === 'restart' ? 'Helix stopped while it ran, so it carries on from where it stopped. ' : '';
      return {
        id: j.id, page: jobPage(j.id), ask: false, tag: j.resumed ? 'QUEUED AGAIN' : 'QUEUED', title: j.title, repo: j.repo, person: j.person, ...people(j.person, d.local === true),
        note: `${why}Position ${line.indexOf(j) + 1} in the queue, waiting ${waited < 60_000 ? 'less than a minute' : span(waited)}.`,
      };
    }),
  ];

  const open = new Set((d.prs ?? []).map((p) => p.job));
  const closed = new Map((d.closed ?? []).map((c) => [c.job, c]));
  const ended = shown.filter((j) => isOver(j) && !open.has(j.id as number)).reverse();
  const prs = (d.prs ?? []).filter((p) => !sel || p.repo === sel.name).sort((a, b) => Date.parse(b.created) - Date.parse(a.created)).slice(0, PRS).map(pr);

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
    idle: !sel && running === 0 && line.length === 0,
    ...(shown.length ? {} : { empty: {
      title: sel ? `No jobs for ${sel.name} yet` : 'Nothing is running',
      text: d.local ? 'No job has run on this machine yet. From a project, run a spec:'
        : sel ? 'Nobody has sent this project a spec. From its folder, run:' : 'No job has been submitted to this machine yet. From any project, send a spec:',
      free: d.local ? '' : `${d.slots - running} of ${d.slots} slots free`,
      command: d.local ? 'animus run <spec file>' : 'animus submit <spec file>',
    } }),
    live,
    noLive: sel ? 'No agent is working on this project.' : d.local ? 'No agent is working right now.' : `No agent is working right now. ${d.slots === 1 ? 'The one slot is' : `All ${d.slots} slots are`} free.`,
    waiting,
    prs,
    finished: ended.slice(0, FINISHED).map((j) => recent(j, d.local === true, closed.get(j.id as number))),
    local: d.local === true,
    people: d.local !== true,
    byProject: d.local ? [...Map.groupBy(shown, (j) => j.repo)].map(([project, jobs]) => ({ project, jobs: jobs.map((j) => recent(j, d.local === true)) })) : [],
  };
}
