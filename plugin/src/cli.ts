// The animus command.
import { readFileSync } from 'node:fs';
import { resolve } from 'node:path';
import { parseArgs } from 'node:util';
import { claudeAgent } from './agent.ts';
import { cleanup, describeCleanup, KEEP_DAYS, type PrEnd } from './cleanup.ts';
import { describeFindings, doctor } from './doctor.ts';
import { writeDraft } from './draft.ts';
import { enable, realRun, setup, terminalIo, thisMachine } from './setup.ts';
import { initProfile } from './init.ts';
import { githubLogin, joinHelix, leaveHelix, openPage } from './join.ts';
import { addProject } from './project.ts';
import { describe, failsOnBase, jobChecks, runChecks } from './gates.ts';
import { githubUrl, mainCheckout, touchedFiles } from './git.ts';
import { describeRuns, jobDir, loadState, readRuns, type Run } from './log.ts';
import { factoryVersion, jobOf, onPath, runJob, uiJobOf } from './pipeline.ts';
import { describeNumbers, numbers, refreshOutcomes } from './outcomes.ts';
import { prFacts, publish, pushEvidence } from './pr.ts';
import { personalFor, readSkillsFile, skillsForRole, snapshotSkills, whereToRun, type PersonalSkill, type Where } from './personal.ts';
import { listenLocal, localServer } from './local-display.ts';
import { loadProfile } from './profile.ts';
import { describePlan, loadFactory, resolvePlan } from './profiles.ts';
import { git, tryGit, AnimusError, GitError } from './proc.ts';
import * as helix from './remote.ts';
import { describeSkills, grantsFor } from './skills.ts';
import { criteriaSoFar, describeSlicing, planSlices } from './slices.ts';
import { loadSpec } from './spec.ts';
import { animusVersion } from './version.ts';
import { describeShots, takeShots, uiDown, uiTarget, uiUp } from './ui.ts';
import { basename, join } from 'node:path';

