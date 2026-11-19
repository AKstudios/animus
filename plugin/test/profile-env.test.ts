import assert from 'node:assert/strict';
import { mkdtempSync, readFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { test } from 'node:test';
import { readRuns } from '../src/log.ts';
import { runJob } from '../src/pipeline.ts';
import { parseProfile } from '../src/profile.ts';
import { git } from '../src/proc.ts';
import { uiDown, uiTarget, uiUp } from '../src/ui.ts';
import { clean, deps, done, fakeAgent, makeRepo, write, writeSpec, type Step } from './helpers.ts';

const say = (text: string): Step => (req) => {
  write(req.cwd, 'src/feature.txt', `${text}\n`);
  git(req.cwd, ['add', '-A']); git(req.cwd, ['commit', '-qm', `say ${text}`]);
  return done();
};

test('env is a map of names to text and secrets a list of names', () => {
  const p = parseProfile('env:\n  NODE_ENV: test\n  RETRIES: 3\nsecrets: [STRIPE_TEST_KEY]\n');
  assert.deepEqual(p.env, { NODE_ENV: 'test', RETRIES: '3' });
  assert.deepEqual(p.secrets, ['STRIPE_TEST_KEY']);
  assert.deepEqual([parseProfile('').env, parseProfile('').secrets], [{}, []]);
});

// Protects: the profile cannot set what Animus or Helix sets, nor say one name twice. Fails when: such a profile loads.
for (const [yaml, error] of [
  ['env: { KEY: a }\nsecrets: [KEY]\n', /KEY is in both env and secrets/],
  ['env: { ANIMUS_HOME: /x }\n', /env\.ANIMUS_HOME: Animus or Helix sets ANIMUS_HOME itself/],
  ['secrets: [HELIX_TOKEN]\n', /secrets: Animus or Helix sets HELIX_TOKEN itself/],
  ['env: { PATH: /bin }\n', /sets PATH itself/],
  ['env: { HOME: /x }\n', /sets HOME itself/],
  ['secrets: [GH_TOKEN]\n', /sets GH_TOKEN itself/],
  ['secrets: [CLAUDE_CODE_OAUTH_TOKEN]\n', /sets CLAUDE_CODE_OAUTH_TOKEN itself/],
  ['env: { "MY-VAR": a }\n', /MY-VAR is not a variable name/],
  ['env: { A: [1] }\n', /env\.A must be text/],
  ['secrets: KEY\n', /secrets must list names/],
] as const) {
  test(`a profile with ${yaml.trim().replace(/\n/g, '; ')} is refused`, () => {
    assert.throws(() => parseProfile(yaml), error);
  });
}

// Protects: criterion 1 on one machine (and in a Helix container, which runs the same job process). Fails when: a step of the job runs without the profile's env.
test('env reaches setup, installs, gates, a ui target\'s serve command and the agent session', async () => {
  const seen = join(mkdtempSync(join(tmpdir(), 'animus-env-')), 'seen.txt');
  const repo = makeRepo();
  write(repo, '.animus/animus.yaml', [
    'env:', '  GREETING_ENV_TEST: hello there',
    `setup: echo "setup $GREETING_ENV_TEST" >> ${seen}`,
    'installs:', `  - { path: deps, key: .animus/animus.yaml, run: 'mkdir -p deps && echo "install $GREETING_ENV_TEST" >> ${seen}' }`,
    'commands:', `  test: echo "gate $GREETING_ENV_TEST" >> ${seen} && grep -q done src/feature.txt`,
    'ui:', '  targets:', '    app:', '      kind: app',
    `      serve: echo "serve $GREETING_ENV_TEST" >> ${seen}; sleep 30`,
    `      ready: grep -q serve ${seen}`, '      capture: "true"', '      pages: { home: home }', '',
  ].join('\n'));
  git(repo, ['commit', '-qam', 'env']);
  let agentSaw: string | undefined;
  const { agent } = fakeAgent([(req) => { agentSaw = process.env.GREETING_ENV_TEST; return say('done')(req); }, () => clean()]);
  const d = deps(agent, {
    shots: async (cwd, job, profile, dir) => {
      await uiUp(cwd, uiTarget(profile, job)!);
      uiDown(cwd);
      return { dir, reused: false, shots: { job: job.id, target: 'app', tree: 't', at: '', build: ['build/home.png'], reference: [], design: 'missing' } };
    },
  });
  const run = await runJob({ repo, specFile: writeSpec('size: small\ndifficulty: routine\ntype: ui', '1. The feature says done.\n   $ grep -q done src/feature.txt\n') }, d);
  assert.equal(run.outcome, 'pr', run.reason);
  assert.equal(agentSaw, 'hello there');
  const lines = new Set(readFileSync(seen, 'utf8').trim().split('\n'));
  assert.deepEqual([...lines].sort(), ['gate hello there', 'install hello there', 'serve hello there', 'setup hello there']);
});

// Protects: criterion 5. Fails when: a job starts while a secret is unset, or the refusal does not name it; or a set one does not reach the gates.
test('a secret unset in the queue\'s environment refuses the spec at admit, naming it; once set, the job has it', async () => {
  const repo = makeRepo();
  write(repo, '.animus/animus.yaml', 'secrets: [PAYMENTS_TEST_KEY]\ncommands:\n  test: test "$PAYMENTS_TEST_KEY" = sk_test_123 && grep -q done src/feature.txt\n');
  git(repo, ['commit', '-qam', 'secret']);
  const spec = () => writeSpec('size: small\ndifficulty: routine\ntype: feature');

  const refused = fakeAgent([]);
  await assert.rejects(runJob({ repo, specFile: spec() }, deps(refused.agent)), /PAYMENTS_TEST_KEY is not set/);
  assert.equal(refused.calls.length, 0);
  assert.equal(readRuns().find((r) => r.repo === repo)!.cause, 'admit');

  process.env.PAYMENTS_TEST_KEY = 'sk_test_123';
  try {
    const run = await runJob({ repo, specFile: spec() }, deps(fakeAgent([say('done'), () => clean()]).agent));
    assert.equal(run.outcome, 'pr', run.reason);
  } finally { delete process.env.PAYMENTS_TEST_KEY; }
});
