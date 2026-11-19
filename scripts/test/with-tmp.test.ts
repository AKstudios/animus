import assert from 'node:assert/strict';
import { homedir } from 'node:os';
import { join, normalize } from 'node:path';
import test from 'node:test';

// Protects: tests never touch the person's own Animus home. Fails when: scripts/with-tmp.sh leaves ANIMUS_HOME
// unset or pointing outside its temporary folder, so a test that builds Helix without a home per person (as
// helix/test/slack-control.test.ts does) writes job folders into ~/.animus.
test('a test run gets an Animus home of its own inside its temporary folder', () => {
  const home = process.env.ANIMUS_HOME;
  assert.ok(home, 'ANIMUS_HOME is set for the run');
  assert.notEqual(home, join(homedir(), '.animus'));
  assert.equal(normalize(home), join(process.env.TMPDIR!, 'animus-home'));
});
