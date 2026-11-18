import assert from 'node:assert/strict';
import { spawnSync } from 'node:child_process';
import { mkdtempSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { test } from 'node:test';
import { runJob } from '../src/pipeline.ts';
import { describeJob } from '../src/remote.ts';
import { clean, deps, done, fakeAgent, makeRepo, writeSpec } from './helpers.ts';

// Protects: a job on this machine says where to watch it, right after its job line. Fails when: the line is missing, has no page path, or comes before the job line.
test('a job on this machine prints watch it: animus ui with its page path right after the job line', async () => {
  const { agent } = fakeAgent([() => done(), () => clean()]);
  const d = deps(agent);
  const run = await runJob({ repo: makeRepo(), specFile: writeSpec('size: small\ndifficulty: routine\ntype: feature'), dryRun: true }, d);

  const at = d.lines.findIndex((l) => l.startsWith(`job ${run.job}:`));
  assert.equal(d.lines[at + 1], `watch it: animus ui, then open /jobs/${run.job}`);
});

// Protects: animus start puts the watch line right after the where-it-runs line. Fails when: it lands after the job line or apart from the runs line.
test('with a where-it-runs line, the watch line follows it and comes before the job line', async () => {
  const { agent } = fakeAgent([() => done(), () => clean()]);
  const d = deps(agent);
  const run = await runJob({ repo: makeRepo(), specFile: writeSpec('size: small\ndifficulty: routine\ntype: feature'), dryRun: true, runsLine: 'this job runs on this machine: because' }, d);

  assert.deepEqual(d.lines.slice(0, 3), ['this job runs on this machine: because', `watch it: animus ui, then open /jobs/${run.job}`, `job ${run.job}: Say done`]);
});

// Protects: a Helix that predates links still prints status. Fails when: describeJob requires links.
test('describeJob shows links only when Helix sent them', () => {
  const j = { id: 4, state: 'running', person: 'ana', repo: 'app', title: 'T', submitted: '2026-01-01T00:00:00Z' };
  assert.doesNotMatch(describeJob(j), /watch it/);
  assert.match(describeJob({ ...j, links: ['Tailscale: https://h.ts.net/jobs/4'] }), /watch it:\n {4}Tailscale: https:\/\/h\.ts\.net\/jobs\/4/);
});

// Protects: the CLI wires the where-it-runs line into the job, so `animus start` itself prints the watch line next. Fails when: cli.ts stops passing runsLine, or prints the runs line apart from the watch line.
test('animus start --local prints where it runs, then the watch line, then the job line', () => {
  const cli = join(import.meta.dirname, '..', 'src', 'cli.ts');
  const repo = makeRepo();
  const spec = writeSpec('size: small\ndifficulty: routine\ntype: feature');
  const home = mkdtempSync(join(tmpdir(), 'animus-home-'));
  // A Claude command that cannot start: the job stops at its first session, after the lines this checks, and no model runs.
  const env = { ...process.env, ANIMUS_HOME: home, ANIMUS_CLAUDE: join(home, 'no-such-claude') };
  const r = spawnSync(process.execPath, ['--disable-warning=ExperimentalWarning', cli, 'start', spec, '--local', '--dry-run', '--repo', repo], { env, encoding: 'utf8', timeout: 60_000 });
  const lines = `${r.stdout}${r.stderr}`.split('\n');

  const at = lines.findIndex((l) => l.startsWith('this job runs on this machine:'));
  assert.ok(at >= 0, `no where-it-runs line in:\n${lines.join('\n')}`);
  const job = /^watch it: animus ui, then open \/jobs\/(\S+)$/.exec(lines[at + 1] ?? '')?.[1];
  assert.ok(job, `no watch line after the where-it-runs line in:\n${lines.join('\n')}`);
  assert.match(lines[at + 2] ?? '', new RegExp(`^job ${job}: `));
});
