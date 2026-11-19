// The animus command.
import { spawn } from 'node:child_process';
import { existsSync, readFileSync } from 'node:fs';
import { resolve } from 'node:path';
import { parseArgs } from 'node:util';
import { claudeAgent } from './agent.ts';
import { cleanup, describeCleanup, KEEP_DAYS, type PrEnd } from './cleanup.ts';
import { describeFindings, doctor } from './doctor.ts';
import { writeDraft } from './draft.ts';
import { enable, realRun, setup, terminalIo, thisMachine } from './setup.ts';
import { initProfile } from './init.ts';
import { ask, githubLogin, joinHelix, leaveHelix, openPage } from './join.ts';
import { addProject } from './project.ts';
import { describe, failsOnBase, jobChecks, runChecks } from './gates.ts';
import { fixAlone, fixFromPr, fixSkills, fixTarget, isPr, keptFromBody, openedHere, whereToFix } from './fix.ts';
import { githubUrl, mainCheckout, touchedFiles } from './git.ts';
import { describeRuns, describeTools, jobDir, loadState, masked, readRuns, readTools, type Run } from './log.ts';
import { jobOf, onPath, runJob, uiJobOf } from './pipeline.ts';
import { describeNumbers, numbers, refreshOutcomes } from './outcomes.ts';
import { ghLogin, prFacts, publish, pushEvidence } from './pr.ts';
import { resolveAfter } from './after.ts';
import { loopConfig, personalFor, readSkillsFile, skillsForRole, snapshotSkills, whereToRun, type PersonalSkill, type Where } from './personal.ts';
import { accept, describeLessons, dismiss, readLessons } from './lessons.ts';
import { runRetro } from './retro.ts';
import { claimLocal, gitIdentity, localServer } from './local-display.ts';
import { enqueue, ensureLoop, openLocalQueue, queueFile, type LocalQueue } from './local-queue.ts';
import { answerLocal, cancelLocal, describeLocalJob, describeLocalJobs, localJob, logTail, needsYou } from './local-status.ts';
import { logFile, runLoop } from './local-loop.ts';
import { loadProfile, maskSecrets, PROFILE_PATH, useJobEnv } from './profile.ts';
import { describePlan, loadFactory, resolvePlan } from './profiles.ts';
import { admitFile, describeAdmit } from './admit.ts';
import { git, tryGit, AnimusError, GitError } from './proc.ts';
import * as helix from './remote.ts';
import { describeSkills, grantsFor } from './skills.ts';
import { criteriaSoFar, describeSlicing, planSlices } from './slices.ts';
import { loadSpec } from './spec.ts';
import { animusVersion, factoryVersion } from './version.ts';
import { describeShots, takeShots, uiDown, uiTarget, uiUp } from './ui.ts';
import { basename, join } from 'node:path';

