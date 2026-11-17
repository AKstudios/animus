// Helix's HTTP API: five actions on jobs (submit, status, result, cancel,
// answer) and three on projects (add, list, remove), over JSON, for the
// private network only. Each of those carries a person's token; a job can be
// cancelled or answered only by whoever submitted it, and a project removed
// only by whoever added it (projects.ts).
// Joining (invite, join) carries a one-time code instead, and leave the
// person's own token (join.ts).
// It also serves the display: its pages at / and /jobs/<id> (ui.ts), what the
// overview shows at /display, and a job page's data and screenshots, with a
// token, at /jobs/<id>/page-data and /jobs/<id>/shots/<name>.
import { createServer, type IncomingMessage, type Server } from 'node:http';
import { VERSION_HEADER } from '../../plugin/src/remote.ts';
import { animusVersion, compatible } from '../../plugin/src/version.ts';
import { parseSkills, type PersonalSkill } from '../../plugin/src/personal.ts';
import { hashToken, helixHome, type Config } from './config.ts';
import { display, jobPage, jobShot } from './display.ts';
import { inviteDetails, joinHelix, takeOff, verifyInChild, type Verify } from './join.ts';
import { openPrs, type ListPrs } from './open-prs.ts';
import { addProject, checkInChild, projectView, removeProject, type StartCheck } from './projects.ts';
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
  /** How a project's open PRs are listed on GitHub, with a person's token; by default GitHub's API. */
  listPrs?: ListPrs;
}): Server {
  const { config, store, supervisor } = opts;
  const verify = opts.verify ?? verifyInChild;
  const home = opts.home ?? helixHome();
  const startCheck = opts.startCheck ?? checkInChild(store, home);
  const version = animusVersion();
  const prs = openPrs({ store, ...(opts.listPrs ? { list: opts.listPrs } : {}) });
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
      if (req.method === 'GET' && url.pathname === '/display') return send(200, { ...display(opts), prs: await prs() });
      // Which release this is, for `animus doctor`; it says no more than the display does.
      if (req.method === 'GET' && url.pathname === '/version') return send(200, { version });
      // A client from a release this one cannot work with is told how to catch up, before anything is done for it.
      const theirs = req.headers[VERSION_HEADER];
      const outdated = () => send(426, { error: `this Helix runs Animus ${version} and your animus is ${typeof theirs === 'string' ? theirs : 'from before versioned releases'}. Update the animus plugin in Claude Code (/plugin), or pull your clone of it, then try again` });
      const current = typeof theirs === 'string' && compatible(theirs, version);
      // Someone joining has a code and no token yet.
      if (req.method === 'POST' && (url.pathname === '/invite' || url.pathname === '/join')) {
        if (!current) return outdated();
        const b = await body(req);
        return url.pathname === '/invite' ? send(200, inviteDetails(store, b.code)) : send(201, await joinHelix({ store, verify }, b));
      }
      const person = whoIs(store, req);
      if (!person) return send(401, { error: 'a valid token is needed: Authorization: Bearer <token>' });
      // A job page's data, for any person on this Helix. The display is served by this Helix, so it sends no client version.
      const pageData = req.method === 'GET' ? /^\/jobs\/(\d+)\/page-data$/.exec(url.pathname)?.[1] : undefined;
      if (pageData) {
        const page = jobPage(opts, Number(pageData));
        return page ? send(200, page) : send(404, { error: `no job ${pageData}` });
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
      if (req.method === 'POST' && url.pathname === '/leave') {
        const { cancelled, kept } = takeOff(person, store, opts.reap);
        return send(200, { name: person, cancelled: cancelled.map((j) => j.id), ...(kept ? { kept } : {}) });
      }
      const [, root, id, action] = url.pathname.split('/');
      if (root === 'projects') {
        const name = id ? decodeURIComponent(id) : undefined;
        if (!name && req.method === 'GET') return send(200, { projects: store.projects().map(({ dir: _dir, ...p }) => p) });
        if (!name && req.method === 'POST') { const { dir: _dir, ...p } = addProject({ store, home, startCheck }, person, await body(req)); return send(202, p); }
        if (name && !action && req.method === 'GET') { const { dir: _dir, ...p } = projectView(store, home, name); return send(200, p); }
        if (name && !action && req.method === 'DELETE') { const { dir: _dir, ...p } = removeProject({ store, home }, person, name); return send(200, p); }
        return send(404, { error: `nothing at ${req.method} ${url.pathname}` });
      }
      if (root !== 'jobs') return send(404, { error: `nothing at ${url.pathname}` });
      if (!id) {
        if (req.method === 'GET') return send(200, { slots: config.slots, jobs: store.list() });
        if (req.method === 'POST') {
          const b = await body(req);
          if (typeof b.repo !== 'string' || typeof b.spec !== 'string') throw new Refused(400, 'a submission needs repo (its name here) and spec (the file\'s text)');
          let skills: PersonalSkill[];
          try { skills = parseSkills(b.skills, 'the submission'); } catch (err) { throw new Refused(400, (err as Error).message); }
          const s: Submission = { repo: b.repo, spec: b.spec, ...(typeof b.name === 'string' ? { name: b.name } : {}), ...(b.draft === true ? { draft: true } : {}), ...(skills.length ? { skills } : {}) };
          // The skills it took, so a client can tell them from a Helix that predates them.
          return send(201, { ...supervisor.submit(person, s), skills: skills.map((k) => k.name) });
        }
      } else if (/^\d+$/.test(id)) {
        const n = Number(id);
        if (req.method === 'GET' && !action) {
          const job = store.get(n);
          return job ? send(200, { ...job, log: supervisor.log(n) }) : send(404, { error: `no job ${n}` });
        }
        if (req.method === 'POST' && action === 'cancel') return send(200, supervisor.cancel(person, n));
        if (req.method === 'POST' && action === 'answer') {
          const b = await body(req);
          if (typeof b.answer !== 'string' || !b.answer.trim()) throw new Refused(400, 'answer must be text');
          return send(200, supervisor.answer(person, n, b.answer));
        }
      }
      return send(404, { error: `nothing at ${req.method} ${url.pathname}` });
    })().catch((err: unknown) => {
      if (err instanceof Refused) return send(err.status, { error: err.message });
      console.error(err);
      return send(500, { error: 'Helix failed on this request; see its own output' });
    });
  });
}
