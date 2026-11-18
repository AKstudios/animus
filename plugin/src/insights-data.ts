// What the Insights page is sent (plugin/display/insights-view.ts does the
// sums): the run-log lines of the last 60 days from each Animus home, trimmed
// to what the view needs, the outcomes of their PRs, and the lessons. Shared
// by Helix (its people's homes) and the local display (this machine's).
import { basename, join } from 'node:path';
import type { InsightsLesson, InsightsOutcome, InsightsPage, InsightsRun } from '../display/shape.ts';
import { expiresAt, inScope, readLessons, type Lesson } from './lessons.ts';
import { readRuns } from './log.ts';
import { readOutcomes } from './outcomes.ts';

const DAY = 24 * 60 * 60 * 1000;

/** `scope` is `factory` or a project's name; `lessons` default to this home's, none when its file cannot be read. A home whose outcomes cannot be read tells nothing of its PRs. */
export function insightsData(scope: string, homes: readonly string[], now: number, lessons?: readonly Lesson[]): InsightsPage {
  let kept = lessons;
  if (!kept) { try { kept = readLessons(); } catch { kept = []; } }
  const runs = [...new Set(homes)].flatMap((h) => readRuns(join(h, 'runs.jsonl'))).filter((r) => Date.parse(r.ended) >= now - 60 * DAY);
  const outcomes: Record<string, InsightsOutcome> = {};
  for (const h of new Set(homes)) {
    try { for (const [pr, o] of Object.entries(readOutcomes(join(h, 'outcomes.json')))) outcomes[pr] = { state: o.state, human_commits: o.human_commits, ...(o.reverted !== undefined ? { reverted: o.reverted } : {}), ...(o.reworked !== undefined ? { reworked: o.reworked } : {}) }; } catch { /* unreadable: no PR is known */ }
  }
  const mine = runs.filter((r) => scope === 'factory' || basename(r.repo) === scope);
  const prs = new Set(mine.flatMap((r) => (r.pr ? [r.pr] : [])));
  return {
    at: new Date(now).toISOString(), scope, projects: [...new Set(runs.map((r) => basename(r.repo)))].sort(),
    runs: mine.map((r): InsightsRun => ({
      job: r.job, repo: r.repo, size: r.size, difficulty: r.difficulty, type: r.type, ended: r.ended, outcome: r.outcome, ...(r.cause ? { cause: r.cause } : {}),
      cost_usd: r.cost_usd, ms: r.ms?.total ?? 0, ...(r.pr ? { pr: r.pr } : {}), fix_rounds: r.fix_rounds ?? 0,
      gates: (r.gates ?? []).map((g) => ({ ok: g.ok, flaky: g.checks.filter((c) => c.flaky).map((c) => c.name) })),
      agents: (r.agents ?? []).map((a) => ({ role: a.role, tier: a.tier, cost_usd: a.cost_usd, calls: a.tools?.calls ?? 0, errors: a.tools?.errors ?? 0 })),
      review: r.review ? { findings: r.review.findings, acted_on: r.review.acted_on } : null,
    })),
    outcomes: Object.fromEntries(Object.entries(outcomes).filter(([pr]) => prs.has(pr))),
    lessons: kept.filter((l) => l.status !== 'dismissed' && (scope === 'factory' || inScope(l, scope))).map((l): InsightsLesson => ({
      id: l.id, text: l.text, scope: l.scope, project: l.project, cites: l.cites, status: l.status as 'proposed' | 'kept', uses: l.uses, expires: new Date(expiresAt(l)).toISOString(),
    })),
  };
}
