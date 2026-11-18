import assert from 'node:assert/strict';
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

// Protects: a Helix that predates links still prints status. Fails when: describeJob requires links.
test('describeJob shows links only when Helix sent them', () => {
  const j = { id: 4, state: 'running', person: 'ana', repo: 'app', title: 'T', submitted: '2026-01-01T00:00:00Z' };
  assert.doesNotMatch(describeJob(j), /watch it/);
  assert.match(describeJob({ ...j, links: ['Tailscale: https://h.ts.net/jobs/4'] }), /watch it:\n {4}Tailscale: https:\/\/h\.ts\.net\/jobs\/4/);
});
