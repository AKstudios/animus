import { chmodSync, existsSync, mkdirSync, mkdtempSync, readFileSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { delimiter, dirname, join } from 'node:path';
import { setTimeout as sleep } from 'node:timers/promises';
import type { Agent, AgentRequest, AgentResult } from '../src/agent.ts';
import { loadFactory } from '../src/profiles.ts';
import type { Deps } from '../src/pipeline.ts';
import { git } from '../src/proc.ts';

Object.assign(process.env, {
  GIT_AUTHOR_NAME: 'Test', GIT_AUTHOR_EMAIL: 'test@example.com',
  GIT_COMMITTER_NAME: 'Test', GIT_COMMITTER_EMAIL: 'test@example.com',
  GIT_CONFIG_NOSYSTEM: '1', GIT_CONFIG_GLOBAL: '/dev/null',
  ANIMUS_HOME: mkdtempSync(join(tmpdir(), 'animus-home-')),
  // Never the person's own Claude Code folder: cleanup removes transcripts from it.
  CLAUDE_CONFIG_DIR: mkdtempSync(join(tmpdir(), 'animus-claude-')),
});

export function write(dir: string, file: string, text: string): void {
  mkdirSync(dirname(join(dir, file)), { recursive: true });
  writeFileSync(join(dir, file), text);
}

/** A project whose test command passes once src/feature.txt says "done". */
export function makeRepo(): string {
  const repo = join(mkdtempSync(join(tmpdir(), 'animus-repo-')), 'project');
  mkdirSync(repo);
  git(repo, ['init', '-q', '-b', 'main']);
  write(repo, '.animus/animus.yaml', 'commands:\n  test: grep -q done src/feature.txt\n');
  write(repo, 'src/app.txt', 'app\n');
  git(repo, ['add', '-A']);
  git(repo, ['commit', '-qm', 'base']);
  return repo;
}

export function writeSpec(header: string, criteria = '1. The feature says done.\n   $ grep -q done src/feature.txt\n'): string {
  const dir = mkdtempSync(join(tmpdir(), 'animus-spec-'));
  write(dir, 'spec.md', `---\n${header}\n---\n# Say done\n\nThe feature file should say done.\n\n## Acceptance criteria\n\n${criteria}`);
  return join(dir, 'spec.md');
}

const result = (over: Partial<AgentResult>): AgentResult => ({
  ok: true, status: 'success', text: '', provider: 'fake', model: 'fake', cost_usd: 0.01, turns: 3,
  tokens: { input: 10, output: 20, cache_read: 0, cache_write: 0 }, ms: 5, session: 'session-1', ...over,
});

/** What a fake agent does on one call: change files in the worktree, then answer. */
export type Step = (req: AgentRequest) => Partial<AgentResult> | void;

/** An agent that plays a script, one step per call, and records each request. */
export function fakeAgent(steps: Step[]): { agent: Agent; calls: AgentRequest[] } {
  const calls: AgentRequest[] = [];
  const agent: Agent = (req) => {
    calls.push(req);
    const step = steps.shift();
    if (!step) throw new Error(`the fake agent was called more often than scripted (${req.role})`);
    return result(step(req) ?? {});
  };
  return { agent, calls };
}

export const done = (summary = 'The feature says done.') => ({ output: { status: 'done', summary } });
export const clean = (criteria = 1) => ({ output: { status: 'reviewed', summary: 'Read the diff and its test.', criteria: Array.from({ length: criteria }, (_, i) => ({ criterion: i + 1, met: true, proof: 'src/feature.txt' })), findings: [] } });

export function deps(agent: Agent, over: Partial<Deps> = {}): Deps & { published: { branch: string; draft: boolean; body: string }[]; lines: string[] } {
  const published: { branch: string; draft: boolean; body: string }[] = [];
  const lines: string[] = [];
  return {
    factory: loadFactory(), agent, lines, published,
    log: (line) => lines.push(line),
    publish: (p) => { published.push({ branch: p.branch, draft: p.draft, body: p.body }); return `https://example.test/pr/${published.length}`; },
    ...over,
  };
}

/** The system's opener, faked: `open` and `xdg-open` on PATH that write down the address they were given. */
export function fakeOpener(): { path: string; opened: () => Promise<string | undefined> } {
  const bin = mkdtempSync(join(tmpdir(), 'animus-opener-'));
  const out = join(bin, 'opened.txt');
  for (const name of ['open', 'xdg-open']) {
    writeFileSync(join(bin, name), `#!/bin/sh\nprintf '%s' "$1" > "${out}"\n`);
    chmodSync(join(bin, name), 0o755);
  }
  return {
    path: `${bin}${delimiter}${process.env.PATH}`,
    // The opener runs detached, so it may write after animus has exited.
    opened: async () => {
      for (let i = 0; i < 20 && !existsSync(out); i++) await sleep(50);
      return existsSync(out) ? readFileSync(out, 'utf8') : undefined;
    },
  };
}

/** The animus command's entry point, for spawning. */
export const cli = join(import.meta.dirname, '..', 'src', 'cli.ts');
