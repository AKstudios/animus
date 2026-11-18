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

function ran(id: string, repo: string, title: string, started: number, minutes: number, cost: number, o: { outcome: Run['outcome']; pr?: number; reason?: string; question?: string; ms?: Partial<Run['ms']> }): void {
  const project = repo.split('/').at(-1);
  appendRun({
    job: id, repo, submitter: 'ajmal', title, started: ago(started), ended: ago(started - minutes), outcome: o.outcome, cost_usd: cost,
    ...(o.pr ? { pr: `https://github.com/example/${project}/pull/${o.pr}` } : {}), ...(o.reason ? { reason: o.reason } : {}), ...(o.question ? { question: o.question } : {}),
    ms: { queue: 0, setup: 20_000, plan: 100_000, implement: minutes * 36_000, gates: minutes * 10_000, review: minutes * 9_000, evidence: 30_000, pr: 12_000, total: minutes * 60_000, ...o.ms },
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
ran('animus-fix', REPO.animus, '/animus fix on a PR continues its branch', 40, 12, 1.84, { outcome: 'needs-input', question: asked });

// Open, merged, closed and failed.
job('room', REPO.animus, "Jobs start from the machine's free memory and load", { outcome: 'pr' });
ran('room', REPO.animus, "Jobs start from the machine's free memory and load", 300, 28, 3.9, { outcome: 'pr', pr: 20 });
pr(REPO.animus, 20, 'room', 'OPEN');

const criteria = ['/animus draft in a DM starts a draft and posts it as a file', 'Submit on a draft queues it as a job under the sender', 'The manifest asks for files:read and files:write'];
job('drafts-from-slack', REPO.animus, 'Drafts from Slack', {
  outcome: 'pr', spec: SPEC('Drafts from Slack', criteria),
  extra: { slicing: { by: 'planner', slices: [{ title: 'Drafts in a DM', delivers: 'criterion 1' }, { title: 'Submit from a draft', delivers: 'criterion 2' }, { title: 'Manifest scopes', delivers: 'criterion 3' }] } as unknown as JobState['slicing'], slices_done: ['1', '2', '3'] },
});
ran('drafts-from-slack', REPO.animus, 'Drafts from Slack', 900, 41, 6.02, { outcome: 'pr', pr: 16 });
pr(REPO.animus, 16, 'drafts-from-slack', 'MERGED', 400);
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
ran('github-sign-in', REPO.animus, "Join Helix with GitHub's sign-in", 1500, 6, 0.8, { outcome: 'failed', reason: 'The gates still failed after 2 fix rounds: test' });
writeJson(outcomesFile(), outcomes);

const server = localServer();
const port = await listenLocal(server, Number(process.env.PORT ?? 7421));
console.log(`The display, from made-up jobs, at http://127.0.0.1:${port}`);
const stop = () => { server.close(); process.exit(0); };
process.once('SIGTERM', stop);
process.once('SIGINT', stop);
