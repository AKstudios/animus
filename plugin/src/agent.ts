// The one function every agent step goes through (docs/factory.md, "Model
// tiers and providers"): tier, effort, prompt and working directory in;
// transcript and exit status out. Nothing else in Animus knows which CLI runs
// a model, so another provider is another function of this shape.
import { spawnSync } from 'node:child_process';
import { existsSync, readFileSync, realpathSync } from 'node:fs';
import { homedir } from 'node:os';
import { basename, dirname, join, parse, resolve } from 'node:path';
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
  /** Folders outside cwd the session may read: a vendored skill's files. */
  addDirs?: string[];
  /** No file edits: the reviewer's sessions. */
  readOnly?: boolean;
  /** Read, Glob and Grep and no other tool, so nothing reaches past the files: a draft session, whose prompt quotes other people. */
  filesOnly?: boolean;
  timeoutMs?: number;
  /** Tokens of context at which the provider compacts the session while it runs. */
  compactAt?: number;
  /** Dollars this session may spend before the provider ends it. */
  maxUsd?: number;
  /** Variables set for this session on top of the process's own: one person's credentials, when they are being checked. */
  env?: Record<string, string>;
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
  /** Tokens in the session's context when it ended, when the transcript says: what a resume would start from. */
  context?: number;
  /** The session's tool calls, when the transcript says. */
  tools?: ToolCall[];
};

export type Agent= (req: AgentRequest) => AgentResult;

const DEFAULT_TIMEOUT_MS = 60 * 60 * 1000;

type ClaudeJson = {
  is_error?: boolean; subtype?: string; result?: string; structured_output?: unknown; session_id?: string;
  total_cost_usd?: number; num_turns?: number;
  usage?: { input_tokens?: number; output_tokens?: number; cache_read_input_tokens?: number; cache_creation_input_tokens?: number };
  modelUsage?: Record<string, { costUSD?: number }>;
};

/**
 * CLAUDE.md and .claude/rules of the person's home and of every folder above
 * cwd, as absolute patterns for claudeMdExcludes: a worktree inside the home
 * folder would otherwise read them as rules of a folder above it. cwd's own
 * are not matched.
 */
function instructionFilesAbove(cwd: string): string[] {
  const dirs = new Set([homedir()]);
  for (let d = dirname(resolve(cwd)); dirname(d) !== d; d = dirname(d)) dirs.add(d);
  dirs.add(parse(resolve(cwd)).root);
  dirs.delete(resolve(cwd));
  return [...dirs].flatMap((d) => [join(d, 'CLAUDE.md'), join(d, '.claude', 'CLAUDE.md'), join(d, '.claude', 'rules', '**')]).map((p) => p.replaceAll('\\', '/'));
}

/**
 * Claude Code, headless. Sessions load the project's own settings and rules
 * only (--setting-sources project), so a job runs the same on a laptop and in
 * a container that has none of the person's own. No MCP server starts, not
 * even one the person added for themselves (--strict-mcp-config with none
 * given): a job's tools are the ones listed below. They get no Skill tool and no
 * slash commands: a skill reaches a role as text in its instructions
 * (skills.ts), so each role has exactly the skills it was granted.
 */
export function claudeAgent(factory: Factory, command = process.env.ANIMUS_CLAUDE ?? 'claude'): Agent {
  return (req) => {
    const model = modelFor(factory, req.tier);
    const args = ['-p', req.prompt, '--model', model, '--effort', req.effort, '--output-format', 'json', '--permission-mode', 'dontAsk', '--setting-sources', 'project', '--disable-slash-commands', '--strict-mcp-config'];
    args.push('--settings', JSON.stringify({ claudeMdExcludes: instructionFilesAbove(req.cwd) }));
    for (const dir of req.addDirs ?? []) args.push('--add-dir', dir);
    if (req.resume) args.push('--resume', req.resume);
    if (req.system) args.push('--append-system-prompt', req.system);
    if (req.schema) args.push('--json-schema', JSON.stringify(req.schema));
    if (req.compactAt) args.push('--autocompact', String(req.compactAt));
    if (req.maxUsd) args.push('--max-budget-usd', String(req.maxUsd));
    const noGit = ['Bash(git push:*)', 'Bash(git checkout:*)', 'Bash(git switch:*)', 'Bash(git worktree:*)', 'Bash(gh:*)'];
    if (req.filesOnly) args.push('--allowedTools', 'Read', 'Glob', 'Grep', '--disallowedTools', 'Bash', 'Edit', 'Write', 'NotebookEdit', 'WebFetch', 'WebSearch');
    else if (req.readOnly) args.push('--allowedTools', 'Bash', 'Read', 'Glob', 'Grep', '--disallowedTools', 'Edit', 'Write', 'NotebookEdit', 'Bash(git commit:*)', ...noGit);
    else args.push('--allowedTools', 'Bash', 'Read', 'Write', 'Edit', 'Glob', 'Grep', '--disallowedTools', ...noGit);

    const started = Date.now();
    const r = spawnSync(command, args, { cwd: req.cwd, encoding: 'utf8', timeout: req.timeoutMs ?? DEFAULT_TIMEOUT_MS, maxBuffer: 256 * 1024 * 1024, ...(req.env ? { env: { ...process.env, ...req.env } } : {}) });
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
      if (file) {
        result.transcript = file;
        const context = contextAtEnd(file);
        if (context !== undefined) result.context = context;
        result.tools = toolCalls(file, started);
      }
    }
    return result;
  };
}