const USAGE = `animus: a spec goes in, a pull request with proof comes out

  animus start <spec.md> [--local | --helix] [--repo <dir>] [--draft]
        Start one job, here or on Helix. --local or --helix decides; without
        either, run: in ANIMUS_HOME/config.yaml does (the repository's entry,
        then the top); without that, Helix when this machine has joined one
        that has the repository, and here otherwise. Here, it is animus run
        and waits for the job; on Helix, it is animus submit and returns.
  animus run <spec.md> [--repo <dir>] [--dry-run] [--draft] [--keep]
        Run one job: set up a worktree, implement, gates, review, open the PR.
        --dry-run stops before the push; --draft opens the PR as a draft;
        --keep leaves the worktree.
        A spec with \`after: <spec.md>\` in its header waits until that spec's
        pull request is merged, then starts.
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
  animus outcomes [--json]
        What became of each pull request, read from GitHub (merged or closed,
        time to merge, human commits, reverted or reworked within 30 days),
        and the five numbers split by task class.
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
  animus submit <spec.md> [--repo <dir>] [--draft]
        Queue the spec there, for the project with this checkout's GitHub
        address (or, failing that, named after its folder), with your own
        skills from ANIMUS_HOME/config.yaml.
  animus status [<id>] [--all]
        Your jobs there, or one job with the end of its log. --all: every
        person's jobs, for the owner only.
  animus result <id>        One job as JSON; exits 0 once it ended in a pull request.
  animus answer <id> <text> Answer a job's question; it is queued again.
  animus cancel <id>        Your own job, or the owner cancels anyone's.
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
async function submitSpec(file: string, checkout: string, draft: boolean, known?: string): Promise<helix.RemoteJob> {
  // Refused here, before it is sent, when its labels would not run.
  resolvePlan(loadFactory(), loadSpec(file));
  const root = mainCheckout(checkout);
  let repo = known;
  if (!repo) {
    // The project with this checkout's GitHub address, whatever it was named when added; else one named after the folder.
    const url = githubUrl(tryGit(root, ['remote', 'get-url', 'origin']) ?? '');
    // A Helix from before projects has no list to ask.
    const list = url ? await helix.projects().then((r) => r.projects, () => []) : [];
    repo = list.find((p) => p.url === url)?.name ?? basename(root);
  }
  const skills = snapshotSkills(personalFor(root).skills);
  const j = await helix.submit({ repo, spec: readFileSync(file, 'utf8'), name: basename(file), ...(draft ? { draft: true } : {}), ...(skills.length ? { skills: skills.map(({ sha: _sha, ...s }) => s) } : {}) });
  if (skills.length && !j.skills) say(`this Helix predates personal skills: the job runs without ${skills.map((s) => s.name).join(', ')}`);
  console.log(`job ${j.id} is ${j.state} on Helix: ${j.title}${j.skills?.length ? `\nwith your skills: ${j.skills.join(', ')}` : ''}\nfollow it with: animus status ${j.id}`);
  return j;
}


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
      json: { type: 'boolean' }, skills: { type: 'string' }, local: { type: 'boolean' }, helix: { type: 'boolean' }, n: { type: 'string', short: 'n' }, again: { type: 'boolean' }, days: { type: 'string' }, force: { type: 'boolean' }, slices: { type: 'boolean' }, yes: { type: 'boolean' }, github: { type: 'string' }, slack: { type: 'string' }, all: { type: 'boolean' },
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
      const personal = localSkills(repo, values.skills);
      return finish(await runJob({ repo, specFile, personal, ...flags, ...(process.env.ANIMUS_TRIGGER ? { trigger: process.env.ANIMUS_TRIGGER } : {}) }, deps()));
    }
    case 'start': {
      if (!positionals[0]) throw new AnimusError('usage: animus start <spec.md> [--local | --helix] [--draft]');
      if (values.local && values.helix) throw new AnimusError('--local or --helix, not both');
      const specFile = resolve(positionals[0]);
      const repo = resolve(values.repo ?? cwd);
      const asked: Where | undefined = values.local ? 'local' : values.helix ? 'helix' : undefined;
      const mine = personalFor(repo);
      const choice = await whereToRun({ ...(asked ? { asked } : {}), ...(mine.run ? { config: mine.run } : {}), checkout: repo });
      say(`this job runs ${choice.where === 'helix' ? 'on Helix' : 'on this machine'}: ${choice.why}`);
      if (choice.where === 'helix') {
        if (values['dry-run']) throw new AnimusError('--dry-run is for a job on this machine: animus start --local --dry-run');
        await submitSpec(specFile, repo, Boolean(values.draft), choice.project);
        return 0;
      }
      if (!values['dry-run'] && !onPath('gh')) throw new AnimusError('gh is not installed, so no pull request can be opened; install it or use --dry-run');
      return finish(await runJob({ repo, specFile, personal: snapshotSkills(mine.skills), ...flags }, deps()));
    }
    case 'plan': {
      if (!positionals[0]) throw new AnimusError('usage: animus plan <spec.md>');
      const spec = loadSpec(resolve(positionals[0]));
      const factory = loadFactory();
      const plan = resolvePlan(factory, spec);
      console.log(`${spec.title}\n${describePlan(factory, plan)}`);
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
        return 1;
      }
      throw new AnimusError('usage: animus project add [<name>] | list | remove <name>');
    }
    case 'status':
      console.log(positionals[0] ? helix.describeJob(await helix.job(positionals[0])) : helix.describeJobs((await helix.jobs(Boolean(values.all))).jobs));
      return 0;
    case 'result': {
      if (!positionals[0]) throw new AnimusError('usage: animus result <id>');
      const { log: _log, ...j } = await helix.job(positionals[0]);
      console.log(JSON.stringify(j, null, 2));
      return j.outcome === 'pr' ? 0 : 1;
    }
    case 'answer': {
      if (!positionals[0] || !positionals[1]) throw new AnimusError('usage: animus answer <id> <text>');
      const j = await helix.answer(positionals[0], positionals.slice(1).join(' '));
      console.log(`job ${j.id} is ${j.state} again with your answer`);
      return 0;
    }
    case 'cancel': {
      if (!positionals[0]) throw new AnimusError('usage: animus cancel <id>');
      const j = await helix.cancel(positionals[0]);
      console.log(`job ${j.id} is cancelled`);
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
        const url = `http://127.0.0.1:${await listenLocal(server, LOCAL_PORT)}`;
        openPage(url);
        say(`The jobs this machine ran, at ${url}. Press Ctrl-C to stop.`);
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
    console.error(`animus: ${err.message}`);
    process.exit(2);
  }
  throw err;
});
