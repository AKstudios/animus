// What became of each pull request, read from GitHub after the job: merged or
// closed, how long that took, the commits a person added, and whether the
// change was reverted or its lines changed again within 30 days. The run log
// stays append-only; outcomes are kept beside it, by pull request, and joined
// to the runs to give the five numbers of docs/factory.md, split by task class.
import { existsSync, readFileSync } from 'node:fs';
import { join } from 'node:path';
import { revParse } from './git.ts';
import { animusHome, readRuns, writeJson, type Run } from './log.ts';
import type { PrFacts, PrState } from './pr.ts';
import { tryGit } from './proc.ts';

export const outcomesFile = () => join(animusHome(), 'outcomes.json');

const WATCH_MS = 30 * 24 * 60 * 60 * 1000;

export type PrOutcome = {
  pr: string;
  job: string;
  state: PrState;
  opened: string;
  /** When it merged or closed. */
  closed?: string;
  ms_to_merge?: number;
  /** Commits on the pull request made after the job's last run ended. */
  human_commits: number;
  /** Lines those commits added and removed, read from the clone where it is here (0 when it is not). */
  human_lines: { added: number; removed: number };
  /** Within 30 days of the merge; absent while not merged, or when the repository is not here to read. */
  reverted?: boolean;
  /** Lines the pull request added were changed or removed within 30 days of the merge. */
  reworked?: boolean;
  checked: string;
};

export type Outcomes = Record<string, PrOutcome>;

export function readOutcomes(): Outcomes {
  return existsSync(outcomesFile()) ? (JSON.parse(readFileSync(outcomesFile(), 'utf8')) as Outcomes) : {};
}

/** Nothing more can change: closed, or merged with its 30 days watched to the end. */
function settled(o: PrOutcome): boolean {
  if (o.state === 'CLOSED') return true;
  return o.state === 'MERGED' && o.closed !== undefined && o.reverted !== undefined && Date.parse(o.checked) >= Date.parse(o.closed) + WATCH_MS;
}

/** Lines added and removed from one commit to another; binary files count for none. */
function linesBetween(repo: string, from: string, to: string): { added: number; removed: number } {
  const total = { added: 0, removed: 0 };
  for (const line of (tryGit(repo, ['diff', '--numstat', from, to]) ?? '').split('\n')) {
    const [a, r] = line.split('\t');
    total.added += Number(a) || 0;
    total.removed += Number(r) || 0;
  }
  return total;
}

/** Asks GitHub about every pull request in the run log whose outcome can still change, and saves what it says. */
export function refreshOutcomes(facts: (url: string, cwd: string) => PrFacts | undefined, now = Date.now()): Outcomes {
  const outcomes = readOutcomes();
  const last = new Map<string, Run>();
  for (const run of readRuns()) if (run.pr) last.set(run.pr, run);
  for (const [pr, run] of last) {
    if (outcomes[pr] && settled(outcomes[pr])) continue;
    const hasRepo = existsSync(join(run.repo, '.git'));
    const f = facts(pr, hasRepo ? run.repo : animusHome());
    if (!f) continue;
    const human_commits = f.commits.filter((date) => Date.parse(date) > Date.parse(run.ended)).length;
    const o: PrOutcome = {
      pr, job: run.job, state: f.state, opened: f.createdAt, human_commits,
      human_lines: human_commits && hasRepo && f.head && run.head ? linesBetween(run.repo, run.head, f.head) : { added: 0, removed: 0 },
      checked: new Date(now).toISOString(),
    };
    const closed = f.state === 'MERGED' ? f.mergedAt : f.state === 'CLOSED' ? f.closedAt : undefined;
    if (closed) o.closed = closed;
    if (f.state === 'MERGED' && f.mergedAt) {
      o.ms_to_merge = Date.parse(f.mergedAt) - Date.parse(f.createdAt);
      if (hasRepo && f.mergeCommit) Object.assign(o, afterMerge(run.repo, f.baseRefName, f.mergeCommit, f.mergedAt, pr));
    }
    outcomes[pr] = o;
  }
  if (last.size) writeJson(outcomesFile(), outcomes);
  return outcomes;
}

/**
 * Whether a merged change was reverted, or the lines it added changed again,
 * on its base branch within 30 days. Read from the clone, which is fetched
 * first. The change is taken to be the merge commit against its first parent,
 * which holds for a merge and a squash; a rebase merge is judged by its last
 * commit alone.
 */
export function afterMerge(repo: string, base: string, merge: string, mergedAt: string, pr: string): { reverted?: boolean; reworked?: boolean } {
  const remote = Boolean(tryGit(repo, ['remote', 'get-url', 'origin']));
  if (remote) tryGit(repo, ['fetch', '--quiet', 'origin', base]);
  const ref = remote && revParse(repo, `origin/${base}`) ? `origin/${base}` : base;
  if (!revParse(repo, merge) || !revParse(repo, ref)) return {};
  const until = new Date(Date.parse(mergedAt) + WATCH_MS).toISOString();
  const tip = tryGit(repo, ['rev-list', '-1', `--before=${until}`, ref]);
  if (!tip || tryGit(repo, ['merge-base', '--is-ancestor', merge, tip]) === undefined) return {};

  const github = /github\.com\/([^/]+\/[^/]+)\/pull\/(\d+)/.exec(pr);
  const messages = tryGit(repo, ['log', '--format=%B%x00', `${merge}..${tip}`]) ?? '';
  const reverted = messages.split('\0').some((m) => m.includes(`This reverts commit ${merge}`) || (github ? new RegExp(`Reverts ${github[1]}#${github[2]}\\b`).test(m) : false));

  const added = ranges(tryGit(repo, ['diff', '-U0', '--no-renames', `${merge}^`, merge]) ?? '', 'new');
  const changed = ranges(tryGit(repo, ['diff', '-U0', '--no-renames', merge, tip]) ?? '', 'old');
  const reworked = [...changed].some(([file, later]) => (added.get(file) ?? []).some(([a, b]) => later.some(([c, d]) => c <= b && a <= d)));
  return { reverted, reworked };
}

