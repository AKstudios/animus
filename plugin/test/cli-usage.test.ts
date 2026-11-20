import { test } from 'node:test';
import assert from 'node:assert/strict';
import { spawnSync } from 'node:child_process';
import { mkdtempSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { cli } from './helpers.ts';

const animus = (...args: string[]) =>
  spawnSync(process.execPath, ['--disable-warning=ExperimentalWarning', cli, ...args], {
    encoding: 'utf8', timeout: 60_000, env: { ...process.env, ANIMUS_HOME: mkdtempSync(join(tmpdir(), 'animus-usage-')) },
  });

const START_USAGE = ['animus start <spec.md>', 'animus start <pr> "<what to change>"'];

for (const flag of ['--help', '-h']) {
  test(`help after a command: start ${flag} prints that command's usage and exits 0`, () => {
    const r = animus('start', flag);
    assert.equal(r.status, 0);
    for (const line of START_USAGE) assert.ok(r.stdout.includes(line), r.stdout);
    assert.ok(!r.stdout.includes('animus run <spec.md>'), 'only the start entries');
    assert.ok(!/ERR_PARSE_ARGS|\n\s+at /.test(r.stderr), r.stderr);
  });
}

test('help after a command: status --help prints the status usage', () => {
  const r = animus('status', '--help');
  assert.equal(r.status, 0);
  assert.ok(r.stdout.includes('animus status [<id>]'), r.stdout);
  assert.ok(!r.stdout.includes('animus start'), r.stdout);
});

test('an unknown option names itself, prints the command usage on stderr and exits 2', () => {
  for (const flag of ['--frob', '-x']) {
    const r = animus('start', 'spec.md', flag);
    assert.equal(r.status, 2);
    assert.ok(r.stderr.startsWith(`animus: unknown option ${flag}\n`), r.stderr);
    for (const line of START_USAGE) assert.ok(r.stderr.includes(line), r.stderr);
    assert.ok(!r.stderr.includes('animus run <spec.md>'), r.stderr);
    assert.ok(!/ERR_PARSE_ARGS|\n\s+at /.test(r.stderr), r.stderr);
  }
});

test('an unknown option on a command without usage lines of its own is followed by the full usage', () => {
  const r = animus('bogus', '--frob');
  assert.equal(r.status, 2);
  assert.ok(r.stderr.startsWith('animus: unknown option --frob\n'), r.stderr);
  assert.ok(r.stderr.includes('animus start <spec.md>') && r.stderr.includes('animus doctor'), r.stderr);
});

for (const args of [[], ['help'], ['--help'], ['-h']]) {
  test(`the full usage is printed by animus ${args.join(' ')}`.trimEnd(), () => {
    const r = animus(...args);
    assert.equal(r.status, 0);
    assert.ok(r.stdout.includes('animus start <spec.md>') && r.stdout.includes('animus doctor'), r.stdout);
  });
}
