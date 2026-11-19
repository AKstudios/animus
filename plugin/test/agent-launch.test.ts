import assert from 'node:assert/strict';
import { chmodSync, mkdirSync, mkdtempSync, writeFileSync } from 'node:fs';
import { homedir, tmpdir } from 'node:os';
import { dirname, join } from 'node:path';
import { test } from 'node:test';
import { claudeAgent } from '../src/agent.ts';
import { loadFactory } from '../src/profiles.ts';

/** The real launcher against a `claude` that answers with the arguments it was started with. */
function launch(over: { resume?: string; readOnly?: boolean; filesOnly?: boolean; role?: string }) {
  const root = mkdtempSync(join(tmpdir(), 'animus-launch-'));
  const cwd = join(root, 'jobs', 'wt');
  mkdirSync(cwd, { recursive: true });
  const bin = join(root, 'claude');
  writeFileSync(bin, '#!/usr/bin/env node\nconsole.log(JSON.stringify({ result: JSON.stringify(process.argv.slice(2)) }));\n');
  chmodSync(bin, 0o755);
  const r = claudeAgent(loadFactory(), bin)({ role: 'implementer', tier: 'standard', effort: 'high', prompt: 'go', cwd, ...over });
  assert.ok(r.ok, r.status);
  const args = JSON.parse(r.text) as string[];
  const settings = JSON.parse(args[args.indexOf('--settings') + 1]!) as { claudeMdExcludes: string[] };
  return { cwd, root, excludes: settings.claudeMdExcludes };
}

const slash = (p: string) => p.replaceAll('\\', '/');

// Protects: criterion 3. Fails when: a job loads CLAUDE.md or rules from the home or a folder above the worktree, or leaves out the worktree's own.
for (const [name, over] of [['an implementer', {}], ['a reviewer', { readOnly: true }], ['a drafter', { filesOnly: true }], ['a resumed session', { resume: 'abc' }]] as const) {
  test(`${name} leaves out instruction files of the home and every folder above the worktree, and keeps the worktree's own`, () => {
    const { cwd, excludes } = launch(over);
    const left = [homedir(), dirname(cwd), dirname(dirname(cwd)), dirname(dirname(dirname(cwd)))].flatMap((d) => [`${slash(d)}/CLAUDE.md`, `${slash(d)}/.claude/CLAUDE.md`, `${slash(d)}/.claude/rules/**`]);
    for (const pattern of left) assert.ok(excludes.includes(pattern), `${pattern} is left out`);
    // Nothing that matches the worktree's own files, or a folder inside it.
    assert.ok(excludes.every((p) => !p.startsWith(`${slash(cwd)}/`) && !p.startsWith('**') && !p.startsWith('*')), excludes.join('\n'));
  });
}
