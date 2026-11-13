// The animus command.
import { spawn, spawnSync } from 'node:child_process';
import { mkdirSync, openSync, rmSync, writeFileSync } from 'node:fs';
import { resolve } from 'node:path';
import { parseArgs } from 'node:util';
import { claudeAgent } from './agent.ts';
import { describe, jobChecks, runChecks } from './gates.ts';
import { touchedFiles } from './git.ts';
import { describeJob, describeRuns, describeStatus, jobDir, loadState, readRuns, running, type Run } from './log.ts';
import { factoryVersion, jobOf, newJobId, onPath, runJob, uiJobOf } from './pipeline.ts';
import { publish, pushEvidence } from './pr.ts';
import { loadProfile } from './profile.ts';
import { describePlan, loadFactory, resolvePlan } from './profiles.ts';
import { git, AnimusError, GitError } from './proc.ts';
import { describeSkills, grantsFor } from './skills.ts';
import { loadSpec } from './spec.ts';
import { describeShots, takeShots, uiDown, uiTarget, uiUp } from './ui.ts';
import { join } from 'node:path';

const USAGE = `animus: a spec goes in, a pull request with proof comes out

  animus run <spec.md> [--repo <dir>] [--detach] [--dry-run] [--draft] [--keep]
        Run one job: set up a worktree, implement, gates, review, open the PR.
        --detach returns at once and the job runs by itself: the session that
        started it can be closed. --dry-run stops before the push; --draft
        opens the PR as a draft; --keep leaves the worktree.
  animus status [<job>]
        What is running and how the latest jobs ended; one job in detail.
  animus plan <spec.md>
        Check a spec and print what its labels would run. Starts nothing.
  animus resume <job> [--answer <text>] [--detach] [--dry-run] [--keep]
        Pick up a job that asked a question or was interrupted.
  animus runs [-n <count>] [--json]
        The run log, newest last.
  animus skills
        The vendored skills, where each came from, and which role gets it.

Inside a job's worktree (the implementer runs these):
  animus check              Run the job's gates now.
  animus shots [--again]    Screenshot a UI job's pages.
  animus ui up | down       Start or stop a UI job's app.

  animus version`;

const say = (line: string) => console.error(line);

/**
 * Starts the same command as a process of its own and returns at once, so the
 * session that started the job can be closed, cleared or compacted. Its
 * output goes to the job's run.log. On a Mac it runs under caffeinate, which
 * keeps the machine from idle sleep until the job ends.
 */
function detach(job: string, args: string[], flags: { dryRun?: boolean; draft?: boolean; keep?: boolean }): number {
  const dir = jobDir(job);
  mkdirSync(dir, { recursive: true });
  const log = join(dir, 'run.log');
  const node = [process.execPath, ...process.execArgv, process.argv[1]!, ...args, '--job', job,
    ...(flags.dryRun ? ['--dry-run'] : []), ...(flags.draft ? ['--draft'] : []), ...(flags.keep ? ['--keep'] : [])];
  const command = process.platform === 'darwin' && onPath('caffeinate') ? ['caffeinate', '-i', ...node] : node;
  const out = openSync(log, 'a');
  const child = spawn(command[0]!, command.slice(1), { detached: true, stdio: ['ignore', out, out], env: { ...process.env, ANIMUS_DETACHED: '1' } });
  child.unref();
  if (!child.pid) throw new AnimusError('could not start the job');
  writeFileSync(join(dir, 'pid'), String(child.pid));
  console.log(JSON.stringify({ job, started: true, log, status: `animus status ${job}` }, null, 2));
  return 0;
}

/** Prints a run's result; a detached run also tells the person, who may have no session open. */
function finish(run: Run): number {
  console.log(JSON.stringify({ job: run.job, outcome: run.outcome, pr: run.pr, reason: run.reason, question: run.question, branch: run.branch, cost_usd: run.cost_usd, dir: run.dir }, null, 2));
  if (process.env.ANIMUS_DETACHED) {
    rmSync(join(run.dir, 'pid'), { force: true });
    const text = run.outcome === 'needs-input' ? `Needs your answer: ${run.question ?? ''}` : run.pr ?? run.reason?.split('\n')[0] ?? run.outcome;
    if (process.platform === 'darwin') spawnSync('osascript', ['-e', `display notification ${JSON.stringify(text.slice(0, 200))} with title ${JSON.stringify(`Animus: ${run.outcome}`)} subtitle ${JSON.stringify(run.title.slice(0, 80))}`], { stdio: 'ignore' });
  }
  return run.outcome === 'pr' || run.outcome === 'dry-run' ? 0 : 1;
}