/** The line ranges each hunk of a -U0 diff covers on one side, by file. A side with no lines covers nothing. */
function ranges(diff: string, side: 'old' | 'new'): Map<string, [number, number][]> {
  const out = new Map<string, [number, number][]>();
  let file = '';
  for (const line of diff.split('\n')) {
    const header = /^diff --git a\/(.+) b\/\1$/.exec(line);
    if (header) { file = header[1]!; continue; }
    const hunk = /^@@ -(\d+)(?:,(\d+))? \+(\d+)(?:,(\d+))? @@/.exec(line);
    if (!hunk) continue;
    const start = Number(hunk[side === 'old' ? 1 : 3]);
    const count = Number(hunk[side === 'old' ? 2 : 4] ?? 1);
    if (count) out.set(file, [...(out.get(file) ?? []), [start, start + count - 1]]);
  }
  return out;
}

/** The five numbers for one task class, as counts, so they can be added up and shown as shares. */
export type ClassNumbers = {
  type: string;
  jobs: number;
  /** Pull requests opened, and of those how many are still open, merged, or closed unmerged. */
  prs: number; open: number; merged: number; closed: number;
  /** Merged with no human commit. */
  untouched: number;
  /** Jobs that ran the gates, and those whose first run of them passed. */
  gated: number; first_time: number;
  /** Everything the class cost, every attempt included. */
  cost_usd: number; ms: number;
  /** Merged pull requests whose 30 days could be read, and those reverted or reworked in them. */
  watched: number; reverted_or_reworked: number;
  /** Jobs whose last run did not end as a pull request, by the cause it stopped for. */
  causes: Record<string, number>;
};

const empty = (type: string): ClassNumbers => ({ type, jobs: 0, prs: 0, open: 0, merged: 0, closed: 0, untouched: 0, gated: 0, first_time: 0, cost_usd: 0, ms: 0, watched: 0, reverted_or_reworked: 0, causes: {} });

/** The numbers per task class, then for all jobs together. A job that ran more than once counts once, with all its cost. */
export function numbers(runs: readonly Run[], outcomes: Outcomes): ClassNumbers[] {
  const jobs = new Map<string, Run[]>();
  for (const run of runs) jobs.set(run.job, [...(jobs.get(run.job) ?? []), run]);
  const classes = new Map<string, ClassNumbers>();
  const all = empty('all');
  for (const ofJob of jobs.values()) {
    const type = ofJob.at(-1)!.type;
    if (!classes.has(type)) classes.set(type, empty(type));
    const pr = ofJob.findLast((r) => r.pr)?.pr;
    const o = pr ? outcomes[pr] : undefined;
    const firstGates = ofJob.find((r) => r.gates.length)?.gates[0];
    for (const n of [classes.get(type)!, all]) {
      n.jobs += 1;
      for (const r of ofJob) { n.cost_usd += r.cost_usd; n.ms += r.ms.total; }
      const cause = ofJob.at(-1)!.cause;
      if (cause) n.causes[cause] = (n.causes[cause] ?? 0) + 1;
      if (firstGates) { n.gated += 1; if (firstGates.ok) n.first_time += 1; }
      if (!pr) continue;
      n.prs += 1;
      if (!o || o.state === 'OPEN') n.open += 1;
      else if (o.state === 'CLOSED') n.closed += 1;
      else {
        n.merged += 1;
        if (!o.human_commits) n.untouched += 1;
        if (o.reverted !== undefined) { n.watched += 1; if (o.reverted || o.reworked) n.reverted_or_reworked += 1; }
      }
    }
  }
  return [...[...classes.values()].sort((a, b) => a.type.localeCompare(b.type)), all];
}

const share = (part: number, whole: number) => (whole ? `${part}/${whole} (${Math.round((100 * part) / whole)}%)` : '-');
const minutes = (ms: number) => `${(ms / 60_000).toFixed(1)}m`;

/** `animus outcomes`: the five numbers, one row per task class. */
export function describeNumbers(rows: readonly ClassNumbers[]): string {
  if (!rows.some((r) => r.jobs)) return 'no runs yet';
  const table = [
    ['class', 'jobs', 'PRs', 'merged', 'no human commit', 'gates first time', 'per merged PR', 'reverted or reworked in 30d', 'stopped for'],
    ...rows.map((n) => [
      n.type, String(n.jobs), `${n.prs}${n.open ? ` (${n.open} open)` : ''}`,
      share(n.merged, n.merged + n.closed), share(n.untouched, n.merged), share(n.first_time, n.gated),
      n.merged ? `$${(n.cost_usd / n.merged).toFixed(2)}, ${minutes(n.ms / n.merged)}` : `- ($${n.cost_usd.toFixed(2)}, ${minutes(n.ms)} spent)`,
      share(n.reverted_or_reworked, n.watched),
      Object.entries(n.causes).map(([c, count]) => `${c} ${count}`).join(', ') || '-',
    ]),
  ];
  const widths = table[0]!.map((_, i) => Math.max(...table.map((row) => row[i]!.length)));
  return table.map((row) => row.map((cell, i) => cell.padEnd(widths[i]!)).join('  ').trimEnd()).join('\n');
}
