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
const { writeFileSync, mkdirSync, readFileSync } = await import('node:fs');
const { deflateSync } = await import('node:zlib');

/** A made-up screenshot: a flat PNG of a page's colours, a header band and a few rows, so the viewer has something to show. */
function png(w: number, h: number, bg: [number, number, number], band: [number, number, number]): Buffer {
  const crcTable = Array.from({ length: 256 }, (_, n) => { let c = n; for (let k = 0; k < 8; k++) c = c & 1 ? 0xedb88320 ^ (c >>> 1) : c >>> 1; return c >>> 0; });
  const crc = (b: Buffer) => { let c = 0xffffffff; for (const x of b) c = crcTable[(c ^ x) & 0xff]! ^ (c >>> 8); return (c ^ 0xffffffff) >>> 0; };
  const chunk = (type: string, data: Buffer) => { const t = Buffer.from(type); const len = Buffer.alloc(4); len.writeUInt32BE(data.length); const c = Buffer.alloc(4); c.writeUInt32BE(crc(Buffer.concat([t, data]))); return Buffer.concat([len, t, data, c]); };
  const raw = Buffer.alloc((w * 3 + 1) * h);
  for (let y = 0; y < h; y++) for (let x = 0; x < w; x++) {
    const row = y > 90 && (y - 90) % 70 < 44 && x > 40 && x < w - 40;
    const [r, g, b] = y < 60 ? band : row ? [Math.min(255, bg[0] + 14), Math.min(255, bg[1] + 14), Math.min(255, bg[2] + 14)] : bg;
    raw.set([r, g, b], y * (w * 3 + 1) + 1 + x * 3);
  }
  const ihdr = Buffer.alloc(13); ihdr.writeUInt32BE(w, 0); ihdr.writeUInt32BE(h, 4); ihdr.set([8, 2, 0, 0, 0], 8);
  return Buffer.concat([Buffer.from([137, 80, 78, 71, 13, 10, 26, 10]), chunk('IHDR', ihdr), chunk('IDAT', deflateSync(raw)), chunk('IEND', Buffer.alloc(0))]);
}

const NOW = Date.now();
const ago = (minutes: number) => new Date(NOW - minutes * 60_000).toISOString();
const REPO = { animus: '/work/animus', meal: '/work/meal-planner' };
const SPEC = (title: string, criteria: string[] = []) => `---\nsize: medium\ndifficulty: routine\ntype: feature\n---\n# ${title}\n\n## Problem\n\nMade up for the display's screenshots.\n\n## Acceptance criteria\n\n${criteria.map((c, i) => `${i + 1}. ${c}\n   $ node --test test/c${i + 1}.test.ts`).join('\n')}\n`;

function job(id: string, repo: string, title: string, o: { outcome?: JobState['outcome']; question?: string; running?: { stage: string; who: string; minutes?: number }; spec?: string; extra?: Partial<JobState> } = {}): void {
  const spec = join(jobDir(id), 'spec.md');
  mkdirSync(jobDir(id), { recursive: true });
  writeFileSync(spec, o.spec ?? SPEC(title));
  saveState({ job: id, repo, spec, workspace: {} as JobState['workspace'], plan: {} as JobState['plan'], ...(o.outcome ? { outcome: o.outcome } : {}), ...(o.question ? { question: o.question } : {}), ...o.extra });
  if (o.running) writeJson(join(jobDir(id), 'progress.json'), { stage: o.running.stage, who: o.running.who, at: ago(1), started: ago(o.running.minutes ?? 10), pid: process.pid, host: hostname() });
}

