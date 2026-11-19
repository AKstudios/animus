// The display, served from made-up jobs: the ui target `display` in
// .animus/animus.yaml, so a display job's screenshots show every section
// (a question waiting, agents working, open, merged, closed and failed PRs)
// without anyone's real jobs. Writes a fresh Animus home in the temp folder,
// serves the local display from it on $PORT, and stops on SIGTERM or Ctrl-C.
// Its working jobs show as running because this process is the one their
// progress names.
import { mkdtempSync } from 'node:fs';
import { hostname, tmpdir } from 'node:os';
import { join } from 'node:path';

process.env.ANIMUS_HOME = mkdtempSync(join(tmpdir(), 'animus-display-'));
const { appendRun, jobDir, saveState, writeJson } = await import('../plugin/src/log.ts');
type JobState = import('../plugin/src/log.ts').JobState;
type Run = import('../plugin/src/log.ts').Run;
const { outcomesFile } = await import('../plugin/src/outcomes.ts');
const { listenLocal, localServer } = await import('../plugin/src/local-display.ts');
const { writeFileSync, mkdirSync } = await import('node:fs');

const NOW = Date.now();
const ago = (minutes: number) => new Date(NOW - minutes * 60_000).toISOString();
const REPO = { animus: '/work/animus', meal: '/work/meal-planner' };
const SPEC = (title: string, criteria: string[] = []) => `---\nsize: medium\ndifficulty: routine\ntype: feature\n---\n# ${title}\n\n## Problem\n\nMade up for the display's screenshots.\n\n## Acceptance criteria\n\n${criteria.map((c, i) => `${i + 1}. ${c}\n   $ node --test test/c${i + 1}.test.ts`).join('\n')}\n`;

function job(id: string, repo: string, title: string, o: { outcome?: JobState['outcome']; question?: string; running?: { stage: string; who: string }; spec?: string; extra?: Partial<JobState> } = {}): void {
  const spec = join(jobDir(id), 'spec.md');
  mkdirSync(jobDir(id), { recursive: true });
  writeFileSync(spec, o.spec ?? SPEC(title));
  saveState({ job: id, repo, spec, workspace: {} as JobState['workspace'], plan: {} as JobState['plan'], ...(o.outcome ? { outcome: o.outcome } : {}), ...(o.question ? { question: o.question } : {}), ...o.extra });
  if (o.running) writeJson(join(jobDir(id), 'progress.json'), { ...o.running, at: ago(1), pid: process.pid, host: hostname() });
}

function ran(id: string, repo: string, title: string, started: number, minutes: number, cost: number, o: { outcome: Run['outcome']; pr?: number; reason?: string; question?: string; ms?: Partial<Run['ms']>; extra?: Partial<Run> }): void {
  const project = repo.split('/').at(-1);
  appendRun({
    job: id, repo, submitter: 'ajmal', title, size: 'medium', difficulty: 'routine', type: 'feature', started: ago(started), ended: ago(started - minutes), outcome: o.outcome, cost_usd: cost,
    ...(o.pr ? { pr: `https://github.com/example/${project}/pull/${o.pr}` } : {}), ...(o.reason ? { reason: o.reason } : {}), ...(o.question ? { question: o.question } : {}),
    ms: { queue: 0, setup: 20_000, plan: 100_000, implement: minutes * 36_000, gates: minutes * 10_000, review: minutes * 9_000, evidence: 30_000, pr: 12_000, total: minutes * 60_000, ...o.ms },
    ...o.extra,
  } as Run);
}

const outcomes: Record<string, unknown> = {};
const pr = (repo: string, n: number, id: string, state: 'OPEN' | 'MERGED' | 'CLOSED', closedAgo?: number) => {
  const url = `https://github.com/example/${repo.split('/').at(-1)}/pull/${n}`;
  outcomes[url] = { pr: url, job: id, state, opened: ago(600), human_commits: 0, checked: ago(1), ...(closedAgo !== undefined ? { closed: ago(closedAgo) } : {}) };
};