const USAGE = `animus: a spec goes in, a pull request with proof comes out

  animus start <spec.md> [--local | --helix] [--repo <dir>] [--draft]
        Start one job, here or on Helix. --local or --helix decides; without
        either, run: in ANIMUS_HOME/config.yaml does (the repository's entry,
        then the top); without that, Helix when this machine has joined one
        that has the repository, and here otherwise. Here, it queues the job,
        makes sure this machine's loop is running and returns: the loop runs
        the job whether or not this session stays open. On Helix, it is
        animus submit and returns.
  animus start <pr> "<what to change>" [--local | --helix] [--repo <dir>] [--dry-run] [--keep]
        Change an open pull request a job opened (<pr> is its number or URL):
        a new job on its branch that proves every criterion again and pushes
        to the same pull request. It runs here when a job here opened it, and
        carries on from that job's session; else on Helix when this machine
        has joined one that has the repository; else here, from the pull
        request alone. --local or --helix decides, and says what it leaves.
  animus run <spec.md> [--repo <dir>] [--dry-run] [--draft] [--keep]
        Run one job: set up a worktree, implement, gates, review, open the PR.
        --dry-run stops before the push; --draft opens the PR as a draft;
        --keep leaves the worktree.
        A spec with \`after: <spec.md>\` in its header waits until that spec's
        pull request is merged, then starts; --after-merged says a queue has
        already seen it merged, so the job starts at once.
        Your own skills in ANIMUS_HOME/config.yaml are copied into the job
        when it starts (--skills <file> gives them instead, as JSON).
  animus plan <spec.md> [--slices] [--repo <dir>]
        Check a spec and print what its labels would run. Starts no job.
        --slices also asks the planner how it would cut the spec (one
        read-only session in the repo) and prints the checked plan.
  animus draft <folder> [--repo <dir>]
        Write <folder>/draft.md, a spec, from <folder>/message.md and the
        references fetched beside it: one fast session that reads files and
        nothing else, with no GitHub token, stopped at $0.50. Helix runs it.
  animus init [--repo <dir>] [--force]
        Draft .animus/animus.yaml from the repo's package.json, pyproject.toml,
        go.mod or Cargo.toml. Runs nothing; --force replaces a profile.
  animus resume <job> [--answer <text>] [--dry-run] [--keep]
        Pick up a job that asked a question or was interrupted.
  animus runs [-n <count>] [--json]
        The run log, newest last.
  animus tools <job> [--json]
        Each agent session of the job (stage, role, tier, model) with its tool
        calls counted by tool and its failed calls, then every call in order:
        when, which tool, what it touched, and whether it failed. --json
        prints the lines of the job's tools.jsonl.
  animus outcomes [--json]
        What became of each pull request, read from GitHub (merged or closed,
        time to merge, human commits, reverted or reworked within 30 days),
        and the five numbers split by task class.
  animus retro [--project <name>] [--days <n>]
        A standard-tier session, read-only, over the project's runs of the last
        --days days (default 7; the current repo's project unless named): it
        proposes at most 5 lessons, each one sentence for one agent
        (implementer, planner, reviewer or spec), citing at least two jobs, or
        one whose pull request was reverted or reworked. The script drops the
        rest. Nothing is kept until you accept it.
  animus lessons [accept <id> | dismiss <id>]
        The proposed, kept and expired lessons with their ids, citations, uses
        and days left (a kept lesson expires 60 days after it was accepted or
        a retro saw it again). accept keeps a proposed or expired lesson;
        dismiss drops it, and the retro is told not to propose it again.
        For a checkout of a project on Helix these go to Helix, which runs
        its own retro each week; --local or --helix decides.
  animus cleanup [<job>...] [--days <n>] [--dry-run]
        Remove what finished jobs left: the worktree of a job whose pull
        request merged or closed, and its branches (here and on origin) once
        that was over --days ago (default ${KEEP_DAYS}); a job with no pull request
        loses both once it last ran that long ago. A job with an open pull
        request, or waiting for an answer, is kept. Job folders, transcripts
        and the run log are kept for analysis; a named job goes whole, folder
        too, at once. --dry-run only says what would go.
  animus skills
        The vendored skills, where each came from, and which role gets it.
  animus setup
        Get this machine ready, asking as it goes: Claude Code and gh signed
        in, Animus updating itself, the projects Animus is on in, and the
        animus command in ~/.local/bin for a terminal.
  animus enable [<dir>]
        Turn Animus on in one more checkout (this one by default), for you
        only: Claude Code keeps it in the checkout's .claude/settings.local.json.
  animus doctor
        Whether this machine can run and submit jobs: Node, Claude Code, git,
        gh, the repo's profile, Helix and its version, and what in your own
        setup reaches a job (orbit's plugin, git hooks, commit signing).
        Exits 1 if something would stop a job.

With Helix, the machine that runs jobs for everyone:
  animus join <url> <code>
        Join a Helix with the one-time code from helix invite: checks this
        machine, has you make a Claude token and a GitHub token (or, on a
        Helix with a GitHub App, approve GitHub's sign-in), and sends them.
        Helix tries them, and the Helix token it gives back is kept in
        ANIMUS_HOME/helix.json. (HELIX_URL and HELIX_TOKEN, when set, win.)
  animus leave [--yes]
        Take yourself off it: your jobs there are cancelled, and it deletes
        your tokens.
  animus github login
        On a Helix with a GitHub App, sign in to GitHub again when your jobs
        fail with "run animus github login" (the sign-in was revoked, or
        unused for six months): approve GitHub's code as the account you
        joined with, and Helix replaces the tokens it keeps.
  animus invite <name> [--github <login>] [--slack <member-id>]
        The owner only: what helix invite does on the machine, from here.
  animus remove-person <name>
        The owner only: what helix remove-person does on the machine, from here.
        The owner themselves cannot leave or be removed until another is named.
  animus project add [<name>]
        Put this checkout's repository on Helix, named after its folder unless
        given a name. Helix clones it with your GitHub token, and runs its
        profile's setup once, before it takes it; this waits and shows how it
        goes. Anyone on Helix whose GitHub token may push to it may then submit
        for it.
  animus project list
  animus project remove <name>
        Only whoever added it, or the owner; its people's clones on Helix are
        deleted.
  animus project secret set <project> <NAME> [--mine]
        Keep a value on Helix that the project's jobs get as NAME when its
        profile's secrets: lists it. The value is typed at a prompt or piped
        in, never given as an argument. Shared values are set by whoever added
        the project, or the owner; with --mine, your own, which your jobs get
        first. The model can read every secret a job gets.
  animus project secret list <project>
  animus project secret remove <project> <NAME> [--mine]
  animus submit <spec.md> [--repo <dir>] [--draft]
        Queue the spec there, for the project with this checkout's GitHub
        address (or, failing that, named after its folder), with your own
        skills from ANIMUS_HOME/config.yaml.
  animus status [<id>] [--local | --helix] [--all]
        Your jobs: this machine's queue first, which lists what needs you
        before the rest (questions, failures and pull requests opened since
        you last looked; a job held for room says why), then Helix's when
        this machine has joined one. Or one job with the end of its log.
        --all: every person's jobs on Helix, for the owner only.
  animus result <id>        One job as JSON; exits 0 once it ended in a pull request.
  animus answer <id> <text> Answer a job's question; it is queued again.
  animus cancel <id>        Your own job, or the owner cancels anyone's on Helix.
        These four take a job of this machine's queue, or one of Helix's: with
        a Helix joined, --local names one here (and --helix one there).
  animus ui                 Show the jobs this machine ran in your browser, by
                            project, at 127.0.0.1 (port 7420 or the next free
                            one). Ctrl-C stops it.
  animus ui --helix         Open Helix's display in your browser, signed in.

Inside a job's worktree (the implementer runs these):
  animus check              Run the job's gates now.
  animus shots [--again]    Screenshot a UI job's pages.
  animus ui up | down       Start or stop a UI job's app.

  animus version`;

