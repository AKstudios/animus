import assert from 'node:assert/strict';
import { spawnSync } from 'node:child_process';
import { existsSync, mkdirSync, mkdtempSync, readFileSync, realpathSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { test } from 'node:test';
import { oldAnimusMarketplace } from '../src/doctor.ts';
import { autoUpdate, autoUpdating, findRepos, parsePicks, pathLine, PLUGIN, setup, type Io, type Machine, type Run } from '../src/setup.ts';
import { write } from './helpers.ts';

const realGit = (args: string[], cwd: string) => {
  const r = spawnSync('git', args, { cwd, encoding: 'utf8', env: { ...process.env, GIT_CONFIG_GLOBAL: '/dev/null', HOME: cwd, XDG_CONFIG_HOME: join(cwd, '.none') } });
  return { ok: r.status === 0, out: `${r.stdout}${r.stderr}`.trim() };
};
const temp = (prefix: string) => realpathSync(mkdtempSync(join(tmpdir(), prefix)));

test('picks are numbers and ranges from the list, all, or nothing; anything else is said back', () => {
  assert.deepEqual(parsePicks('3 1 2-3', 5), [0, 1, 2]);
  assert.deepEqual(parsePicks('1,4', 5), [0, 3]);
  assert.deepEqual(parsePicks('all', 3), [0, 1, 2]);
  assert.deepEqual(parsePicks('  ', 3), []);
  assert.match(parsePicks('6', 5) as string, /between 1 and 5/);
  assert.match(parsePicks('4-2', 5) as string, /between/);
  assert.match(parsePicks('two', 5) as string, /not a number/);
});

test('checkouts are found in the usual folders, not inside one another or node_modules', () => {
  const home = temp('home-');
  for (const dir of ['Dev/a', 'Dev/group/b', 'Dev/a/nested', 'code/c', 'Dev/node_modules/d', 'Dev/.hidden/e', 'Elsewhere/f']) mkdirSync(join(home, dir, '.git'), { recursive: true });
  const extra = join(home, 'Elsewhere', 'f');
  assert.deepEqual(findRepos(home, [extra]).map((p) => p.slice(home.length + 1)).sort(), ['Dev/a', 'Dev/group/b', 'Elsewhere/f', 'code/c']);
});

test('auto-update is set on the marketplace in the user\'s settings, keeping everything else there', () => {
  const dir = temp('claude-');
  write(dir, 'settings.json', JSON.stringify({ model: 'opus', extraKnownMarketplaces: { other: { source: { source: 'github', repo: 'x/y' } } } }));
  assert.equal(autoUpdating(dir), false);
  autoUpdate(dir);
  const settings = JSON.parse(readFileSync(join(dir, 'settings.json'), 'utf8'));
  assert.equal(settings.model, 'opus');
  assert.deepEqual(settings.extraKnownMarketplaces.other, { source: { source: 'github', repo: 'x/y' } });
  assert.deepEqual(settings.extraKnownMarketplaces.akstudios, { source: { source: 'github', repo: 'AKstudios/animus', ref: 'stable' }, autoUpdate: true });
  assert.equal(autoUpdating(dir), true);
  autoUpdate(temp('fresh-'));
});

test('the line that puts ~/.local/bin on PATH goes in the shell\'s own rc file', () => {
  const m = (platform: NodeJS.Platform, shell?: string): Machine => ({ home: '/h', claudeDir: '/h/.claude', platform, path: '', shell });
  assert.equal(pathLine(m('darwin', '/bin/zsh'))!.file, join('/h', '.zshrc'));
  assert.equal(pathLine(m('darwin', '/bin/bash'))!.file, join('/h', '.bash_profile'));
  assert.equal(pathLine(m('linux', '/usr/bin/bash'))!.file, join('/h', '.bashrc'));
  assert.match(pathLine(m('linux', '/usr/bin/fish'))!.line, /fish_add_path/);
  assert.equal(pathLine(m('win32')), undefined);
});

test('doctor sees Animus\'s marketplace under its old name, and not someone else\'s', () => {
  const dir = temp('claude-');
  write(dir, 'plugins/known_marketplaces.json', JSON.stringify({ animus: { source: { source: 'github', repo: 'AKstudios/animus', ref: 'stable' } } }));
  assert.equal(oldAnimusMarketplace(dir), true);
  write(dir, 'plugins/known_marketplaces.json', JSON.stringify({ animus: { source: { source: 'github', repo: 'ajmalali/orbit' } } }));
  assert.equal(oldAnimusMarketplace(dir), false);
});

/** A machine with everything installed and signed in, where Claude Code's plugin commands are recorded. */
function fakeMachine(answers: string[], opts: { old?: boolean; path?: string } = {}) {
  const home = temp('home-');
  const claudeDir = join(home, '.claude');
  const repos = ['Dev/shop', 'Dev/blog', 'code/api'].map((r) => join(home, r));
  for (const r of repos) { mkdirSync(r, { recursive: true }); spawnSync('git', ['init', '-q'], { cwd: r }); }
  if (opts.old) write(claudeDir, 'plugins/installed_plugins.json', JSON.stringify({ plugins: { 'animus@animus': [{ scope: 'user', installPath: '/x', version: '0.3.5' }] } }));
  const calls: string[] = [];
  const known = new Map<string, string>([[opts.old ? 'animus' : 'akstudios', 'AKstudios/animus']]);
  const run: Run = (command, args, o = {}) => {
    const line = `${command} ${args.join(' ')}`;
    if (command === 'claude' || line === 'gh auth setup-git') calls.push(o.cwd ? `${line} (in ${o.cwd.slice(home.length + 1)})` : line);
    if (line === 'claude --version') return { ok: true, out: '2.1.326 (Claude Code)' };
    if (line === 'claude auth status --json') return { ok: true, out: '{"loggedIn":true}' };
    // Claude Code knows a marketplace by its source: adding one it has under another name adds nothing.
    if (line === 'claude plugin marketplace list --json') return { ok: true, out: JSON.stringify([...known].map(([name, repo]) => ({ name, repo }))) };
    if (line.startsWith('claude plugin marketplace remove ')) { known.delete(args[3]!); return { ok: true, out: '' }; }
    if (line === 'claude plugin marketplace add AKstudios/animus#stable') {
      if (![...known.values()].includes('AKstudios/animus')) known.set('akstudios', 'AKstudios/animus');
      return { ok: true, out: '' };
    }
    if (line === 'git rev-parse --show-toplevel') return o.cwd && existsSync(join(o.cwd, '.git')) ? { ok: true, out: o.cwd } : { ok: false, out: 'not a git repository' };
    if (command === 'git') return realGit(args, o.cwd!);
    return { ok: true, out: '' };
  };
  const said: string[] = [];
  const asked: string[] = [];
  const io: Io = { ask: async (q) => { asked.push(q); return answers.shift() ?? ''; }, say: (l) => said.push(l), run };
  const machine: Machine = { home, claudeDir, platform: 'darwin', path: opts.path ?? '/usr/bin', shell: '/bin/zsh' };
  return { home, claudeDir, calls, said, asked, io, machine };
}

test('setup removes the old marketplace, turns on updates, turns Animus on in the picked checkouts only, and puts animus on PATH', async () => {
  // Remove the old one: yes. Updates: yes. Pick. The second and third (sorted: Dev/blog, Dev/shop, code/api). PATH: yes.
  const f = fakeMachine(['', '', 'pick', '2 3', 'y'], { old: true });
  assert.equal(await setup(f.io, f.machine, f.home), true);
  assert.deepEqual(f.calls.filter((c) => !/--version|auth status|marketplace list/.test(c)), [
    'gh auth setup-git',
    'claude plugin uninstall animus@animus --scope user',
    'claude plugin marketplace remove animus',
    'claude plugin marketplace add AKstudios/animus#stable',
    `claude plugin install ${PLUGIN} --scope local (in Dev/shop)`,
    `claude plugin install ${PLUGIN} --scope local (in code/api)`,
  ]);
  assert.equal(autoUpdating(f.claudeDir), true);
  assert.match(readFileSync(join(f.home, '.local', 'bin', 'animus'), 'utf8'), /animus\.cjs/);
  assert.match(readFileSync(join(f.home, '.zshrc'), 'utf8'), /export PATH="\$HOME\/\.local\/bin:\$PATH"/);
  assert.ok(f.said.some((l) => /animus enable/.test(l)));
});

test('setup turned on everywhere installs for the user, and asks nothing about PATH when ~/.local/bin is on it', async () => {
  const f = fakeMachine(['n', 'every']);
  f.machine.path = ['/usr/bin', join(f.home, '.local', 'bin')].join(':');
  assert.equal(await setup(f.io, f.machine, f.home), true);
  assert.ok(f.calls.includes(`claude plugin install ${PLUGIN} --scope user`));
  assert.ok(!f.calls.some((c) => c.includes('--scope local')));
  assert.equal(autoUpdating(f.claudeDir), false);
  assert.ok(f.said.some((l) => l.includes(`claude plugin update ${PLUGIN}`)));
  assert.equal(f.asked.length, 2);
  assert.equal(existsSync(join(f.home, '.zshrc')), false);
});

test('setup takes a path typed in, and says back a pick it cannot read', async () => {
  const f = fakeMachine(['', 'pick', '9', '~/code/api', '', 'n']);
  assert.equal(await setup(f.io, f.machine, f.home), true);
  assert.ok(f.said.includes('9 is not between 1 and 3'));
  assert.deepEqual(f.calls.filter((c) => c.includes('--scope local')), [`claude plugin install ${PLUGIN} --scope local (in code/api)`]);
  // Kept out of git in the checkout's own exclude file, once.
  const exclude = readFileSync(join(f.home, 'code/api/.git/info/exclude'), 'utf8');
  assert.equal(exclude.split('\n').filter((l) => l === '.claude/settings.local.json').length, 1);
});

test('the animus command runs the newest installed copy of the plugin', () => {
  const f = fakeMachine(['', 'pick', '', 'n']);
  return setup(f.io, f.machine, f.home).then(() => {
    const copy = (version: string) => {
      const root = join(f.claudeDir, 'plugins', 'cache', 'akstudios', 'animus', version);
      write(root, 'src/cli.ts', `console.log(JSON.stringify({ version: '${version}', args: process.argv.slice(2), bin: process.env.ANIMUS_BIN }));\n`);
      return { scope: 'user', installPath: root, version };
    };
    write(f.claudeDir, 'plugins/installed_plugins.json', JSON.stringify({ plugins: { [PLUGIN]: [copy('0.3.10'), copy('0.4.0'), copy('0.3.9')] } }));
    const r = spawnSync(join(f.home, '.local', 'bin', 'animus'), ['doctor', '--json'], { encoding: 'utf8', env: { ...process.env, CLAUDE_CONFIG_DIR: f.claudeDir } });
    assert.equal(r.status, 0, r.stderr);
    const out = JSON.parse(r.stdout);
    assert.equal(out.version, '0.4.0');
    assert.deepEqual(out.args, ['doctor', '--json']);
    assert.match(out.bin, /0\.4\.0[/\\]bin[/\\]animus$/);
  });
});

test('setup stops, changing nothing, when the person keeps the marketplace under its old name', async () => {
  const f = fakeMachine(['n'], { old: true });
  assert.equal(await setup(f.io, f.machine, f.home), false);
  assert.ok(!f.calls.some((c) => /uninstall|remove|add|install/.test(c)));
  assert.ok(f.said.some((l) => l.includes('setup stops here')));
  assert.equal(autoUpdating(f.claudeDir), false);
});
