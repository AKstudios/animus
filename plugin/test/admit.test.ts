import assert from 'node:assert/strict';
import { spawnSync } from 'node:child_process';
import { chmodSync, existsSync, mkdtempSync, readFileSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';
import { test } from 'node:test';
import { tmpdir } from 'node:os';
import { admit, type Facts } from '../src/admit.ts';
import { runJob } from '../src/pipeline.ts';
import { parseProfile } from '../src/profile.ts';
import { loadFactory } from '../src/profiles.ts';
import { git } from '../src/proc.ts';
import { parseSpec } from '../src/spec.ts';
import { takeShots } from '../src/ui.ts';
import { cli, deps, fakeAgent, makeRepo, write, writeSpec } from './helpers.ts';

const factory = loadFactory();

const PROFILE = `
base: main
commands:
  test: npm test
ui:
  targets:
    web:
      url: http://127.0.0.1:$PORT
      ready: "true"
      viewports: [1280x800]
      pages: { home: /, pricing: /pricing }
`;

const TWO_TARGETS = `${PROFILE}    admin:
      url: http://127.0.0.1:$PORT
      pages: { home: / }
`;

/** What admit is told of a project whose base is `main` and which has design/ok.png. */
const facts = (profile: string, over: Partial<Facts> = {}): Facts => ({
  profile: parseProfile(profile), read: 'main on GitHub',
  hasBranch: (b) => b === 'main', hasPath: (b, p) => b === 'main' && p === 'design/ok.png', ...over,
});

const spec = (header: string, criteria = '1. It works.\n   $ node check.js') => `---\n${header}\n---\n# Subscribe\n\nWhy.\n\n## Acceptance criteria\n\n${criteria}\n`;

function plan(repoProfile: string, specHeader: string, criteria?: string) {
  const repo = makeRepo();
  write(repo, '.animus/animus.yaml', repoProfile);
  return spawnSync(process.execPath, ['--disable-warning=ExperimentalWarning', cli, 'plan', writeSpec(specHeader, criteria), '--repo', repo], { encoding: 'utf8', env: process.env });
}

// Protects: animus plan tells a person what a UI job will screenshot. Fails when: the target or a page is missing from its output, or a literal path is dropped.
test('animus plan on a ui spec shows the target and the pages it will screenshot', () => {
  const r = plan(PROFILE, 'type: ui\nui: { pages: [pricing, /masjid/subscribe] }');
  assert.equal(r.status, 0, r.stdout + r.stderr);
  assert.match(r.stdout, /target\s+web \(web\)/);
  assert.match(r.stdout, /pages\s+pricing \/pricing, masjid-subscribe \/masjid\/subscribe/);
  assert.match(r.stdout, /gates\s+test: npm test/);
});

// Protects: no target is guessed. Fails when: a spec naming none is admitted with several targets, or the refusal does not list them or exit 1.
test('animus plan refuses a ui spec that names no target when the profile has several, listing them, and exits 1', () => {
  const r = plan(TWO_TARGETS, 'type: ui');
  assert.equal(r.status, 1);
  assert.match(r.stdout, /\[spec\] the profile has several ui targets \(web, admin\)/);
});

// Protects: one refusal lists every problem, each marked, a profile one with its YAML and source. Fails when: admit stops at the first, loses a marker, or a profile problem lacks the YAML or branch.
test('a spec with several problems is refused with all of them, each marked spec or profile', () => {
  const a = admit(factory, spec('sise: small\ntype: ui\nbase: nope\nui: { target: web, pages: [nowhere] }'), facts(PROFILE));
  const said = a.problems.map((p) => `${p.who}: ${p.what}`);
  assert.equal(a.problems.length, 3, said.join('\n'));
  assert.match(said[0]!, /^spec: sise is not a key of a spec's header: did you mean size\?/);
  assert.match(said[1]!, /^spec: base nope is not a branch/);
  assert.match(said[2]!, /^profile: nowhere is not a page of ui target web \(home, pricing\)/);
  assert.deepEqual(a.problems[2], { who: 'profile', what: a.problems[2]!.what, add: 'ui:\n  targets:\n    web:\n      pages:\n        nowhere: <its path>', from: 'main on GitHub' });
  // The design file is checked on the base branch only when there is one.
  const withBase = admit(factory, spec('type: ui\ndesign: [design/ok.png, design/missing.png]'), facts(PROFILE));
  assert.deepEqual(withBase.problems.map((p) => p.what), ['design file design/missing.png is not on main: commit it there, or name another file']);

  const shape = admit(factory, spec('type: migration\nui: web'), facts(PROFILE));
  assert.match(shape.problems.map((p) => p.what).join('\n'), /ui must be a mapping[\s\S]*type migration does not run yet/);

  const bug = admit(factory, spec('type: bug', '1. It is fixed.'), facts(PROFILE));
  assert.match(bug.problems.map((p) => p.what).join('\n'), /a bug spec needs a `\$ command`/);

  const noBase = admit(factory, spec('type: feature'), facts('base: trunk\n'));
  assert.deepEqual(noBase.problems, [{ who: 'profile', what: 'the profile\'s base branch trunk does not exist', add: 'base: <a branch that exists>', from: 'main on GitHub' }]);

  const noTarget = admit(factory, spec('type: ui'), facts('base: main\n'));
  assert.match(noTarget.problems[0]!.add ?? '', /^ui:\n {2}targets:/);
});

// Protects: every refusal is listed and a refused animus plan exits 1. Fails when: the CLI prints only the first problem or exits 0.
test('animus plan lists every problem of a refused spec and exits 1', () => {
  const r = plan(PROFILE, 'sise: small\ntype: ui\nui: { pages: [nowhere] }');
  assert.equal(r.status, 1);
  assert.match(r.stdout, /1\. \[spec\] sise is not a key[\s\S]*2\. \[profile\] nowhere is not a page[\s\S]*add to \.animus\/animus\.yaml \(read from the checkout, on main\):/);
});

// Protects: a header typo cannot go unnoticed in the spec being admitted, yet earlier specs stay readable. Fails when: the lenient read refuses an unknown key, or the strict one accepts it.
test('only a spec being admitted is held to its header keys', () => {
  const text = spec('colour: red');
  assert.equal(admit(factory, text, facts(PROFILE)).problems.length, 1);
  assert.equal(parseSpec(text).criteria[0]!.text, 'It works.');
});

// Protects: a spec whose checks are all gates, or all one command, still runs, with a warning. Fails when: it is refused, or no warning shows.
test('a spec whose every command is a gate, or all one command, is admitted with a warning', () => {
  const gate = admit(factory, spec('type: feature', '1. A.\n   $ npm test\n2. B.\n   $ npm  test'), facts(PROFILE));
  assert.deepEqual(gate.problems, []);
  assert.match(gate.warnings.join(), /one of the profile's gates/);
  const same = admit(factory, spec('type: feature', '1. A.\n   $ node a.js\n2. B.\n   $ node a.js'), facts(PROFILE));
  assert.deepEqual(same.problems, []);
  assert.match(same.warnings.join(), /same command/);
  assert.deepEqual(admit(factory, spec('type: feature'), facts(PROFILE)).warnings, []);

  const warned = plan(PROFILE, 'type: feature', '1. A.\n   $ npm test\n');
  assert.equal(warned.status, 0, warned.stdout + warned.stderr);
  assert.match(warned.stdout, /warnings\n {2}- every criterion's command is one of the profile's gates/);
});

// Protects: criterion 7, a spec no command can check is refused. Fails when: a spec with no `$ command` at all is admitted.
test('a spec where no criterion has a command is refused', () => {
  const a = admit(factory, spec('type: feature', '1. It works.'), facts(PROFILE));
  assert.match(a.problems.map((p) => p.what).join(), /no acceptance criterion has a `\$ command`/);
});

// Protects: a literal page is shot like a named one. Fails when: the path is not opened on the target, or its shot is not named from the path.
test('a literal page path is screenshotted on the target, named from the path', async () => {
  const repo = makeRepo();
  const bin = mkdtempSync(join(tmpdir(), 'animus-browser-'));
  const log = join(bin, 'log.txt');
  writeFileSync(join(bin, 'browser.sh'), `#!/bin/sh\necho "$*" >> ${log}\ncase "$3" in screenshot) printf png > "$4";; eval) echo 100;; esac\n`);
  chmodSync(join(bin, 'browser.sh'), 0o755);
  process.env.ANIMUS_BROWSER = join(bin, 'browser.sh');
  try {
    const shots = await takeShots(repo, { id: 'j', pages: ['/masjid/subscribe', 'pricing'], designs: [] }, parseProfile(PROFILE), join(bin, 'shots'));
    assert.deepEqual(shots.shots.build, ['build/masjid-subscribe@1280x800.png', 'build/pricing@1280x800.png']);
    const opened = readFileSync(log, 'utf8').split('\n').filter((l) => / open /.test(l)).map((l) => new URL(l.split(' ').at(-1)!).pathname);
    assert.deepEqual(opened, ['/masjid/subscribe', '/pricing']);
  } finally {
    delete process.env.ANIMUS_BROWSER;
  }
});

// Protects: criterion 3's guard and ADR 0007's rule that a job never fails at start for a reason admit did not name. Fails when: a refused spec starts a worktree, or the job's error omits a problem.
test('a job whose spec is refused ends with the whole list, before any worktree, branch or agent', async () => {
  const repo = makeRepo();
  write(repo, '.animus/animus.yaml', PROFILE);
  const file = writeSpec('sise: small\ntype: ui\nbase: nope\nui: { pages: [//elsewhere.test/x] }');
  const { agent, calls } = fakeAgent([]);
  await assert.rejects(runJob({ repo, specFile: file }, deps(agent)), (err: Error) => {
    assert.match(err.message, /is refused/);
    assert.match(err.message, /sise is not a key[\s\S]*base nope[\s\S]*must be a path on the target/);
    return true;
  });
  assert.equal(calls.length, 0);
  assert.equal(git(repo, ['branch', '--list', 'animus/*']), '');
  assert.equal(git(repo, ['worktree', 'list']).split('\n').length, 1);
  assert.ok(existsSync(repo));
});
