// Helix's HTTP API: six actions on jobs (submit, fix, status, result, cancel,
// answer) and three on projects (add, list, remove), over JSON, for the
// private network only. Each of those carries a person's token; the queue
// lists a person's own jobs, a job can be answered only by whoever submitted
// it and cancelled by them or the owner, and a project removed only by whoever
// added it or the owner (projects.ts).
// Joining (invite, join/device, join) carries a one-time code instead, and leave the
// person's own token (join.ts). Inviting and removing people (POST /people,
// DELETE /people/<name>) and every person's queue (GET /jobs?all) are the
// owner's alone (owner.ts).
// It also serves the display: its pages at / and /jobs/<id> (ui.ts), what the
// overview shows at /display, and a job page's data and screenshots, with a
// token, at /jobs/<id>/page-data and /jobs/<id>/shots/<name>, and the people
// list's at /people/page-data and a person's at /people/<name>/page-data.
import { createServer, type IncomingMessage, type Server } from 'node:http';
import { AnimusError } from '../../plugin/src/proc.ts';
import { VERSION_HEADER, type MadeInvite, type RemovedPerson } from '../../plugin/src/remote.ts';
import { animusVersion, compatible } from '../../plugin/src/version.ts';
import { parseSkills, type PersonalSkill } from '../../plugin/src/personal.ts';
import { hashToken, helixHome, type Config } from './config.ts';
import { RESULTS, type Result } from '../../plugin/display/job-list.ts';
import { display, jobList, jobPage, jobShot, peoplePage, personPage } from './display.ts';
import { refusedWith, type AdmitSubmission } from './admit.ts';
import { freshToken } from './github-app.ts';
import { invite, inviteDetails, joinHelix, loginDevice, relogin, startDevice, StillWaiting, takeOff, verifyInChild, type JoinGitHub, type Verify } from './join.ts';
import { openPrs, type ListPrs } from './open-prs.ts';
import { isOwner, requireOwner } from './owner.ts';
import { addProject, checkInChild, projectView, removeProject, type StartCheck } from './projects.ts';
import type { Transport } from './slack-api.ts';
import { jobLinks, slackInvite } from './slack.ts';
import type { Store } from './store.ts';
import { Refused, type Submission, type Supervisor } from './supervisor.ts';
import { asset, CSP } from '../../plugin/src/assets.ts';

const MAX_BODY = 1024 * 1024;

/** Who holds the request's token. Only its hash is looked up: a token is long and random, so the lookup's timing gives nothing away. */
function whoIs(store: Store, req: IncomingMessage): string | undefined {
  const token = /^Bearer (.+)$/.exec(req.headers.authorization ?? '')?.[1];
  return token ? store.personByToken(hashToken(token)) : undefined;
}

async function body(req: IncomingMessage): Promise<Record<string, unknown>> {
  let text = '';
  for await (const chunk of req) {
    text += (chunk as Buffer).toString();
    if (text.length > MAX_BODY) throw new Refused(413, 'the request is over 1 MB');
  }
  try {
    const parsed = JSON.parse(text || '{}') as unknown;
    if (typeof parsed === 'object' && parsed !== null && !Array.isArray(parsed)) return parsed as Record<string, unknown>;
  } catch { /* falls through */ }
  throw new Refused(400, 'the request body must be a JSON object');
}