function ran(id: string, repo: string, title: string, started: number, minutes: number, cost: number, o: { outcome: Run['outcome']; pr?: number; reason?: string; question?: string; ms?: Partial<Run['ms']>; extra?: Partial<Run> }): void {
  const project = repo.split('/').at(-1);
  appendRun({
    job: id, repo, submitter: 'sam@example.com', submitter_name: 'Sam Rivera', title, tokens: { input: Math.round(cost * 9_000), output: Math.round(cost * 21_000), cache_read: Math.round(cost * 310_000), cache_write: Math.round(cost * 40_000) }, size: 'medium', difficulty: 'routine', type: 'feature', started: ago(started), ended: ago(started - minutes), outcome: o.outcome, cost_usd: cost,
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
const working = ['A /animus comment on an issue starts a draft', 'A /animus comment on a PR starts a fix', 'The bot replies with the job page link'];
job('comments-on-github', REPO.animus, 'Start and follow work with /animus comments on GitHub', {
  running: { stage: 'implement', who: 'implementer · slice 2 of 3', minutes: 23 }, spec: SPEC('Start and follow work with /animus comments on GitHub', working),
  extra: { slicing: { by: 'planner', slices: [{ title: 'Drafts from issue comments', delivers: 'criterion 1' }, { title: 'Fixes from PR comments', delivers: 'criterion 2' }, { title: 'Replies with the link', delivers: 'criterion 3' }] } as unknown as JobState['slicing'], slices_done: ['1'] },
});
// Its sessions so far: the planner and the first slice's implementer ended (their calls are logged when they end), the second slice's is working.
const call = (minutes: number, stage: string, role: string, session: string, tool: string, target: string, ok = true) => JSON.stringify({ at: ago(minutes), stage, role, session, tool, target, ok, ms: 300 });
writeFileSync(join(jobDir('comments-on-github'), 'tools.jsonl'), [
  call(22, 'plan', 'planner', 'a', 'Read', 'docs/github.md'), call(21.5, 'plan', 'planner', 'a', 'Grep', 'comment'),
  call(19, 'slice-1', 'implementer', 'b', 'Edit', 'helix/src/github.ts'), call(14, 'slice-1', 'implementer', 'b', 'Bash', 'npm test', false), call(9, 'slice-1', 'implementer', 'b', 'Edit', 'helix/src/github.ts'),
  call(0.5, 'slice-2', 'implementer', 'c', 'Read', 'helix/src/pulls.ts'), call(0.2, 'slice-2', 'implementer', 'c', 'Edit', 'helix/src/pulls.ts'),
].join('\n') + '\n');
{
  const p = join(jobDir('comments-on-github'), 'progress.json');
  writeJson(p, { ...JSON.parse(readFileSync(p, 'utf8')), model: 'claude-sonnet-5-5', effort: 'medium' });
}
job('swap-a-meal', REPO.meal, 'Swap a meal for another with the same ingredients', { running: { stage: 'gates', who: 'gates · attempt 1', minutes: 7 } });

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
let sessionAt = 900;
const ag = (stage: string, role: string, tier: string, cost: number, calls: number, errors: number, minutes: number) => ({ stage, role, tier, started: ago((sessionAt -= minutes + 1) + minutes + 1), effort: 'medium', model: tier === 'deep' ? 'claude-opus-5-5' : 'claude-sonnet-5-5', ok: true, status: 'ok', cost_usd: cost, turns: Math.round(calls / 2), tokens: { input: Math.round(cost * 9_000), output: Math.round(cost * 21_000), cache_read: Math.round(cost * 310_000), cache_write: Math.round(cost * 40_000) }, ms: minutes * 60_000, tools: { calls, errors, by_tool: { Bash: calls - 2, Edit: 2 } } });
ran('drafts-from-slack', REPO.animus, 'Drafts from Slack', 900, 41, 6.02, { outcome: 'pr', pr: 16, extra: {
  fix_rounds: 1, gates: [{ attempt: 1, ok: false, ms: 1000, checks: [{ name: 'test', ok: false, skipped: false, ms: 900, flaky: true }] }, { attempt: 2, ok: true, ms: 1000, checks: [] }],
  agents: [ag('plan', 'planner', 'deep', 0.9, 14, 0, 1.5), ag('implement', 'implementer', 'standard', 2.1, 40, 2, 9), ag('implement', 'implementer', 'standard', 1.3, 22, 1, 6), ag('implement', 'implementer', 'standard', 0.7, 18, 1, 4), ag('gate-fix-1', 'implementer', 'standard', 0.4, 9, 0, 2), ag('review-1', 'reviewer', 'deep', 1.02, 20, 0, 5), ag('review-fix-1', 'implementer', 'standard', 0.3, 8, 0, 2), ag('review-2', 'reviewer', 'deep', 0.6, 10, 0, 3)],
  review: { rounds: 2, findings: 2, blockers: 1, acted_on: 1, open: 0, log: [{ round: 1, severity: 'blocker', file: 'helix/src/drafts.ts', line: 88, fate: 'fixed' }, { round: 1, severity: 'should-fix', file: 'helix/src/slack.ts', line: 212, fate: 'not-acted-on' }] },
} as Partial<Run> });
pr(REPO.animus, 16, 'drafts-from-slack', 'MERGED', 400);
Object.assign(outcomes[`https://github.com/example/animus/pull/16`] as object, { human_commits: 2, human_lines: { added: 24, removed: 6 }, reverted: false, reworked: false });
writeFileSync(join(jobDir('drafts-from-slack'), 'tools.jsonl'), ['plan|Read|docs/slack.md', 'implement|Bash|npm test', 'implement|Edit|helix/src/drafts.ts'].map((l, i) => { const [stage, tool, target] = l.split('|'); return JSON.stringify({ at: ago(900 - i), stage, role: stage === 'plan' ? 'planner' : 'implementer', tool, target, ok: true, ms: 120 }); }).join('\n') + '\n');
const shots = join(jobDir('drafts-from-slack'), 'shots', 'build');
mkdirSync(shots, { recursive: true });
const pages: [string, [number, number, number], [number, number, number]][] = [['overview-light', [243, 245, 246], [255, 255, 255]], ['overview-dark', [10, 14, 17], [16, 22, 26]], ['job-page', [243, 245, 246], [25, 200, 240]]];
for (const [name, bg, band] of pages) writeFileSync(join(shots, `${name}.png`), png(1280, 800, bg, band));
writeJson(join(jobDir('drafts-from-slack'), 'shots', 'manifest.json'), { at: ago(860), build: pages.map(([name]) => `build/${name}.png`) });
const gates = join(jobDir('drafts-from-slack'), 'gates');
mkdirSync(gates, { recursive: true });
const list = (test: string) => [`ok   typecheck: npm run typecheck (1.0s)`, `${test} test: npm test (14.7s)`, ...criteria.map((_, i) => `ok   acceptance-${i + 1}: node --test test/c${i + 1}.test.ts (0.${i + 2}s)`)].join('\n');
writeFileSync(join(gates, 'run-1.txt'), `${list('FAIL')}\n\n=== typecheck: npm run typecheck\n\n=== test: npm test\nnot ok 3 - a server left open\n`);
writeFileSync(join(gates, 'run-2.txt'), `${list('ok  ')}\n\n${criteria.map((_, i) => `=== acceptance-${i + 1}: node --test test/c${i + 1}.test.ts\nok ${i + 1} - passes\n`).join('\n')}`);
writeJson(join(jobDir('drafts-from-slack'), 'review-1.json'), { status: 'reviewed', summary: 'One blocker, fixed in the next round.', criteria: [], findings: [
  { severity: 'blocker', file: 'helix/src/drafts.ts', line: 88, problem: "A draft's file upload is retried forever when Slack answers 429.", fix: 'Give up after three tries and say so in the DM.' },
  { severity: 'should-fix', file: 'helix/src/slack.ts', line: 212, problem: 'The DM reply names the spec path on Helix, which the sender cannot open.' },
] });
writeJson(join(jobDir('drafts-from-slack'), 'review-2.json'), { status: 'reviewed', summary: 'The blocker is fixed; nothing new.', criteria: [], findings: [] });
writeFileSync(join(jobDir('drafts-from-slack'), 'pr-body.md'), 'Drafts started in a Slack DM are posted as a file and queue as a job under the sender.\n\n- `/animus draft` starts a draft\n- Submit queues it\n- The manifest asks for files:read and files:write\n');

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
const agent = (role: string, tier: string, cost: number, calls: number, errors: number) => ({ stage: role === 'reviewer' ? 'review' : 'implement', role, tier, effort: 'medium', model: tier === 'deep' ? 'claude-opus-5-5' : 'claude-sonnet-5-5', ok: true, status: 'ok', cost_usd: cost, turns: 10, tokens: { input: Math.round(cost * 9_000), output: Math.round(cost * 21_000), cache_read: Math.round(cost * 310_000), cache_write: Math.round(cost * 40_000) }, ms: 1000, tools: { calls, errors, by_tool: {} } });
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
      agents: [agent('implementer', 'standard', cost * 0.7, 60 + i, i % 4 === 0 ? 3 : 1), agent('reviewer', 'deep', cost * 0.3, 20 + i, 0)],
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