async function main(argv: string[]): Promise<number> {
  const [command, ...rest] = argv;
  const { values, positionals } = parseArgs({
    args: rest, allowPositionals: true,
    options: {
      repo: { type: 'string' }, 'dry-run': { type: 'boolean' }, keep: { type: 'boolean' }, draft: { type: 'boolean' }, detach: { type: 'boolean' }, job: { type: 'string' }, answer: { type: 'string' },
      json: { type: 'boolean' }, n: { type: 'string', short: 'n' }, again: { type: 'boolean' },
    },
  });
  const cwd = process.cwd();
  const flags = { ...(values.draft ? { draft: true } : {}), ...(values['dry-run'] ? { dryRun: true } : {}), ...(values.keep ? { keep: true } : {}) };
  const deps = () => {
    const factory = loadFactory();
    return { factory, agent: claudeAgent(factory), publish, evidence: pushEvidence, log: say };
  };

  switch (command) {
    case 'run': {
      if (!positionals[0]) throw new AnimusError('usage: animus run <spec.md>');
      if (!values['dry-run'] && !onPath('gh')) throw new AnimusError('gh is not installed, so no pull request can be opened; install it or use --dry-run');
      const specFile = resolve(positionals[0]);
      const repo = resolve(values.repo ?? cwd);
      if (values.detach) {
        // Refuse a bad spec or a repo without a profile here, where the person still sees it.
        const spec = loadSpec(specFile);
        resolvePlan(loadFactory(), spec);
        loadProfile(git(repo, ['rev-parse', '--show-toplevel']));
        return detach(newJobId(spec.title), ['run', specFile, '--repo', repo], flags);
      }
      return finish(await runJob({ repo, specFile, ...(values.job ? { job: values.job } : {}), ...flags }, deps()));
    }
    case 'plan': {
      if (!positionals[0]) throw new AnimusError('usage: animus plan <spec.md>');
      const spec = loadSpec(resolve(positionals[0]));
      const factory = loadFactory();
      const plan = resolvePlan(factory, spec);
      console.log(`${spec.title}\n${describePlan(factory, plan)}`);
      for (const role of ['implementer', ...(plan.review ? [plan.review.role] : [])]) console.log(`  skills     ${role}: ${grantsFor(factory, role, plan.type).map((g) => g.name).join(', ') || 'none'}`);
      if (spec.defaulted.length) console.log(`  (no ${spec.defaulted.join(', ')} in the header: the default)`);
      spec.criteria.forEach((c, i) => console.log(`  ${i + 1}. ${c.text}${c.commands.map((x) => `\n       $ ${x}`).join('') || '\n       (no check command: only the reviewer judges it)'}`));
      return 0;
    }
    case 'resume': {
      const state = positionals[0] ? loadState(positionals[0]) : undefined;
      if (!state) throw new AnimusError(positionals[0] ? `no job ${positionals[0]} under ${jobDir('')}` : 'usage: animus resume <job> [--answer <text>]');
      if (running(state.job)) throw new AnimusError(`job ${state.job} is still running`);
      if (values.detach) return detach(state.job, ['resume', state.job, ...(values.answer ? ['--answer', values.answer] : [])], flags);
      return finish(await runJob({ repo: state.repo, resume: { state, ...(values.answer ? { answer: values.answer } : {}) }, ...flags }, deps()));
    }
    case 'status':
      console.log(positionals[0] ? describeJob(positionals[0]) : describeStatus());
      return 0;
    case 'runs': {
      const runs = readRuns().slice(-Number(values.n ?? 20));
      console.log(values.json ? JSON.stringify(runs, null, 2) : describeRuns(runs));
      return 0;
    }
    case 'check': case 'shots': case 'ui': {
      const root = git(cwd, ['rev-parse', '--show-toplevel']);
      const job = jobOf(root);
      const state = job ? loadState(job) : undefined;
      if (!state) throw new AnimusError(`animus ${command} runs inside a job's worktree, and this is not one`);
      const spec = loadSpec(state.spec);
      const profile = loadProfile(state.repo);
      if (command === 'check') {
        const files = [...new Set([...touchedFiles(root, state.workspace.base, 'HEAD'), ...git(root, ['ls-files', '--others', '--modified', '--exclude-standard']).split('\n').filter(Boolean)])];
        const results = runChecks(root, jobChecks(profile, state.plan, spec, { base: state.workspace.base, files }), state.job);
        console.log(describe(results));
        return results.every((r) => r.ok) ? 0 : 1;
      }
      if (state.plan.type !== 'ui') throw new AnimusError('this job is not a ui job');
      const ui = uiJobOf(state.job, spec);
      if (command === 'shots') {
        const r = await takeShots(root, ui, profile, join(jobDir(state.job), 'shots'), values.again ? { again: true } : {});
        console.log(describeShots(r.dir, r.shots, r.reused));
        return 0;
      }
      if (positionals[0] === 'up') {
        const up = await uiUp(root, uiTarget(profile, ui)!);
        console.log(up.url ? `running at ${up.url}` : `running (port ${up.port})`);
        return 0;
      }
      if (positionals[0] === 'down') {
        console.log(uiDown(root) ? 'stopped' : 'nothing was running');
        return 0;
      }
      throw new AnimusError('usage: animus ui up | down');
    }
    case 'skills':
      console.log(describeSkills(loadFactory()));
      return 0;
    case 'version':
      console.log(factoryVersion());
      return 0;
    case undefined: case 'help': case '--help': case '-h':
      console.log(USAGE);
      return 0;
    default:
      throw new AnimusError(`unknown command ${command}\n\n${USAGE}`);
  }
}

main(process.argv.slice(2)).then((code) => process.exit(code), (err: unknown) => {
  if (err instanceof AnimusError || err instanceof GitError) {
    console.error(`animus: ${err.message}`);
    process.exit(2);
  }
  throw err;
});
