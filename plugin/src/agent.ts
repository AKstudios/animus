// The one function every agent step goes through (docs/factory.md, "Model
// tiers and providers"): tier, effort, prompt and working directory in;
// transcript and exit status out. Nothing else in Animus knows which CLI runs
// a model, so another provider is another function of this shape.
import { spawnSync } from 'node:child_process';
import { existsSync, realpathSync } from 'node:fs';
import { homedir } from 'node:os';
import { join } from 'node:path';
import { modelFor, type Factory, type Tier } from './profiles.ts';
import { AnimusError } from './proc.ts';

export type AgentRequest = {
  /** implementer, reviewer or ui-reviewer: for the log. */
  role: string;
  tier: Tier;
  effort: string;
  prompt: string;
  cwd: string;
  /** The role's standing instructions (prompts/<role>.md). */
  system?: string;
  /** A JSON Schema the final answer must fit; it comes back as `output`. */
  schema?: object;
  /** Continue this earlier session instead of starting one. */
  resume?: string;
  /** No file edits: the reviewer's sessions. */
  readOnly?: boolean;
  timeoutMs?: number;
};

export type Tokens = { input: number; output: number; cache_read: number; cache_write: number };

export type AgentResult = {
  ok: boolean;
  /** success, or how the session ended (error_max_turns, timeout, exit 1: ...). */
  status: string;
  text: string;
  output?: unknown;
  session?: string;
  provider: string;
  /** The model the provider says it ran. */
  model: string;
  cost_usd: number;
  turns: number;
  tokens: Tokens;
  ms: number;
  /** Where the provider keeps the session's transcript, when it says. */
  transcript?: string;
};

export type Agent = (req: AgentRequest) => AgentResult;

const DEFAULT_TIMEOUT_MS = 60 * 60 * 1000;

type ClaudeJson = {
  is_error?: boolean; subtype?: string; result?: string; structured_output?: unknown; session_id?: string;
  total_cost_usd?: number; num_turns?: number;
  usage?: { input_tokens?: number; output_tokens?: number; cache_read_input_tokens?: number; cache_creation_input_tokens?: number };
  modelUsage?: Record<string, { costUSD?: number }>;
};

/**
 * Claude Code, headless. Sessions load the project's own settings, rules and
 * skills only (--setting-sources project), so a job runs the same on a laptop
 * and in a container that has none of the person's own.
 */
export function claudeAgent(factory: Factory, command = process.env.ANIMUS_CLAUDE ?? 'claude'): Agent {
  return (req) => {
    const model = modelFor(factory, req.tier);
    const args = ['-p', req.prompt, '--model', model, '--effort', req.effort, '--output-format', 'json', '--permission-mode', 'dontAsk', '--setting-sources', 'project'];
    if (req.resume) args.push('--resume', req.resume);
    if (req.system) args.push('--append-system-prompt', req.system);
    if (req.schema) args.push('--json-schema', JSON.stringify(req.schema));
    const noGit = ['Bash(git push:*)', 'Bash(git checkout:*)', 'Bash(git switch:*)', 'Bash(git worktree:*)', 'Bash(gh:*)'];
    if (req.readOnly) args.push('--allowedTools', 'Bash', 'Read', 'Glob', 'Grep', '--disallowedTools', 'Edit', 'Write', 'NotebookEdit', 'Bash(git commit:*)', ...noGit);
    else args.push('--allowedTools', 'Bash', 'Read', 'Write', 'Edit', 'Glob', 'Grep', 'Skill', '--disallowedTools', ...noGit);

    const started = Date.now();
    const r = spawnSync(command, args, { cwd: req.cwd, encoding: 'utf8', timeout: req.timeoutMs ?? DEFAULT_TIMEOUT_MS, maxBuffer: 256 * 1024 * 1024 });
    const ms = Date.now() - started;
    if (r.error && (r.error as NodeJS.ErrnoException).code === 'ENOENT') throw new AnimusError(`${command} is not installed or not on PATH`);
    const base = { provider: 'claude', model, cost_usd: 0, turns: 0, tokens: { input: 0, output: 0, cache_read: 0, cache_write: 0 }, ms };
    let out: ClaudeJson;
    try {
      out = JSON.parse(r.stdout) as ClaudeJson;
    } catch {
      const why = r.error ? (r.signal ? 'timeout' : r.error.message) : `exit ${r.status}: ${(r.stderr || r.stdout || '').trim().slice(-400)}`;
      return { ...base, ok: false, status: why, text: '' };
    }
    // The session's main model is the one that cost the most; a small one may run beside it.
    const used = Object.entries(out.modelUsage ?? {}).sort((a, b) => (b[1].costUSD ?? 0) - (a[1].costUSD ?? 0))[0]?.[0];
    const result: AgentResult = {
      ...base,
      ok: !out.is_error && r.status === 0,
      status: out.is_error || r.status !== 0 ? out.subtype ?? `exit ${r.status}` : 'success',
      text: out.result ?? '',
      model: used ?? model,
      cost_usd: out.total_cost_usd ?? 0,
      turns: out.num_turns ?? 0,
      tokens: {
        input: out.usage?.input_tokens ?? 0, output: out.usage?.output_tokens ?? 0,
        cache_read: out.usage?.cache_read_input_tokens ?? 0, cache_write: out.usage?.cache_creation_input_tokens ?? 0,
      },
    };
    if (out.structured_output !== undefined) result.output = out.structured_output;
    if (out.session_id) {
      result.session = out.session_id;
      const file = claudeTranscript(req.cwd, out.session_id);
      if (file) result.transcript = file;
    }
    return result;
  };
}

/** Claude Code's transcript of a session started in cwd, if it is still on disk. */
function claudeTranscript(cwd: string, session: string): string | undefined {
  const root = process.env.CLAUDE_CONFIG_DIR ?? join(homedir(), '.claude');
  let real = cwd;
  try { real = realpathSync(cwd); } catch { /* removed already */ }
  for (const dir of new Set([real, cwd])) {
    const file = join(root, 'projects', dir.replace(/[^A-Za-z0-9]/g, '-'), `${session}.jsonl`);
    if (existsSync(file)) return file;
  }
  return undefined;
}