const say = (line: string) => console.error(line);

/** Where `animus ui` listens first; the next free port when it is taken. */
const LOCAL_PORT = 7420;

/** The submitter's skills for a job here: given as a file (how Helix passes them), none on Helix, else from their config. */
function localSkills(repo: string, file: string | undefined): PersonalSkill[] {
  if (file) return readSkillsFile(resolve(file));
  // A job Helix started reads no config on the machine: the submitter's skills came with the spec.
  if (process.env.ANIMUS_TRIGGER === 'helix') return [];
  return snapshotSkills(personalFor(repo).skills);
}

/** Sends a spec to Helix with the person's skills, for the project with this checkout's GitHub address. */
/** The Helix project with this checkout's GitHub address, whatever it was named when added; else one named after the folder. */
async function projectNamed(root: string): Promise<string> {
  const url = githubUrl(tryGit(root, ['remote', 'get-url', 'origin']) ?? '');
  // A Helix from before projects has no list to ask.
  const list = url ? await helix.projects().then((r) => r.projects, () => []) : [];
  return list.find((p) => p.url === url)?.name ?? basename(root);
}

/** Says what Helix queued and where to follow it. */
function announce(j: helix.RemoteJob, skills: readonly { name: string }[]): void {
  for (const w of j.warnings ?? []) say(`warning: ${w}`);
  if (skills.length && !j.skills) say(`this Helix predates personal skills: the job runs without ${skills.map((s) => s.name).join(', ')}`);
  console.log(`job ${j.id} is ${j.state} on Helix: ${j.title}${j.skills?.length ? `\nwith your skills: ${j.skills.join(', ')}` : ''}\nfollow it with: animus status ${j.id}${helix.describeLinks(j).map((l) => `\n${l}`).join('')}`);
}

async function submitSpec(file: string, checkout: string, draft: boolean, known?: string): Promise<helix.RemoteJob> {
  // Refused here, before it is sent, when its labels would not run.
  resolvePlan(loadFactory(), loadSpec(file));
  const root = mainCheckout(checkout);
  const repo = known ?? await projectNamed(root);
  const skills = snapshotSkills(personalFor(root).skills);
  const profileFile = join(root, PROFILE_PATH);
  const j = await helix.submit({
    repo, spec: readFileSync(file, 'utf8'), name: basename(file), ...(draft ? { draft: true } : {}), ...(skills.length ? { skills: skills.map(({ sha: _sha, ...s }) => s) } : {}),
    ...(existsSync(profileFile) ? { profile: readFileSync(profileFile, 'utf8') } : {}),
  });
  announce(j, skills);
  return j;
}


/** Prints a run's result as JSON; the exit code says whether it ended in a pull request. */
function finish(run: Run): number {
  console.log(JSON.stringify({ job: run.job, outcome: run.outcome, pr: run.pr, reason: run.reason, question: run.question, branch: run.branch, cost_usd: run.cost_usd, dir: run.dir }, masked, 2));
  return run.outcome === 'pr' || run.outcome === 'dry-run' ? 0 : 1;
}

/** Any command starts the loop again while jobs are left and none runs it: after a reboot, a crash or a loop that was stopped. */
function keepLoop(): void {
  if (!existsSync(queueFile())) return;
  const queue = openLocalQueue();
  try { ensureLoop(queue); } catch (err) { say(`warning: the queue's loop could not be started: ${(err as Error).message}`); } finally { queue.close(); }
}

