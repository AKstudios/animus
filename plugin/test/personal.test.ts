import assert from 'node:assert/strict';
import { existsSync, mkdtempSync, readFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { test } from 'node:test';
import { jobDir } from '../src/log.ts';
import { parseSkills, personalFor, repoKey, snapshotSkills, whereToRun } from '../src/personal.ts';
import { runJob } from '../src/pipeline.ts';
import { git } from '../src/proc.ts';
import { loadFactory } from '../src/profiles.ts';
import { roleSkills } from '../src/skills.ts';
import { clean, deps, done, fakeAgent, makeRepo, write, writeSpec } from './helpers.ts';

const factory = loadFactory();

/** A config folder with two skill files beside it. */
function config(yaml: string): string {
  const dir = mkdtempSync(join(tmpdir(), 'animus-config-'));
  write(dir, 'skills/habits/SKILL.md', '---\nname: habits\n---\nKeep functions short.\n');
  write(dir, 'skills/sql/SKILL.md', 'Name tables in the singular.\n');
  write(dir, 'config.yaml', yaml);
  return join(dir, 'config.yaml');
}

const withOrigin = (url: string) => {
  const repo = makeRepo();
  git(repo, ['remote', 'add', 'origin', url]);
  return repo;
};

test('a repository is named in the config by owner/repo or any form of its GitHub address', () => {
  for (const k of ['AKstudios/meal-planner', 'github.com/AKstudios/meal-planner', 'https://github.com/AKstudios/meal-planner.git', 'git@github.com:AKstudios/meal-planner.git']) {
    assert.equal(repoKey(k), 'https://github.com/akstudios/meal-planner.git', k);
  }
  assert.equal(repoKey('~/code/thing'), undefined);
});

test('no config is no settings; the repository\'s entry overrides the top, and adds to its skills', () => {
  const repo = withOrigin('git@github.com:AKstudios/meal-planner.git');
  assert.deepEqual(personalFor(repo, join(tmpdir(), 'no-such-config.yaml')), { skills: [] });
  const file = config([
    'run: helix',
    'skills:',
    '  habits: skills/habits/SKILL.md',
    'repos:',
    '  akstudios/meal-planner:',
    '    run: local',
    '    skills:',
    '      sql: { file: skills/sql/SKILL.md, roles: [implementer, reviewer], types: [backend] }',
    '  someone/else:',
    '    run: helix',
  ].join('\n'));
  const p = personalFor(repo, file);
  assert.equal(p.run?.where, 'local');
  assert.match(p.run!.from, /^repos\.akstudios\/meal-planner\.run in /);
  assert.deepEqual(p.skills.map((s) => [s.name, s.roles, s.types]), [['habits', ['implementer', 'planner'], undefined], ['sql', ['implementer', 'reviewer'], ['backend']]]);
  assert.ok(p.skills[0]!.file.endsWith(join('skills', 'habits', 'SKILL.md')));
  // Another repository gets the top's settings only.
  const other = personalFor(withOrigin('https://github.com/x/y.git'), file);
  assert.equal(other.run?.where, 'helix');
  assert.deepEqual(other.skills.map((s) => s.name), ['habits']);
});

test('a repository off GitHub is named by its folder', () => {
  const repo = makeRepo();
  const p = personalFor(repo, config(`repos:\n  ${JSON.stringify(repo)}:\n    run: helix\n`));
  assert.equal(p.run?.where, 'helix');
});

test('the config takes only its own settings, and says what is wrong', () => {
  const repo = makeRepo();
  assert.throws(() => personalFor(repo, config('commands:\n  test: npm test\n')), /commands is not a setting here; .*\.animus\/animus\.yaml/);
  assert.throws(() => personalFor(repo, config('run: cloud\n')), /run must be local or helix/);
  assert.throws(() => personalFor(repo, config('skills:\n  x: { file: a.md, roles: [boss] }\n')), /skills\.x\.roles names boss/);
  assert.throws(() => snapshotSkills(personalFor(repo, config('skills:\n  gone: nowhere/SKILL.md\n')).skills), /your skill gone is .*nowhere.*, which does not exist/);
});

test('a personal skill reaches only the roles and types it names, as text, logged with a hash', () => {
  const repo = makeRepo();
  const skills = snapshotSkills(personalFor(repo, config('skills:\n  habits: skills/habits/SKILL.md\n  sql: { file: skills/sql/SKILL.md, roles: [reviewer], types: [backend] }\n')).skills);
  const impl = roleSkills(factory, 'implementer', 'feature', undefined, skills);
  assert.match(impl.system, /# The submitter's skill: habits\n\n[\s\S]*Keep functions short\./);
  assert.doesNotMatch(impl.system, /^name: habits/m);
  assert.match(impl.names.at(-1)!, /^personal:habits@[0-9a-f]{8}$/);
  assert.doesNotMatch(roleSkills(factory, 'reviewer', 'feature', undefined, skills).system, /submitter's skill/);
  assert.match(roleSkills(factory, 'reviewer', 'backend', undefined, skills).system, /singular/);
});

test('a job keeps a copy of the submitter\'s skills, gives them to the implementer, not the reviewer, and logs them', async () => {
  const repo = makeRepo();
  const skills = parseSkills([{ name: 'habits', roles: ['implementer'], text: 'Keep functions short.\n' }], 'test');
  const { agent, calls } = fakeAgent([
    (req) => { write(req.cwd, 'src/feature.txt', 'done\n'); git(req.cwd, ['add', '-A']); git(req.cwd, ['commit', '-qm', 'done']); return done(); },
    () => clean(),
  ]);
  const run = await runJob({ repo, specFile: writeSpec('size: small\ndifficulty: routine\ntype: feature'), personal: skills }, deps(agent));
  assert.match(calls[0]!.system!, /Keep functions short/);
  assert.doesNotMatch(calls[1]!.system!, /Keep functions short/);
  assert.ok(run.skills.some((s) => /^personal:habits@/.test(s)));
  const copy = join(jobDir(run.job), 'skills.json');
  assert.ok(existsSync(copy));
  assert.equal(JSON.parse(readFileSync(copy, 'utf8'))[0].text, 'Keep functions short.\n');
});

test('skills that arrive from elsewhere are checked and hashed again', () => {
  assert.equal(parseSkills([{ name: 'a', roles: ['planner'], text: 'x', sha: 'forged' }], 'here')[0]!.sha.length, 64);
  assert.throws(() => parseSkills([{ name: '../a', roles: ['planner'], text: 'x' }], 'here'), /a name of letters/);
  assert.throws(() => parseSkills([{ name: 'a', roles: ['planner'], text: 'x' }, { name: 'a', roles: ['planner'], text: 'y' }], 'here'), /a is there twice/);
});

test('where a job runs: what was asked, then the config, then Helix only when it has the repository', async () => {
  const repo = withOrigin('https://github.com/o/app.git');
  const login = { url: 'http://helix.test', token: 't', from: 'test' };
  const has = (state: 'ready' | 'checking') => async () => ({ projects: [{ name: 'app', url: 'https://github.com/o/app.git', state, added: '' }] });
  assert.equal((await whereToRun({ asked: 'local', config: { where: 'helix', from: 'run in c' }, checkout: repo, login })).where, 'local');
  assert.deepEqual(await whereToRun({ config: { where: 'helix', from: 'run in c' }, checkout: repo, login: undefined }), { where: 'helix', why: 'run in c says so' });
  assert.match((await whereToRun({ checkout: repo, login: undefined })).why, /has not joined a Helix/);
  assert.deepEqual(await whereToRun({ checkout: repo, login, projects: has('ready') }), { where: 'helix', why: 'Helix has this repository as app', project: 'app' });
  assert.equal((await whereToRun({ checkout: repo, login, projects: has('checking') })).where, 'local');
  const down = await whereToRun({ checkout: repo, login, projects: () => Promise.reject(new Error('refused')) });
  assert.deepEqual([down.where, down.why], ['local', 'Helix did not answer (refused)']);
});
