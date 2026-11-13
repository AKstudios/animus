import assert from 'node:assert/strict';
import { test } from 'node:test';
import { loadFactory } from '../src/profiles.ts';
import { runJob } from '../src/pipeline.ts';
import { grantsFor, projectSkills, roleSkills } from '../src/skills.ts';
import { git } from '../src/proc.ts';
import { clean, deps, done, fakeAgent, makeRepo, write, writeSpec } from './helpers.ts';

const factory = loadFactory();
const names = (role: string, type: string) => grantsFor(factory, role, type).map((g) => g.name);

test('each role gets only the skills it is granted, and impeccable only on ui jobs', () => {
  assert.deepEqual(names('implementer', 'feature'), ['ponytail', 'useful-tests']);
  assert.deepEqual(names('implementer', 'ui'), ['ponytail', 'useful-tests', 'impeccable']);
  assert.deepEqual(names('reviewer', 'feature'), []);
  assert.deepEqual(names('reviewer', 'ui'), []);
  assert.deepEqual(names('ui-reviewer', 'ui'), ['impeccable']);
});

test('a granted skill arrives as text with Animus\'s note first, and its folder to read from', () => {
  const s = roleSkills(factory, 'implementer', 'ui');
  assert.deepEqual(s.names, ['ponytail', 'useful-tests', 'impeccable']);
  assert.match(s.system, /# Skill: ponytail\n\nHow this skill applies inside Animus:[\s\S]*You are a lazy senior developer/);
  assert.match(s.system, /The launcher is not installed/);
  assert.doesNotMatch(s.system, /^name: ponytail/m);
  assert.equal(s.dirs.length, 3);
  // The ui reviewer gets the quality floor, not the designer's whole skill.
  const r = roleSkills(factory, 'ui-reviewer', 'ui');
  assert.match(r.system, /# Craft floor/);
  assert.doesNotMatch(r.system, /award-winning design director/);
  assert.equal(roleSkills(factory, 'reviewer', 'feature').system, '');
});

test('the repository\'s own skills are listed for every role, by file', () => {
  const repo = makeRepo();
  write(repo, '.claude/skills/run-app/SKILL.md', '---\nname: run-app\ndescription: How to start the app and check it.\n---\nRun make dev.\n');
  assert.deepEqual(projectSkills(repo), [{ name: 'run-app', description: 'How to start the app and check it.', file: '.claude/skills/run-app/SKILL.md' }]);
  const s = roleSkills(factory, 'reviewer', 'feature', repo);
  assert.deepEqual(s.names, ['repo:run-app']);
  assert.match(s.system, /\.claude\/skills\/run-app\/SKILL\.md: How to start the app and check it\./);
});

test('a job gives the implementer its skills, the reviewer none, and logs which were used', async () => {
  const repo = makeRepo();
  const { agent, calls } = fakeAgent([
    (req) => { write(req.cwd, 'src/feature.txt', 'done\n'); git(req.cwd, ['add', '-A']); git(req.cwd, ['commit', '-qm', 'done']); return done(); },
    () => clean(),
  ]);
  const run = await runJob({ repo, specFile: writeSpec('size: small\ndifficulty: routine\ntype: feature') }, deps(agent));
  assert.match(calls[0]!.system!, /# Skill: ponytail/);
  assert.equal(calls[0]!.addDirs?.length, 2);
  assert.doesNotMatch(calls[1]!.system!, /# Skill:/);
  assert.equal(calls[1]!.addDirs, undefined);
  assert.deepEqual(run.skills, ['ponytail', 'useful-tests']);
});