// Working now.
job('comments-on-github', REPO.animus, 'Start and follow work with /animus comments on GitHub', { running: { stage: 'implement', who: 'implementer · slice 2 of 3' } });
job('swap-a-meal', REPO.meal, 'Swap a meal for another with the same ingredients', { running: { stage: 'gates', who: 'gates · attempt 1' } });

// Needs you.
const asked = 'Should a /animus comment on a closed issue start a draft, or be ignored with a reply saying the issue is closed?';
job('animus-fix', REPO.animus, '/animus fix on a PR continues its branch', { outcome: 'needs-input', question: asked });
ran('animus-fix', REPO.animus, '/animus fix on a PR continues its branch', 40, 12, 1.84, { outcome: 'needs-input', question: asked, extra: { cause: 'needs-input' } });

// Open, merged, closed and failed.
job('room', REPO.animus, "Jobs start from the machine's free memory and load", { outcome: 'pr' });
ran('room', REPO.animus, "Jobs start from the machine's free memory and load", 300, 28, 3.9, { outcome: 'pr', pr: 20 });
pr(REPO.animus, 20, 'room', 'OPEN');

const criteria = ['/animus draft in a DM starts a draft and posts it as a file', 'Submit on a draft queues it as a job under the sender', 'The manifest asks for files:read and files:write'];
job('drafts-from-slack', REPO.animus, 'Drafts from Slack', {
  outcome: 'pr', spec: SPEC('Drafts from Slack', criteria),
  extra: { slicing: { by: 'planner', slices: [{ title: 'Drafts in a DM', delivers: 'criterion 1' }, { title: 'Submit from a draft', delivers: 'criterion 2' }, { title: 'Manifest scopes', delivers: 'criterion 3' }] } as unknown as JobState['slicing'], slices_done: ['1', '2', '3'] },
});
const ag = (stage: string, role: string, tier: string, cost: number, calls: number, errors: number) => ({ stage, role, tier, effort: 'medium', model: tier, ok: true, status: 'ok', cost_usd: cost, turns: 10, tokens: { input: 0, output: 0, cache_read: 0, cache_write: 0 }, ms: 1000, tools: { calls, errors, by_tool: { Bash: calls - 2, Edit: 2 } } });
ran('drafts-from-slack', REPO.animus, 'Drafts from Slack', 900, 41, 6.02, { outcome: 'pr', pr: 16, extra: {
  fix_rounds: 1, gates: [{ attempt: 1, ok: false, ms: 1000, checks: [{ name: 'test', ok: false, skipped: false, ms: 900, flaky: true }] }, { attempt: 2, ok: true, ms: 1000, checks: [] }],
  agents: [ag('plan', 'planner', 'opus', 0.9, 14, 0), ag('implement', 'implementer', 'sonnet', 3.4, 62, 3), ag('implement', 'implementer', 'sonnet', 0.7, 18, 1), ag('review', 'reviewer', 'opus', 1.02, 20, 0)],
  review: { rounds: 1, findings: 2, blockers: 1, acted_on: 1, open: 0, log: [{ round: 1, severity: 'blocker', file: 'helix/src/drafts.ts', line: 88, fate: 'fixed' }, { round: 1, severity: 'should-fix', file: 'helix/src/slack.ts', line: 212, fate: 'not-acted-on' }] },
} as Partial<Run> });
pr(REPO.animus, 16, 'drafts-from-slack', 'MERGED', 400);
Object.assign(outcomes[`https://github.com/example/animus/pull/16`] as object, { human_commits: 2, human_lines: { added: 24, removed: 6 }, reverted: false, reworked: false });
writeFileSync(join(jobDir('drafts-from-slack'), 'tools.jsonl'), ['plan|Read|docs/slack.md', 'implement|Bash|npm test', 'implement|Edit|helix/src/drafts.ts'].map((l, i) => { const [stage, tool, target] = l.split('|'); return JSON.stringify({ at: ago(900 - i), stage, role: stage === 'plan' ? 'planner' : 'implementer', tool, target, ok: true, ms: 120 }); }).join('\n') + '\n');
const gates = join(jobDir('drafts-from-slack'), 'gates');
mkdirSync(gates, { recursive: true });
const list = (test: string) => [`ok   typecheck: npm run typecheck (1.0s)`, `${test} test: npm test (14.7s)`, ...criteria.map((_, i) => `ok   acceptance-${i + 1}: node --test test/c${i + 1}.test.ts (0.${i + 2}s)`)].join('\n');
writeFileSync(join(gates, 'run-1.txt'), `${list('FAIL')}\n\n=== typecheck: npm run typecheck\n\n=== test: npm test\nnot ok 3 - a server left open\n`);
writeFileSync(join(gates, 'run-2.txt'), `${list('ok  ')}\n\n${criteria.map((_, i) => `=== acceptance-${i + 1}: node --test test/c${i + 1}.test.ts\nok ${i + 1} - passes\n`).join('\n')}`);
writeJson(join(jobDir('drafts-from-slack'), 'review-1.json'), { status: 'reviewed', summary: 'One blocker, fixed in the next round.', criteria: [], findings: [
  { severity: 'blocker', file: 'helix/src/drafts.ts', line: 88, problem: "A draft's file upload is retried forever when Slack answers 429.", fix: 'Give up after three tries and say so in the DM.' },
  { severity: 'should-fix', file: 'helix/src/slack.ts', line: 212, problem: 'The DM reply names the spec path on Helix, which the sender cannot open.' },
] });

