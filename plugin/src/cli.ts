// The animus command.
import { resolve } from 'node:path';
import { parseArgs } from 'node:util';
import { claudeAgent } from './agent.ts';
import { cleanup, describeCleanup, KEEP_DAYS } from './cleanup.ts';
import { initProfile } from './init.ts';
import { describe, failsOnBase, jobChecks, runChecks } from './gates.ts';
import { touchedFiles } from './git.ts';
import { describeRuns, jobDir, loadState, readRuns, type Run } from './log.ts';
import { factoryVersion, jobOf, onPath, runJob, uiJobOf } from './pipeline.ts';
import { describeNumbers, numbers, refreshOutcomes } from './outcomes.ts';
import { prFacts, prState, publish, pushEvidence } from './pr.ts';
import { loadProfile } from './profile.ts';
import { describePlan, loadFactory, resolvePlan } from './profiles.ts';
import { git, AnimusError, GitError } from './proc.ts';
import { describeSkills, grantsFor } from './skills.ts';
import { loadSpec } from './spec.ts';
import { describeShots, takeShots, uiDown, uiTarget, uiUp } from './ui.ts';
import { join } from 'node:path';

const USAGE = `animus: a spec goes in, a pull request with proof comes out

  animus run <spec.md> [--repo <dir>] [--dry-run] [--draft] [--keep]
        Run one job: set up a worktree, implement, gates, review, open the PR.
        --dry-run stops before the push; --draft opens the PR as a draft;
        --keep leaves the worktree.
        A spec with \`after: <spec.md>\` in its header waits until that spec's
        pull request is merged, then starts.
  animus plan <spec.md>
        Check a spec and print what its labels would run. Starts nothing.
  animus init [--repo <dir>] [--force]
        Draft .animus/animus.yaml from the repo's package.json, pyproject.toml,
        go.mod or Cargo.toml. Runs nothing; --force replaces a profile.
  animus resume <job> [--answer <text>] [--dry-run] [--keep]
        Pick up a job that asked a question or was interrupted.
  animus runs [-n <count>] [--json]
        The run log, newest last.
  animus outcomes [--json]
        What became of each pull request, read from GitHub (merged or closed,
        time to merge, human commits, reverted or reworked within 30 days),
        and the five numbers split by task class.
  animus cleanup [<job>...] [--days <n>] [--dry-run]
        Remove what finished jobs left: the branches (here and on origin) and
        worktree of a job whose pull request merged or closed, and the folder
        of a job that last ran over --days ago (default ${KEEP_DAYS}). A job with an
        open pull request is kept. A named job does not wait for --days.
        --dry-run only says what would go.
  animus skills
        The vendored skills, where each came from, and which role gets it.

Inside a job's worktree (the implementer runs these):
  animus check              Run the job's gates now.
  animus shots [--again]    Screenshot a UI job's pages.
  animus ui up | down       Start or stop a UI job's app.

  animus version`;

const say = (line: string) => console.error(line);


/** Prints a run's result as JSON; the exit code says whether it ended in a pull request. */
function finish(run: Run): number {
  console.log(JSON.stringify({ job: run.job, outcome: run.outcome, pr: run.pr, reason: run.reason, question: run.question, branch: run.branch, cost_usd: run.cost_usd, dir: run.dir }, null, 2));
  return run.outcome === 'pr' || run.outcome === 'dry-run' ? 0 : 1;
}

async function main(argv: string[]): Promise<number> {
  const [command, ...rest] = argv;
  const { values, positionals } = parseArgs({
    args: rest, allowPositionals: true,
    options: {
      repo: { type: 'string' }, 'dry-run': { type: 'boolean' }, keep: { type: 'boolean' }, draft: { type: 'boolean' }, answer: { type: 'string' },
      json: { type: 'boolean' }, n: { type: 'string', short: 'n' }, again: { type: 'boolean' }, days: { type: 'string' }, force: { type: 'boolean' },
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
      return finish(await runJob({ repo, specFile, ...flags }, deps()));
    }
    case 'plan': {
      if (!positionals[0]) throw new AnimusError('usage: animus plan <spec.md>');
      const spec = loadSpec(resolve(positionals[0]));
      const factory = loadFactory();
      const plan = resolvePlan(factory, spec);
      console.log(`${spec.title}\n${describePlan(factory, plan)}`);
      for (const role of ['implementer', ...(plan.review ? [plan.review.role] : [])]) console.log(`  skills     ${role}: ${grantsFor(factory, role, plan.type).map((g) => g.name).join(', ') || 'none'}`);
      if (spec.after.length) console.log(`  waits for  ${spec.after.join(', ')} to be merged`);
      if (spec.defaulted.length) console.log(`  (no ${spec.defaulted.join(', ')} in the header: the default)`);
      spec.criteria.forEach((c, i) => console.log(`  ${i + 1}. ${c.text}${c.commands.map((x) => `\n       $ ${x}`).join('') || '\n       (no check command: only the reviewer judges it)'}`));
      return 0;
    }
    case 'init': {
      const r = initProfile(git(resolve(values.repo ?? cwd), ['rev-parse', '--show-toplevel']), Boolean(values.force));
      say(`wrote ${r.file}`);
      for (const line of r.said) say(`not found: ${line}`);
      say('Read it and correct it before the first job: its commands are the gates.');
      console.log(r.text);
      return 0;
    }
    case 'resume': {
      const state = positionals[0] ? loadState(positionals[0]) : undefined;
      if (!state) throw new AnimusError(positionals[0] ? `no job ${positionals[0]} under ${jobDir('')}` : 'usage: animus resume <job> [--answer <text>]');
      return finish(await runJob({ repo: state.repo, resume: { state, ...(values.answer ? { answer: values.answer } : {}) }, ...flags }, deps()));
    }
    case 'runs': {
      const runs = readRuns().slice(-Number(values.n ?? 20));
      console.log(values.json ? JSON.stringify(runs, null, 2) : describeRuns(runs));
      return 0;
    }
    case 'outcomes': {
      if (!onPath('gh')) say('gh is not installed: showing the outcomes as last read');
      const outcomes = refreshOutcomes(onPath('gh') ? prFacts : () => undefined);
      const rows = numbers(readRuns(), outcomes);
      console.log(values.json ? JSON.stringify({ numbers: rows, pull_requests: Object.values(outcomes) }, null, 2) : describeNumbers(rows));
      return 0;
    }
    case 'cleanup': {
      const days = values.days === undefined ? KEEP_DAYS : Number(values.days);
      if (!Number.isFinite(days) || days < 0) throw new AnimusError(`--days takes a number of days, not ${values.days}`);
      if (!onPath('gh')) throw new AnimusError('gh is not installed, so cleanup cannot tell which pull requests are finished');
      const dryRun = Boolean(values['dry-run']);
      console.log(describeCleanup(cleanup({ jobs: positionals, days, dryRun }, prState), dryRun));
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
        if (state.plan.prove) {
          // The proof reads the test files from a commit, so it sees only what is committed.
          const head = git(root, ['rev-parse', 'HEAD']);
          results.push(failsOnBase({ repo: state.repo, profile, spec, base: state.workspace.base, head, files: touchedFiles(root, state.workspace.base, head), job: state.job, green: results.every((r) => r.ok) }));
        }
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