async function main(argv: string[]): Promise<number> {
  const [command, ...rest] = argv;
  const { values, positionals } = parseArgs({
    args: rest, allowPositionals: true,
    options: {
      repo: { type: 'string' }, project: { type: 'string' }, 'dry-run': { type: 'boolean' }, keep: { type: 'boolean' }, draft: { type: 'boolean' }, answer: { type: 'string' }, 'after-merged': { type: 'boolean' },
      json: { type: 'boolean' }, skills: { type: 'string' }, local: { type: 'boolean' }, helix: { type: 'boolean' }, n: { type: 'string', short: 'n' }, again: { type: 'boolean' }, days: { type: 'string' }, force: { type: 'boolean' }, slices: { type: 'boolean' }, yes: { type: 'boolean' }, github: { type: 'string' }, slack: { type: 'string' }, all: { type: 'boolean' }, references: { type: 'string' }, mine: { type: 'boolean' },
    },
  });
  const cwd = process.cwd();
  if (command !== 'loop' && command !== 'session-start') keepLoop();
  /** Whether a command about one job goes to Helix: --helix says so, --local says here, and otherwise Helix when this machine has joined one (a job here is then named with --local). */
  const onHelix = () => (values.helix ? true : values.local ? false : helix.helixLogin() !== undefined);
  const withQueue = <T>(fn: (queue: LocalQueue) => T): T => {
    if (!existsSync(queueFile())) throw new AnimusError('no jobs have been queued on this machine');
    const queue = openLocalQueue();
    try { return fn(queue); } finally { queue.close(); }
  };
  const flags ={ ...(values.draft ? { draft: true } : {}), ...(values['dry-run'] ? { dryRun: true } : {}), ...(values.keep ? { keep: true } : {}) };
  const deps = () => {
    const factory = loadFactory();
    return { factory, agent: claudeAgent(factory), publish, evidence: pushEvidence, log: say };
  };

  /** Runs a fix of `pr` on this machine: from the job here that opened it, else from the pull request alone. */
  const fixHere = async (repo: string, pr: string, text: string, runsLine?: string): Promise<number> => {
    if (!values['dry-run'] && !onPath('gh')) throw new AnimusError('gh is not installed, so the pull request cannot be updated; install it or use --dry-run');
    let fix: Omit<NonNullable<Parameters<typeof runJob>[0]['fix']>, 'ask'>;
    if (openedHere(repo, pr).length) {
      const { run, state } = fixTarget(repo, pr);
      const alone = fixAlone(repo, run, state);
      // The description is what the pull request shows now: its Closes line and Fixes list are kept, however old the earlier job's state.
      const kept = alone ? undefined : keptFromBody(run.pr!, repo);
      fix = { of: run.job, pr: run.pr!, ...(alone ? { alone } : { from: state!, ...(kept ? { kept } : {}) }) };
    } else fix = fixFromPr(repo, pr);
    // Skills given as a file are the launcher's choice (Helix passes them), unless the job it continues kept its own.
    const personal = values.skills && !existsSync(jobDir(fix.of)) ? localSkills(repo, values.skills)
      : fixSkills(fix.of, { author: fix.alone?.author, requester: () => ghLogin(repo), theirs: () => localSkills(repo, undefined) });
    return finish(await runJob({ repo, fix: { ...fix, ask: text, ...(values.references ? { references: resolve(values.references) } : {}) }, personal, ...(runsLine ? { runsLine } : {}), ...flags }, deps()));
  };

  switch (command) {
    case 'run': {
      if (!positionals[0]) throw new AnimusError('usage: animus run <spec.md>');
      if (!values['dry-run'] && !onPath('gh')) throw new AnimusError('gh is not installed, so no pull request can be opened; install it or use --dry-run');
      const specFile = resolve(positionals[0]);
      const repo = resolve(values.repo ?? cwd);
      const personal = localSkills(repo, values.skills);
      return finish(await runJob({ repo, specFile, personal, ...flags, ...(values['after-merged'] ? { afterMerged: true } : {}), ...(process.env.ANIMUS_TRIGGER ? { trigger: process.env.ANIMUS_TRIGGER } : {}) }, deps()));
    }
    case 'start': {
      if (!positionals[0]) throw new AnimusError('usage: animus start <spec.md> [--local | --helix] [--draft]');
      if (values.local && values.helix) throw new AnimusError('--local or --helix, not both');
      const specFile = resolve(positionals[0]);
      const repo = resolve(values.repo ?? cwd);
      const asked: Where | undefined = values.local ? 'local' : values.helix ? 'helix' : undefined;
      const mine = personalFor(repo);
      if (isPr(positionals[0])) {
        const [pr, ...text] = positionals;
        if (!text.length) throw new AnimusError('usage: animus start <pr> "<what to change>" [--local | --helix]');
        const root = mainCheckout(repo);
        const here = openedHere(root, pr!).at(-1)?.job;
        const choice = await whereToFix({ pr: pr!, ...(here ? { here } : {}), ...(asked ? { asked } : {}), checkout: repo });
        if (choice.left) say(choice.left);
        const runsLine = `this fix runs ${choice.where === 'helix' ? 'on Helix' : 'on this machine'}: ${choice.why}`;
        if (choice.where === 'local') return fixHere(root, pr!, text.join(' '), runsLine);
        say(runsLine);
        if (values['dry-run']) throw new AnimusError('--dry-run is for a fix on this machine: animus start <pr> "<what to change>" --local --dry-run');
        const skills = snapshotSkills(mine.skills);
        announce(await helix.fix({ repo: choice.project ?? await projectNamed(root), pr: pr!, ask: text.join(' '), ...(skills.length ? { skills: skills.map(({ sha: _sha, ...s }) => s) } : {}) }), skills);
        return 0;
      }
      const choice = await whereToRun({ ...(asked ? { asked } : {}), ...(mine.run ? { config: mine.run } : {}), checkout: repo });
      const runsLine = `this job runs ${choice.where === 'helix' ? 'on Helix' : 'on this machine'}: ${choice.why}`;
      if (choice.where === 'helix') {
        say(runsLine);
        if (values['dry-run']) throw new AnimusError('--dry-run is for a job on this machine: animus start --local --dry-run');
        await submitSpec(specFile, repo, Boolean(values.draft), choice.project);
        return 0;
      }
      if (!values['dry-run'] && !onPath('gh')) throw new AnimusError('gh is not installed, so no pull request can be opened; install it or use --dry-run');
      // Refused here, before it is queued, when its labels would not run or a skill of yours is missing.
      const spec = loadSpec(specFile);
      const { tier } = resolvePlan(loadFactory(), spec).implement;
      snapshotSkills(mine.skills);
      const after = resolveAfter(repo, specFile, spec.after);
      loopConfig();
      say(runsLine);
      const queue = openLocalQueue();
      try {
        const job = enqueue(queue, { repo, spec: specFile, title: spec.title, tier, after, flags: [...(values.draft ? ['--draft'] : []), ...(values['dry-run'] ? ['--dry-run'] : []), ...(values.keep ? ['--keep'] : [])] });
        ensureLoop(queue);
        console.log(`job ${job.id} is queued on this machine: ${job.title}\nfollow it with: animus status ${job.id}${helix.helixLogin() ? ' --local' : ''}\nits output: ${logFile(job.id)}`);
      } finally { queue.close(); }
      return 0;
    }
    case 'loop': {
      // What `animus` starts to run the queue on this machine, detached; not a command people type.
      const queue = openLocalQueue();
      try { await runLoop({ queue, version: animusVersion(), config: loopConfig(), say: (line) => console.log(`${new Date().toISOString()} ${line}`) }); } finally { queue.close(); }
      return 0;
    }
    case 'plan': {
      if (!positionals[0]) throw new AnimusError('usage: animus plan <spec.md>');
      const factory = loadFactory();
      const specFile = resolve(positionals[0]);
      const repoDir = mainCheckout(resolve(values.repo ?? cwd));
      const admitted = admitFile(factory, specFile, repoDir, loadProfile(repoDir));
      if (admitted.problems.length || !admitted.plan) {
        console.log(`${admitted.spec.title}\n${describeAdmit(admitted)}`);
        return 1;
      }
      const { spec, plan } = { spec: admitted.spec, plan: admitted.plan };
      console.log(`${spec.title}\n${describePlan(factory, plan)}\n${describeAdmit(admitted)}`);
      const yours = personalFor(resolve(values.repo ?? cwd)).skills;
      const asCarried = yours.map((e) => ({ ...e, text: '', sha: '' }));
      for (const role of ['implementer', ...(plan.review ? [plan.review.role] : [])]) console.log(`  skills     ${role}: ${[...grantsFor(factory, role, spec.type).map((g) => g.name), ...skillsForRole(asCarried, role, spec.type).map((s) => `${s.name} (yours)`)].join(', ') || 'none'}`);
      if (spec.after.length) console.log(`  waits for  ${spec.after.join(', ')} to be merged`);
      if (spec.defaulted.length) console.log(`  (no ${spec.defaulted.join(', ')} in the header: the default)`);
      spec.criteria.forEach((c, i) => console.log(`  ${i + 1}. ${c.text}${c.commands.map((x) => `\n       $ ${x}`).join('') || '\n       (no check command: only the reviewer judges it)'}`));
      if (values.slices) {
        const planned = planSlices({ factory, agent: claudeAgent(factory), spec, cwd: git(resolve(values.repo ?? cwd), ['rev-parse', '--show-toplevel']), log: say });
        console.log(`\n${describeSlicing(spec, planned)}`);
        for (const s of planned.sessions) say(`${s.stage}: $${s.result.cost_usd.toFixed(4)}${s.result.context !== undefined ? `, ${Math.round(s.result.context / 1000)}k tokens of context at the end` : ''}`);
      }
      return 0;
    }
    case 'draft': {
      if (!positionals[0]) throw new AnimusError('usage: animus draft <folder> [--repo <dir>]');
      const r = writeDraft({ ...deps(), folder: resolve(positionals[0]), cwd: resolve(values.repo ?? cwd) });
      console.log(JSON.stringify({ draft: join(resolve(positionals[0]), 'draft.md'), status: r.status, cost_usd: r.cost_usd }, null, 2));
      return 0;
    }
    case 'submit': {
      if (!positionals[0]) throw new AnimusError('usage: animus submit <spec.md>');
      await submitSpec(resolve(positionals[0]), resolve(values.repo ?? cwd), Boolean(values.draft));
      return 0;
    }
    case 'join':
      if (!positionals[0] || !positionals[1]) throw new AnimusError('usage: animus join <url> <code>');
      await joinHelix(positionals[0], positionals[1], cwd);
      return 0;
    case 'leave':
      console.log(await leaveHelix(Boolean(values.yes)));
      return 0;
    case 'github':
      if (positionals[0] !== 'login') throw new AnimusError('usage: animus github login');
      console.log(await githubLogin());
      return 0;
    case 'invite': {
      if (!positionals[0]) throw new AnimusError('usage: animus invite <name> [--github <login>] [--slack <member-id>]');
      const made = await helix.invite({ name: positionals[0], ...(values.github ? { github: values.github } : {}), ...(values.slack ? { slack: values.slack } : {}) });
      // A Helix with no url: in its config.yaml is reached where this machine reaches it.
      console.log(helix.describeInvite(made, made.url ?? helix.helixLogin()?.url, made.lan_url));
      return 0;
    }
    case 'remove-person':
      if (!positionals[0]) throw new AnimusError('usage: animus remove-person <name>');
      console.log(helix.describeRemoval(await helix.removePerson(positionals[0])));
      return 0;
    case 'project': {
      const [sub, name] = positionals;
      if (sub === 'list') { console.log(helix.describeProjects((await helix.projects()).projects)); return 0; }
      if (sub === 'remove') {
        if (!name) throw new AnimusError('usage: animus project remove <name>');
        await helix.removeProject(name);
        console.log(`${name} is off Helix`);
        return 0;
      }
      if (sub === 'add') {
        const p = await addProject(resolve(values.repo ?? cwd), { ...(name ? { name } : {}), say });
        if (p.state === 'ready') { console.log(`${p.name} is on Helix: animus submit <spec.md> from a checkout of it`); return 0; }
        console.log(`${p.name} was not taken: ${p.reason ?? 'its check failed'}`);
        if (p.provision) console.log(`${helix.describeProvision(p.provision)}: animus project list says how it goes`);
        return 1;
      }
      if (sub === 'secret') {
        const [, act, project, secret, extra] = positionals;
        const mine = values.mine === true;
        if (act === 'list' && project) { console.log(helix.describeSecrets(project, (await helix.secrets(project)).secrets)); return 0; }
        if (act === 'remove' && project && secret) {
          await helix.removeSecret(project, secret, mine);
          console.log(`${mine ? 'your own' : 'the shared'} ${secret} is off ${project}`);
          return 0;
        }
        if (act === 'set' && project && secret) {
          if (extra !== undefined) throw new AnimusError(`a secret's value is read from a prompt or stdin, never from an argument, which shell history and the process list keep: animus project secret set ${project} ${secret}, then type it or pipe it in`);
          let value = '';
          if (process.stdin.isTTY) value = await ask(`${secret}: `, true);
          else for await (const chunk of process.stdin) value += String(chunk);
          value = value.replace(/\r?\n$/, '');
          if (!value) throw new AnimusError(`no value for ${secret}: type it at the prompt or pipe it in`);
          const s = await helix.setSecret(project, secret, value, mine);
          console.log(`${s.name} is set for ${s.project}, ${s.mine ? 'your own value' : 'shared'}`);
          if (!s.masked) console.log(`${s.name} is too short to be masked: under 8 characters, it shows as it is in a job's log and pull request`);
          console.log('the model can read every secret a job gets: never keep a live or deploy credential as a project secret');
          return 0;
        }
        throw new AnimusError('usage: animus project secret set <project> <NAME> [--mine] | list <project> | remove <project> <NAME> [--mine]');
      }
      throw new AnimusError('usage: animus project add [<name>] | list | remove <name> | secret set|list|remove <project> [<NAME>]');
    }
    case 'status': {
      if (values.local && values.helix) throw new AnimusError('--local or --helix, not both');
      if (positionals[0]) {
        if (!onHelix()) return withQueue((queue) => { console.log(describeLocalJob(localJob(queue, positionals[0]!), logTail(Number(positionals[0])))); return 0; });
        console.log(helix.describeJob(await helix.job(positionals[0])));
        return 0;
      }
      // Both lists where both exist: this machine's queue, which says first what needs you, then Helix's.
      const parts: string[] = [];
      if (!values.helix && existsSync(queueFile())) {
        withQueue((queue) => {
          parts.push(...needsYou(queue), '');
          parts.push(describeLocalJobs(queue.list()));
          queue.markSeen(new Date().toISOString());
        });
      }
      if (!values.local && (values.helix || helix.helixLogin())) parts.push(...(parts.length ? ['', 'on Helix:'] : []), helix.describeJobs((await helix.jobs(Boolean(values.all))).jobs));
      console.log(parts.join('\n').trim() || 'no jobs');
      return 0;
    }
    case 'session-start': {
      // What the plugin's session-start hook runs: it reads the queue and prints what needs you, and starts nothing.
      try { if (existsSync(queueFile())) withQueue((queue) => { const lines = needsYou(queue); if (lines.length) console.log([...lines, 'animus status shows them all'].join('\n')); }); } catch { /* a session starts without it */ }
      return 0;
    }
    case 'result': {
      if (!positionals[0]) throw new AnimusError('usage: animus result <id>');
      const j = onHelix() ? await helix.job(positionals[0]) : withQueue((queue) => localJob(queue, positionals[0]!));
      const { id, state, title, repo, outcome, pr, reason, question, cost_usd, animus_job, waiting } = j;
      console.log(JSON.stringify({ id, state, title, repo, outcome, pr, reason, question, cost_usd, animus_job, waiting }, null, 2));
      return j.outcome === 'pr' ? 0 : 1;
    }
    case 'answer': {
      if (!positionals[0] || !positionals[1]) throw new AnimusError('usage: animus answer <id> <text>');
      const text = positionals.slice(1).join(' ');
      if (onHelix()) { const j = await helix.answer(positionals[0], text); console.log(`job ${j.id} is ${j.state} again with your answer`); return 0; }
      withQueue((queue) => {
        const j = answerLocal(queue, positionals[0]!, text);
        ensureLoop(queue);
        console.log(`job ${j.id} is ${j.state} again with your answer`);
      });
      return 0;
    }
    case 'cancel': {
      if (!positionals[0]) throw new AnimusError('usage: animus cancel <id>');
      const id = onHelix() ? (await helix.cancel(positionals[0])).id : withQueue((queue) => cancelLocal(queue, positionals[0]!).id);
      console.log(`job ${id} is cancelled`);
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
    case 'fix': {
      // What animus start <pr> and Helix launch to run a fix on this machine; not a command people type.
      const [pr, ...text] = positionals;
      if (!pr || !text.length) throw new AnimusError('usage: animus fix <pr> "<what to change>" [--repo <dir>] [--dry-run] [--keep]');
      return fixHere(mainCheckout(resolve(values.repo ?? cwd)), pr, text.join(' '));
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
    case 'tools': {
      const job = positionals[0];
      if (!job) throw new AnimusError('usage: animus tools <job> [--json]');
      const runs = readRuns().filter((r) => r.job === job);
      const lines = readTools(job);
      if (!runs.length && !lines.length) throw new AnimusError(`no run of job ${job} in the run log`);
      console.log(values.json ? lines.map((l) => JSON.stringify(l)).join('\n') : describeTools(runs.flatMap((r) => r.agents), lines));
      return 0;
    }
    case 'outcomes': {
      if (!onPath('gh')) say('gh is not installed: showing the outcomes as last read');
      const outcomes = refreshOutcomes(onPath('gh') ? prFacts : () => undefined);
      const rows = numbers(readRuns(), outcomes);
      console.log(values.json ? JSON.stringify({ numbers: rows, pull_requests: Object.values(outcomes) }, null, 2) : describeNumbers(rows));
      return 0;
    }
    case 'retro': {
      const days = values.days === undefined ? 7 : Number(values.days);
      if (!Number.isFinite(days) || days <= 0) throw new AnimusError(`--days takes a number of days, not ${values.days}`);
      const project = values.project ?? basename(mainCheckout(cwd));
      const { proposed, seen, result } = runRetro({ ...deps(), project, days });
      if (values.json) { console.log(JSON.stringify({ project, proposed: proposed.length, seen: seen.length, cost_usd: result.cost_usd })); return 0; }
      console.log(`${proposed.length} lesson${proposed.length === 1 ? '' : 's'} proposed for ${project}${seen.length ? `, ${seen.length} kept seen again` : ''} ($${result.cost_usd.toFixed(2)})${proposed.length ? ': animus lessons' : ''}`);
      return 0;
    }
    case 'lessons': {
      const [word, id] = positionals;
      const sub = word === 'accept' || word === 'dismiss' ? word : undefined;
      if (word && !sub) throw new AnimusError('usage: animus lessons [accept <id> | dismiss <id>]');
      if (sub && !/^\d+$/.test(id ?? '')) throw new AnimusError(`usage: animus lessons ${sub} <id>`);
      if (values.local && values.helix) throw new AnimusError('--local or --helix, not both');
      // As `animus start` decides: on Helix when this checkout's project is there, else on this machine. Outside a checkout, here.
      const asked: Where | undefined = values.local ? 'local' : values.helix ? 'helix' : undefined;
      const inCheckout = tryGit(cwd, ['rev-parse', '--git-dir']) !== undefined;
      const mine = inCheckout ? personalFor(cwd) : undefined;
      let unanswered = false;
      const choice: { where: Where; why: string; project?: string } = asked || inCheckout
        ? await whereToRun({ ...(asked ? { asked } : {}), ...(mine?.run ? { config: mine.run } : {}), checkout: cwd, projects: () => helix.projects().catch((err: unknown) => { unanswered = true; throw err; }) })
        : { where: 'local', why: 'this is not a checkout of a repository' };
      const remote = choice.where === 'helix';
      const where = remote ? 'on Helix' : 'on this machine';
      say(`lessons ${where}: ${choice.why}`);
      if (sub) {
        // Ids are numbered in each Animus home: a lesson kept here for lack of an answer from Helix could be another one.
        if (unanswered) throw new AnimusError(`${choice.why}, so lesson ${id} was not ${sub === 'accept' ? 'kept' : 'dismissed'} here: try again when Helix answers, or use --local for this machine's own lessons`);
        const l = remote ? await helix.decideLesson(Number(id), sub) : sub === 'accept' ? accept(Number(id), Date.now()) : dismiss(Number(id));
        console.log(`lesson ${l.id} is ${sub === 'accept' ? 'kept' : 'dismissed'} ${where}`);
        return 0;
      }
      console.log(describeLessons(remote ? (await helix.lessons(choice.project)).lessons : readLessons(), Date.now()));
      return 0;
    }
    case 'cleanup': {
      const days = values.days === undefined ? KEEP_DAYS : Number(values.days);
      if (!Number.isFinite(days) || days < 0) throw new AnimusError(`--days takes a number of days, not ${values.days}`);
      if (!onPath('gh')) throw new AnimusError('gh is not installed, so cleanup cannot tell which pull requests are finished');
      const dryRun = Boolean(values['dry-run']);
      const prEnd: PrEnd = (url, cwd) => {
        const f = prFacts(url, cwd);
        const ended = f?.mergedAt ?? f?.closedAt;
        return f ? { state: f.state, ...(ended ? { ended } : {}) } : undefined;
      };
      console.log(describeCleanup(cleanup({ jobs: positionals, days, dryRun }, prEnd), dryRun));
      return 0;
    }
    case 'check': case 'shots': case 'ui': {
      if (command === 'ui' && values.helix) {
        const login = helix.helixLogin();
        if (!login) throw new AnimusError('this machine has not joined a Helix: animus join <url> <code>, with a code from whoever runs it (or set HELIX_URL and HELIX_TOKEN)');
        const base = login.url.replace(/\/+$/, '');
        // The token goes only to the browser, which keeps it and takes it out of the address bar.
        openPage(`${base}/#token=${encodeURIComponent(login.token)}`);
        say(`Opening ${base} in your browser, signed in${login.name ? ` as ${login.name}` : ''}. If none opens, open ${base} and paste your Helix token from ${login.from}.`);
        return 0;
      }
      if (command === 'ui' && !positionals.length) {
        const server = localServer();
        gitIdentity();
        const { port, reused } = await claimLocal(server, LOCAL_PORT, (m) => console.error(m));
        const url = `http://127.0.0.1:${port}`;
        openPage(url);
        if (reused) { say(`The jobs this machine ran, at ${url} (already running).`); return 0; }
        say(`The jobs this machine ran, at ${url}. Press Ctrl-C to stop.`);
        // Whether each PR merged or closed comes from outcomes.json: read GitHub now and every ten minutes, in a process of its own so the display never waits on it.
        const outcomes = () => { if (onPath('gh')) spawn(process.execPath, [...process.execArgv, process.argv[1]!, 'outcomes'], { stdio: 'ignore' }).on('error', () => {}); };
        outcomes();
        const every = setInterval(outcomes, 10 * 60_000);
        server.once('close', () => clearInterval(every));
        // Listening keeps the process alive; Ctrl-C ends it cleanly.
        await new Promise<void>((done) => { process.once('SIGINT', () => { server.close(); done(); }); });
        return 0;
      }
      const root = git(cwd, ['rev-parse', '--show-toplevel']);
      const job = jobOf(root);
      const state = job ? loadState(job) : undefined;
      if (!state) throw new AnimusError(`animus ${command} runs inside a job's worktree, and this is not one`);
      const spec = loadSpec(state.spec);
      const profile = loadProfile(state.repo);
      useJobEnv(profile);
      if (command === 'check') {
        const files = [...new Set([...touchedFiles(root, state.workspace.base, 'HEAD'), ...git(root, ['ls-files', '--others', '--modified', '--exclude-standard']).split('\n').filter(Boolean)])];
        // Part-way through a job's slices, only the criteria of the slices so far are checked.
        const only = criteriaSoFar(state.slicing, state.slices_done?.length ?? 0);
        const results = runChecks(root, jobChecks(profile, state.plan, spec, { base: state.workspace.base, files }, only), state.job);
        if (state.plan.prove && !only) {
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
    case 'setup': {
      const io = terminalIo();
      return await setup(io, thisMachine(), cwd) ? 0 : 1;
    }
    case 'enable':
      return enable({ ask: async () => '', say, run: realRun }, resolve(positionals[0] ?? cwd)) ? 0 : 1;
    case 'doctor': {
      const found = await doctor(cwd);
      console.log(describeFindings(found));
      return found.some((f) => f.level === 'fail') ? 1 : 0;
    }
    case 'version':
      console.log(`${animusVersion()} (${factoryVersion()})`);
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
    console.error(`animus: ${maskSecrets(err.message)}`);
    process.exit(2);
  }
  throw err;
});
