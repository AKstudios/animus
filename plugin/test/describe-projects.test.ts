import assert from 'node:assert/strict';
import { test } from 'node:test';
import { describeProjects, type RemoteProject } from '../src/remote.ts';

// Protects: animus project list saying why a project failed. Fails when: only a reason's first line is shown, which for a failed setup is "setup did not pass, so every job would fail at it:" and nothing more.
test('project list shows the whole reason of a failed project under the table', () => {
  const reason = 'setup did not pass, so every job would fail at it:\nerror: Failed to build `systemd-python==235`\n  Package libsystemd was not found';
  const out = describeProjects([
    { name: 'app', state: 'ready', url: 'https://github.com/o/app.git', added_by: 'ana' },
    { name: 'api', state: 'failed', url: 'https://github.com/o/api.git', added_by: 'ana', reason },
  ] as RemoteProject[]);
  assert.match(out, /^app +ready/m);
  assert.match(out, /^api +failed .* setup did not pass/m);
  assert.match(out, /\n\napi failed:\n  setup did not pass, so every job would fail at it:\n  error: Failed to build `systemd-python==235`\n    Package libsystemd was not found$/);
});

test('project list adds nothing under the table when every reason fits in its row', () => {
  const out = describeProjects([{ name: 'api', state: 'failed', url: 'https://github.com/o/api.git', added_by: 'ana', reason: 'no .animus/animus.yaml on main' }] as RemoteProject[]);
  assert.equal(out.split('\n').length, 1);
});
