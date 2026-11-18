import assert from 'node:assert/strict';
import { spawnSync } from 'node:child_process';
import { readFileSync } from 'node:fs';
import { test } from 'node:test';
import { toolCalls } from '../src/agent.ts';
import { toolsLog } from '../src/log.ts';
import { runJob } from '../src/pipeline.ts';
import { cli, clean, deps, done, fakeAgent, makeRepo, toolTranscript, write, writeSpec } from './helpers.ts';

const calls = [
  { tool: 'Bash', input: { command: 'npm test' }, failed: true },
  { tool: 'Read', input: { file_path: 'src/app.txt' } },
  { tool: 'Grep', input: { pattern: 'done' } },
  { tool: 'WebFetch', input: { url: 'https://example.test/' } },
  { tool: 'Bash', input: { command: 'x'.repeat(400) } },
];

// Protects: the transcript format is read into neutral lines. Fails when a target, failure or duration is lost, or output leaks.
test('reads a transcript into calls with target, failure and duration, never the output', () => {
  const got = toolCalls(toolTranscript(calls));
  assert.deepEqual(got.map((c) => [c.tool, c.ok, c.ms]), [['Bash', false, 1000], ['Read', true, 1000], ['Grep', true, 1000], ['WebFetch', true, 1000], ['Bash', true, 1000]]);
  assert.deepEqual(got.slice(0, 4).map((c) => c.target), ['npm test', 'src/app.txt', 'done', 'https://example.test/']);
  assert.equal(got[4]!.target.length, 300);
  assert.ok(!JSON.stringify(got).includes('SECRET OUTPUT'));
});

// Protects: a job leaves tools.jsonl, the run log counts, and `animus tools` shows them. Fails when any link is missing.
test('a job writes tools.jsonl and the run log counts; animus tools lists sessions and calls', async () => {
  const { agent } = fakeAgent([
    (req) => { write(req.cwd, 'src/feature.txt', 'done\n'); return { ...done(), tools: toolCalls(toolTranscript(calls)) }; },
    () => clean(),
  ]);
  const run = await runJob({ repo: makeRepo(), specFile: writeSpec('size: small\ndifficulty: routine\ntype: feature') }, deps(agent));

  assert.deepEqual(run.agents[0]!.tools, { calls: 5, errors: 1, by_tool: { Bash: 2, Read: 1, Grep: 1, WebFetch: 1 } });
  assert.equal(run.agents[1]!.tools, undefined);
  const lines = readFileSync(toolsLog(run.job), 'utf8').trim().split('\n').map((l) => JSON.parse(l));
  assert.equal(lines.length, 5);
  assert.deepEqual([lines[0].stage, lines[0].role, lines[0].tool, lines[0].target, lines[0].ok], [run.agents[0]!.stage, 'implementer', 'Bash', 'npm test', false]);

  const text = spawnSync(process.execPath, ['--disable-warning=ExperimentalWarning', cli, 'tools', run.job], { encoding: 'utf8' });
  assert.equal(text.status, 0, text.stderr);
  assert.match(text.stdout, /implementer\s+\S+\s+\S+\s+5 calls, 1 failed: Bash 2, Read 1, Grep 1, WebFetch 1/);
  assert.match(text.stdout, /Bash\s+npm test\s+FAILED/);
  const json = spawnSync(process.execPath, ['--disable-warning=ExperimentalWarning', cli, 'tools', run.job, '--json'], { encoding: 'utf8' });
  assert.deepEqual(json.stdout.trim().split('\n').map((l) => JSON.parse(l)), lines);
});

test('animus tools names the problem for a job with no run', () => {
  const r = spawnSync(process.execPath, ['--disable-warning=ExperimentalWarning', cli, 'tools', 'no-such-job'], { encoding: 'utf8' });
  assert.equal(r.status, 2);
  assert.match(r.stderr, /no run of job no-such-job/);
});