/** One tool call of a session, in no provider's words: when, which tool, what it touched, whether it failed, how long it took. */
export type ToolCall = { at: string; tool: string; target: string; ok: boolean; ms: number };

const TARGET_MAX = 300;
/** What a tool call touched: a command, a file, a pattern, an address. Never the tool's output. */
const targetOf = (input: Record<string, unknown>): string => {
  const v = input.command ?? input.file_path ?? input.notebook_path ?? input.pattern ?? input.url ?? input.query ?? input.path;
  return typeof v === 'string' ? v.slice(0, TARGET_MAX) : '';
};

/**
 * The tool calls in a Claude Code transcript, in order. A call with no result (the session ended mid-call) counts as failed.
 * Only calls made at or after `since` (ms): a resumed session's transcript also holds the turns before.
 */
export function toolCalls(transcript: string, since = 0): ToolCall[] {
  let lines: string[];
  try { lines = readFileSync(transcript, 'utf8').split('\n'); } catch { return []; }
  const calls: (ToolCall & { id: string; start: number })[] = [];
  for (const line of lines) {
    if (!line.includes('"tool_use"') && !line.includes('"tool_result"')) continue;
    let e: { timestamp?: string; message?: { content?: unknown } };
    try { e = JSON.parse(line); } catch { continue; }
    const at = e.timestamp ?? '';
    const time = Date.parse(at);
    if (!Array.isArray(e.message?.content)) continue;
    for (const part of e.message.content as { type?: string; id?: string; name?: string; input?: Record<string, unknown>; tool_use_id?: string; is_error?: boolean }[]) {
      if (part.type === 'tool_use' && part.id && part.name) calls.push({ id: part.id, start: time, at, tool: part.name, target: targetOf(part.input ?? {}), ok: false, ms: 0 });
      else if (part.type === 'tool_result') {
        const call = calls.find((c) => c.id === part.tool_use_id);
        if (call) { call.ok = !part.is_error; call.ms = Number.isNaN(time) || Number.isNaN(call.start) ? 0 : Math.max(0, time - call.start); }
      }
    }
  }
  return calls.filter((c) => !(c.start < since)).map(({ at, tool, target, ok, ms }) => ({ at, tool, target, ok, ms }));
}

/**
 * How full the session's context was at its last message: what that message
 * was sent (new, cached and newly cached tokens) and what it answered. The
 * session's total usage does not say this, since it counts every turn's input.
 */
export function contextAtEnd(transcript: string): number | undefined {
  let lines: string[];
  try { lines = readFileSync(transcript, 'utf8').split('\n'); } catch { return undefined; }
  for (let i = lines.length - 1; i >= 0; i--) {
    if (!lines[i]!.includes('"usage"')) continue;
    try {
      const entry = JSON.parse(lines[i]!) as { type?: string; isSidechain?: boolean; message?: { usage?: Record<string, unknown> } };
      const u = entry.message?.usage;
      if (entry.type !== 'assistant' || entry.isSidechain || !u) continue;
      const n = (k: string) => (typeof u[k] === 'number' ? (u[k] as number) : 0);
      return n('input_tokens') + n('cache_read_input_tokens') + n('cache_creation_input_tokens') + n('output_tokens');
    } catch { /* a line cut short: the one before it */ }
  }
  return undefined;
}

/**
 * The folders where Claude Code keeps the transcripts of sessions started in
 * cwd: one per spelling of the path (as given, and with links resolved).
 */
export function claudeProjectDirs(cwd: string): string[] {
  const root = process.env.CLAUDE_CONFIG_DIR ?? join(homedir(), '.claude');
  return [...new Set([realPath(cwd), cwd])].map((dir) => join(root, 'projects', dir.replace(/[^A-Za-z0-9]/g, '-')));
}

/** A path with links resolved, through the nearest folder that still exists when it is gone (a removed worktree). */
function realPath(path: string): string {
  try { return realpathSync(path); } catch { /* gone: resolve what is left of it */ }
  const parent = dirname(path);
  return parent === path ? path : join(realPath(parent), basename(path));
}

/** Claude Code's transcript of a session started in cwd, if it is still on disk. */
function claudeTranscript(cwd: string, session: string): string | undefined {
  return claudeProjectDirs(cwd).map((dir) => join(dir, `${session}.jsonl`)).find((file) => existsSync(file));
}