export function serve(opts: {
  config: Config; store: Store; supervisor: Supervisor;
  /** How a joining person's tokens are tried; by default in a `helix verify` process. */
  verify?: Verify;
  /** Ends what a job leaves outside its process tree (its container), for a person who leaves. */
  reap?: (id: number) => void;
  /** How a project someone adds is checked; by default in a `helix check-project` process. */
  startCheck?: StartCheck;
  /** Helix's home: where projects' clones and checks go. */
  home?: string;
  /** The Slack bot, when it runs: how the owner's animus invite --slack is sent. */
  slack?: Pick<Transport, 'dm' | 'post'>;
  /** Admits a submitted spec against its project's base branch on GitHub (admit.ts); without it a spec is queued unchecked, as in tests. */
  admit?: AdmitSubmission;
  /** How a project's open PRs are listed on GitHub, with a person's token; by default GitHub's API. */
  listPrs?: ListPrs;
  /** Lists a project's closed PRs; tests pass a fake. */
  listClosedPrs?: ListPrs;
  /** Where joining with config.yaml's GitHub App reaches GitHub, and its pace; by default GitHub itself. */
  github?: Omit<JoinGitHub, 'clientId'>;
}): Server {
  const { config, store, supervisor } = opts;
  // Read at each join: config.yaml read again after helix github setup counts at once.
  const app = (): JoinGitHub | undefined => (config.github ? { clientId: config.github.client_id, ...opts.github } : undefined);
  const verify = opts.verify ?? verifyInChild;
  const home = opts.home ?? helixHome();
  const startCheck = opts.startCheck ?? checkInChild(store, home);
  const version = animusVersion();
  /** `animus invite`: what helix invite does on the machine, the Slack DM through this Helix's own bot. */
  const invitePerson = async (b: Record<string, unknown>): Promise<MadeInvite> => {
    const { name, github, slack } = b;
    if (typeof name !== 'string') throw new Refused(400, 'name is who the invite is for');
    if ((github !== undefined && typeof github !== 'string') || (slack !== undefined && typeof slack !== 'string')) throw new Refused(400, 'github and slack are text');
    const who = { ...(github ? { github } : {}), ...(slack ? { slack } : {}) };
    try {
      if (!slack) return { name, ...invite(store, name, who), ...(config.url ? { url: config.url } : {}), ...(config.lan_url ? { lan_url: config.lan_url } : {}) };
      if (!opts.slack) throw new Refused(409, 'the Slack bot is not running on this Helix: helix slack setup on the machine, then restart helix serve');
      const { expires } = await slackInvite(opts.slack, { store, config }, name, { ...who, slack });
      return { name, expires, slack };
    } catch (err) {
      // A bad name, or no url for the join line: the owner's to fix, not Helix's failure.
      if (err instanceof AnimusError && !(err instanceof Refused)) throw new Refused(400, err.message);
      throw err;
    }
  };
  const prs = openPrs({ store, fresh: (person) => freshToken(store, config, person, opts.github?.urls), ...(opts.listPrs ? { list: opts.listPrs } : {}), ...(opts.listClosedPrs ? { listClosed: opts.listClosedPrs } : {}) });
  return createServer((req, res) => {
    const send = (status: number, value: unknown) => {
      res.writeHead(status, { 'content-type': 'application/json', 'helix-version': version });
      res.end(`${JSON.stringify(value)}\n`);
    };
    void (async () => {
      const url = new URL(req.url ?? '/', 'http://helix');
      // The display's page, scripts and fonts need no token.
      const file = req.method === 'GET' ? asset(url.pathname, req.headers.accept) : undefined;
      if (file) {
        // vary: a job's path is its page to a browser and JSON to animus, so neither answer stands in for the other.
        res.writeHead(200, { 'content-type': file.type, 'cache-control': file.cache, 'content-security-policy': CSP, 'x-content-type-options': 'nosniff', vary: 'accept' });
        return res.end(file.body);
      }
      // What the display shows needs no token either: Helix listens on a private network only, and this only reads.
      if (req.method === 'GET' && url.pathname === '/display') return send(200, { ...display(opts), prs: await prs(), closed: await prs.closed() });
      // Which release this is, for `animus doctor`; it says no more than the display does.
      if (req.method === 'GET' && url.pathname === '/version') return send(200, { version });
      // A client from a release this one cannot work with is told how to catch up, before anything is done for it.
      const theirs = req.headers[VERSION_HEADER];
      const outdated = () => send(426, { error: `this Helix runs Animus ${version} and your animus is ${typeof theirs === 'string' ? theirs : 'from before versioned releases'}. Update the animus plugin in Claude Code (/plugin), or pull your clone of it, then try again` });
      const current = typeof theirs === 'string' && compatible(theirs, version);
      // Someone joining has a code and no token yet.
      if (req.method === 'POST' && (url.pathname === '/invite' || url.pathname === '/join' || url.pathname === '/join/device')) {
        if (!current) return outdated();
        const b = await body(req);
        const github = app();
        // github_app: the client signs the person in with GitHub instead of asking for a token.
        if (url.pathname === '/invite') return send(200, { ...inviteDetails(store, b.code), ...(github ? { github_app: true } : {}) });
        if (url.pathname === '/join/device') return send(200, await startDevice(store, github, b.code));
        return send(201, await joinHelix({ store, verify, ...(github ? { github } : {}) }, b));
      }
      const person = whoIs(store, req);
      if (!person) return send(401, { error: 'a valid token is needed: Authorization: Bearer <token>' });
      // A job page's data, for any person on this Helix. The display is served by this Helix, so it sends no client version.
      const pageData = req.method === 'GET' ? /^\/jobs\/(\d+)\/page-data$/.exec(url.pathname)?.[1] : undefined;
      if (pageData) {
        const page = jobPage(opts, Number(pageData), { prs: await prs(), closed: await prs.closed() });
        return page ? send(200, page) : send(404, { error: `no job ${pageData}` });
      }
      // The Jobs page's data: every job in the table, filtered, thirty older than ?before=<submitted> at a time. A separate path, so it is not read as a job id.
      if (req.method === 'GET' && url.pathname === '/job-list') {
        const q = url.searchParams;
        const result = q.get('result') ?? 'all';
        if (!RESULTS.includes(result as Result)) throw new Refused(400, `result is one of ${RESULTS.join(', ')}`);
        return send(200, jobList(opts, { result: result as Result, project: q.get('project') ?? '', person: q.get('person') ?? '' }, q.get('before') ?? undefined, { prs: await prs(), closed: await prs.closed() }));
      }
      // The people list's data, for any person on this Helix.
      if (req.method === 'GET' && url.pathname === '/people/page-data') return send(200, peoplePage(opts));
      // One person's page, with the jobs older than ?before=<job id>: thirty at a time.
      const who = req.method === 'GET' ? /^\/people\/([^/]+)\/page-data$/.exec(url.pathname)?.[1] : undefined;
      if (who) {
        let name: string | undefined;
        try { name = decodeURIComponent(who); } catch { /* does not decode: no such person */ }
        const before = Number(url.searchParams.get('before') ?? Infinity);
        const page = name === undefined || Number.isNaN(before) ? undefined : personPage(opts, name, before);
        return page ? send(200, page) : send(404, { error: `no person ${name ?? who}` });
      }
      // One of a job's screenshots, for its page: the name is as its shots folder lists it, and only such a name is served.
      const shot = req.method === 'GET' ? /^\/jobs\/(\d+)\/shots\/(.+)$/.exec(url.pathname) : undefined;
      if (shot) {
        let name: string | undefined;
        try { name = decodeURIComponent(shot[2]!); } catch { /* does not decode: no such screenshot */ }
        const image = name === undefined ? undefined : jobShot(opts, Number(shot[1]), name);
        if (!image) return send(404, { error: `no such screenshot of job ${shot[1]}` });
        res.writeHead(200, { 'content-type': image.type, 'cache-control': 'private, no-cache', 'x-content-type-options': 'nosniff', 'helix-version': version });
        return res.end(image.body);
      }
      if (!current) return outdated();
      if (req.method === 'POST' && url.pathname === '/people') {
        requireOwner(config, person, 'invite people');
        return send(201, await invitePerson(await body(req)));
      }
      // animus github login: a new sign-in with Helix's GitHub App, as the person they already are.
      if (req.method === 'POST' && url.pathname === '/github/device') return send(200, await loginDevice(app()));
      if (req.method === 'POST' && url.pathname === '/github/login') return send(200, await relogin(store, app(), person, await body(req)));
      if (req.method === 'POST' && url.pathname === '/leave') {
        const { cancelled, kept } = takeOff(person, store, config, opts.reap);
        return send(200, { name: person, cancelled: cancelled.map((j) => j.id), ...(kept ? { kept } : {}) });
      }
      const [, root, id, action] = url.pathname.split('/');
      if (root === 'people' && id && !action && req.method === 'DELETE') {
        requireOwner(config, person, 'remove people');
        const name = decodeURIComponent(id);
        if (!store.person(name)) throw new Refused(404, `Helix has no person named ${name}`);
        const { cancelled, ...gone } = takeOff(name, store, config, opts.reap);
        return send(200, { name, cancelled: cancelled.map((j) => j.id), ...gone, home } satisfies RemovedPerson);
      }
      if (root === 'projects') {
        const name = id ? decodeURIComponent(id) : undefined;
        if (!name && req.method === 'GET') return send(200, { projects: store.projects().map(({ dir: _dir, ...p }) => p) });
        if (!name && req.method === 'POST') { const { dir: _dir, ...p } = addProject({ store, home, startCheck }, person, await body(req)); return send(202, p); }
        if (name && !action && req.method === 'GET') { const { dir: _dir, ...p } = projectView(store, home, name); return send(200, p); }
        if (name && !action && req.method === 'DELETE') { const { dir: _dir, ...p } = removeProject({ store, home, config }, person, name); return send(200, p); }
        return send(404, { error: `nothing at ${req.method} ${url.pathname}` });
      }
      if (root !== 'jobs') return send(404, { error: `nothing at ${url.pathname}` });
      if (!id) {
        if (req.method === 'GET') {
          if (url.searchParams.has('all')) requireOwner(config, person, 'see every job');
          return send(200, { slots: config.slots, jobs: url.searchParams.has('all') ? store.list() : store.list().filter((j) => j.person === person) });
        }
        if (req.method === 'POST') {
          const b = await body(req);
          if (typeof b.repo !== 'string' || typeof b.spec !== 'string') throw new Refused(400, 'a submission needs repo (its name here) and spec (the file\'s text)');
          let skills: PersonalSkill[];
          try { skills = parseSkills(b.skills, 'the submission'); } catch (err) { throw new Refused(400, (err as Error).message); }
          const s: Submission = { repo: b.repo, spec: b.spec, ...(typeof b.name === 'string' ? { name: b.name } : {}), ...(b.draft === true ? { draft: true } : {}), ...(skills.length ? { skills } : {}) };
          // Admitted against the project as GitHub has it: the person gets the whole list now, not a failed job later (docs/adr/0007).
          let warnings: string[] = [];
          if (opts.admit) {
            const name = typeof b.name === 'string' ? b.name : 'spec.md';
            try {
              const read = await opts.admit(person, b.repo, b.spec, name, typeof b.profile === 'string' ? b.profile : undefined);
              const refused = refusedWith(name, read);
              if (refused) throw new Refused(400, refused);
              warnings = read.warnings;
            } catch (err) {
              if (err instanceof AnimusError && !(err instanceof Refused)) throw new Refused(400, err.message);
              throw err;
            }
          }
          // The skills it took, so a client can tell them from a Helix that predates them.
          const submitted = supervisor.submit(person, s);
          return send(201, { ...submitted, skills: skills.map((k) => k.name), links: jobLinks(config, submitted.id), ...(warnings.length ? { warnings } : {}) });
        }
      } else if (id === 'fix' && !action && req.method === 'POST') {
        const b = await body(req);
        if (typeof b.repo !== 'string' || typeof b.pr !== 'string' || !b.pr.trim() || typeof b.ask !== 'string' || !b.ask.trim()) throw new Refused(400, 'a fix needs repo (its name here), pr (a number or its address) and ask (what to change)');
        let skills: PersonalSkill[];
        try { skills = parseSkills(b.skills, 'the fix'); } catch (err) { throw new Refused(400, (err as Error).message); }
        const queued = supervisor.fix(person, { repo: b.repo, pr: b.pr, ask: b.ask, ...(skills.length ? { skills } : {}) });
        return send(201, { ...queued, skills: skills.map((k) => k.name), links: jobLinks(config, queued.id) });
      } else if (/^\d+$/.test(id)) {
        const n = Number(id);
        if (req.method === 'GET' && !action) {
          const job = store.get(n);
          return job ? send(200, { ...job, log: supervisor.log(n), links: jobLinks(config, n) }) : send(404, { error: `no job ${n}` });
        }
        // The owner cancels anyone's job as if it were theirs, as the Slack owner's Cancel button does.
        if (req.method === 'POST' && action === 'cancel') return send(200, supervisor.cancel(isOwner(config, person) ? (store.get(n)?.person ?? person) : person, n));
        if (req.method === 'POST' && action === 'answer') {
          const b = await body(req);
          if (typeof b.answer !== 'string' || !b.answer.trim()) throw new Refused(400, 'answer must be text');
          return send(200, supervisor.answer(person, n, b.answer));
        }
      }
      return send(404, { error: `nothing at ${req.method} ${url.pathname}` });
    })().catch((err: unknown) => {
      if (err instanceof Refused) return send(err.status, { error: err.message });
      if (err instanceof StillWaiting) return send(202, { pending: true });
      console.error(err);
      return send(500, { error: 'Helix failed on this request; see its own output' });
    });
  });
}
