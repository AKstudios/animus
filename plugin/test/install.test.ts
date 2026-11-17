import assert from 'node:assert/strict';
import { spawnSync } from 'node:child_process';
import { chmodSync, existsSync, mkdtempSync, readFileSync, realpathSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { dirname, join } from 'node:path';
import { test } from 'node:test';
import { fileURLToPath } from 'node:url';
import { write } from './helpers.ts';

const INSTALL_SH = join(dirname(fileURLToPath(import.meta.url)), '..', '..', 'install.sh');

/** A machine with git, Node and Claude Code installed and the marketplace added, where setup and animus record what they were run with. */
function fakeMachine(setupExit: number) {
  const root = realpathSync(mkdtempSync(join(tmpdir(), 'install-')));
  const home = join(root, 'home');
  const market = join(root, 'market');
  const log = join(root, 'log');
  const script = (dir: string, name: string, body: string) => { write(dir, name, `#!/bin/sh\n${body}\n`); chmodSync(join(dir, name), 0o755); };
  script(join(root, 'bin'), 'git', 'echo git version 2.50.0');
  script(join(root, 'bin'), 'claude', `case "$*" in
  "plugin marketplace list --json") echo '[{"name":"akstudios","repo":"AKstudios/animus","installLocation":"${market}"}]' ;;
  *) echo 2.1.326 ;;
esac`);
  write(market, 'plugin/src/setup.ts', `import { appendFileSync } from 'node:fs';\nappendFileSync(${JSON.stringify(log)}, 'setup\\n');\nprocess.exitCode = ${setupExit};\n`);
  script(join(home, '.local', 'bin'), 'animus', `echo "animus $*" >> "${log}"`);
  const env = { HOME: home, PATH: [join(root, 'bin'), dirname(process.execPath), '/usr/bin', '/bin'].join(':'), ANIMUS_TTY: '/dev/null' };
  const run = (args: string[]) => spawnSync('bash', [INSTALL_SH, ...args], { env, encoding: 'utf8' });
  return { run, ran: () => existsSync(log) ? readFileSync(log, 'utf8').trim().split('\n') : [] };
}

// Protects: the one line a Slack invite gives installs and then joins. Fails when: join is dropped, runs before setup, runs after a failed setup, or bad arguments start an install.
for (const c of [
  { name: 'join <url> <code> runs setup, then animus join with them', args: ['join', 'http://helix.tail:7300', 'k3y'], setupExit: 0, ok: true, ran: ['setup', 'animus join http://helix.tail:7300 k3y'] },
  { name: 'no arguments run setup alone', args: [], setupExit: 0, ok: true, ran: ['setup'] },
  { name: 'a setup that fails is not followed by join', args: ['join', 'http://helix.tail:7300', 'k3y'], setupExit: 1, ok: false, ran: ['setup'] },
  { name: 'join without a code is refused before anything is installed', args: ['join', 'http://helix.tail:7300'], setupExit: 0, ok: false, ran: [] },
]) {
  test(`install.sh: ${c.name}`, { skip: process.platform === 'win32' && 'install.sh is for macOS and Linux' }, () => {
    const m = fakeMachine(c.setupExit);
    const r = m.run(c.args);
    assert.equal(r.status === 0, c.ok, `${r.stdout}${r.stderr}`);
    assert.deepEqual(m.ran(), c.ran);
  });
}