for (const [id, repo, title, n, state, at, minutes, cost] of [
  ['slack-rename', REPO.animus, "Slack's command is /animus and its bot is Animus", 19, 'MERGED', 120, 2, 0.46],
  ['shop-ticks', REPO.meal, 'Clear ticks on the Shop tab', 24, 'MERGED', 200, 2, 0.17],
  ['facebook-link', REPO.meal, 'A Facebook link is named Facebook', 21, 'CLOSED', 2000, 9, 0.06],
] as const) {
  job(id, repo, title, { outcome: 'pr' });
  ran(id, repo, title, at + 60, minutes, cost, { outcome: 'pr', pr: n });
  pr(repo, n, id, state, at);
}
job('github-sign-in', REPO.animus, "Join Helix with GitHub's sign-in", { outcome: 'failed' });
ran('github-sign-in', REPO.animus, "Join Helix with GitHub's sign-in", 1500, 6, 0.8, { outcome: 'failed', reason: 'The gates still failed after 2 fix rounds: test', extra: { cause: 'gates' } });

// Two months of finished jobs for the Insights page: the last 30 days against the 30 before. Each is
// [class, project, days ago, minutes, cost, how it ended, human commits, undone, first time through the gates, flaky check].
const DAY_MIN = 1440;
const agent = (role: string, tier: string, cost: number, calls: number, errors: number) => ({ stage: 'implement', role, tier, effort: 'medium', model: tier, ok: true, status: 'ok', cost_usd: cost, turns: 10, tokens: {}, ms: 1000, tools: { calls, errors, by_tool: {} } });
type Ended = 'merged' | 'open' | 'closed' | 'gates' | 'asked' | 'budget';
const past: [string, string, number, number, number, Ended, number, boolean, boolean, string?][] = [
  ['small|trivial|fix', 'meal', 3, 4, 0.4, 'merged', 0, false, true], ['medium|routine|feature', 'animus', 5, 22, 3.1, 'merged', 0, false, true, 'test'],
  ['medium|routine|feature', 'animus', 8, 30, 4.2, 'merged', 2, false, false], ['small|routine|fix', 'meal', 11, 9, 0.9, 'merged', 0, false, true],
  ['large|routine|ui', 'animus', 14, 48, 7.6, 'merged', 1, true, false, 'test'], ['medium|hard|feature', 'animus', 17, 35, 5.4, 'gates', 0, false, false],
  ['small|trivial|fix', 'meal', 20, 3, 0.3, 'merged', 0, false, true], ['medium|routine|feature', 'meal', 23, 19, 2.6, 'closed', 0, false, false],
  ['medium|routine|feature', 'animus', 26, 25, 3.5, 'asked', 0, false, true], ['small|routine|fix', 'animus', 28, 8, 0.8, 'merged', 0, false, true],
  ['medium|routine|feature', 'animus', 33, 26, 4.4, 'merged', 3, false, false], ['small|routine|fix', 'meal', 38, 11, 1.2, 'merged', 1, false, true],
  ['medium|routine|feature', 'animus', 42, 31, 5.1, 'gates', 0, false, false], ['large|routine|ui', 'animus', 47, 52, 8.9, 'merged', 2, true, false],
  ['small|trivial|fix', 'meal', 51, 5, 0.5, 'budget', 0, false, true], ['medium|routine|feature', 'meal', 55, 24, 3.8, 'merged', 1, false, false],
];
past.forEach(([cls, proj, days, minutes, cost, end, humans, undone, first, flaky], i) => {
  const [size, difficulty, type] = cls.split('|') as [string, string, string];
  const repo = REPO[proj as 'animus' | 'meal'], id = `past-${i}`, n = 100 + i;
  const delivered = end === 'merged' || end === 'open' || end === 'closed';
  ran(id, repo, `Made-up job ${i + 1}`, days * DAY_MIN + minutes, minutes, cost, {
    outcome: delivered ? 'pr' : end === 'asked' ? 'needs-input' : 'failed', ...(delivered ? { pr: n } : {}),
    extra: {
      size, difficulty, type, fix_rounds: first ? 0 : 1, ...(delivered ? {} : { cause: end === 'asked' ? 'needs-input' : end === 'budget' ? 'budget' : 'gates' }),
      gates: [{ attempt: 1, ok: first || Boolean(flaky), ms: 1000, checks: [{ name: 'test', ok: first || Boolean(flaky), skipped: false, ms: 900, ...(flaky ? { flaky: true } : {}) }] }],
      agents: [agent('implementer', 'sonnet', cost * 0.7, 60 + i, i % 4 === 0 ? 3 : 1), agent('reviewer', 'opus', cost * 0.3, 20 + i, 0)],
      review: delivered ? { rounds: 1, findings: 3, blockers: 0, acted_on: first ? 3 : 2, open: 0 } : null,
    } as Partial<Run>,
  });
  if (delivered) {
    const url = `https://github.com/example/${repo.split('/').at(-1)}/pull/${n}`;
    outcomes[url] = { pr: url, job: id, state: end === 'merged' ? 'MERGED' : end === 'open' ? 'OPEN' : 'CLOSED', opened: ago(days * DAY_MIN), human_commits: humans, checked: ago(1), ...(undone ? { reverted: true } : {}) };
  }
});
writeJson(outcomesFile(), outcomes);
writeJson(join(process.env.ANIMUS_HOME!, 'lessons.json'), { next: 5, lessons: [
  { id: 1, text: 'Run the full test file, not one test, before saying the gates pass.', scope: 'project', project: 'animus', agent: 'implementer', cites: ['past-2', 'past-4'], status: 'proposed', created: ago(3 * DAY_MIN), uses: 0 },
  { id: 4, text: 'Say in the DM when an upload gives up, not only in the log.', scope: 'project', project: 'animus', agent: 'implementer', cites: ['drafts-from-slack'], status: 'proposed', created: ago(2 * DAY_MIN), uses: 0 },
  { id: 2, text: "Check the Slack manifest's scopes when a command is added.", scope: 'factory', project: 'animus', agent: 'planner', cites: ['drafts-from-slack'], status: 'kept', created: ago(30 * DAY_MIN), acceptedAt: ago(20 * DAY_MIN), uses: 7 },
  { id: 3, text: 'A shopping list keeps its order when an item is ticked.', scope: 'project', project: 'meal-planner', agent: 'implementer', cites: ['shop-ticks'], status: 'kept', created: ago(25 * DAY_MIN), acceptedAt: ago(12 * DAY_MIN), uses: 2 },
] });

const server = localServer();
const port = await listenLocal(server, Number(process.env.PORT ?? 7421));
console.log(`The display, from made-up jobs, at http://127.0.0.1:${port}`);
const stop = () => { server.close(); process.exit(0); };
process.once('SIGTERM', stop);
process.once('SIGINT', stop);
