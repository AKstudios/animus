// Helix's HTTP API: five actions (submit, status, result, cancel, answer)
// over JSON, for the private network only. Every request carries a person's
// token; a job can be cancelled or answered only by whoever submitted it.
// It also serves the display: its page at /, and what it shows at /display.
import { timingSafeEqual } from 'node:crypto';
import { createServer, type IncomingMessage, type Server } from 'node:http';
import { hashToken, type Config } from './config.ts';
import { display } from './display.ts';
import type { Store } from './store.ts';
import { Refused, type Submission, type Supervisor } from './supervisor.ts';
import { asset } from './ui.ts';

const MAX_BODY = 1024 * 1024;
/** The display loads only what Helix serves and talks only to Helix. */
const CSP = "default-src 'none'; script-src 'self'; style-src 'self'; font-src 'self'; img-src 'self' data:; connect-src 'self'; base-uri 'none'; form-action 'none'";

function whoIs(config: Config, req: IncomingMessage): string | undefined {
  const token = /^Bearer (.+)$/.exec(req.headers.authorization ?? '')?.[1];
  if (!token) return undefined;
  const given = Buffer.from(hashToken(token));
  return Object.entries(config.people).find(([, p]) => {
    const known = Buffer.from(String(p.token_sha256));
    return known.length === given.length && timingSafeEqual(known, given);
  })?.[0];
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

export function serve(opts: { config: Config; store: Store; supervisor: Supervisor }): Server {
  const { config, store, supervisor } = opts;
  return createServer((req, res) => {
    const send = (status: number, value: unknown) => {
      res.writeHead(status, { 'content-type': 'application/json' });
      res.end(`${JSON.stringify(value)}\n`);
    };
    void (async () => {
      const url = new URL(req.url ?? '/', 'http://helix');
      // The display's page, scripts and fonts need no token: they hold nothing until one is given.
      const file = req.method === 'GET' ? asset(url.pathname) : undefined;
      if (file) {
        res.writeHead(200, { 'content-type': file.type, 'cache-control': file.cache, 'content-security-policy': CSP, 'x-content-type-options': 'nosniff' });
        return res.end(file.body);
      }
      const person = whoIs(config, req);
      if (!person) return send(401, { error: 'a valid token is needed: Authorization: Bearer <token>' });
      const [, root, id, action] = url.pathname.split('/');
      if (root === 'display' && !id && req.method === 'GET') return send(200, display(opts));
      if (root !== 'jobs') return send(404, { error: `nothing at ${url.pathname}` });
      if (!id) {
        if (req.method === 'GET') return send(200, { slots: config.slots, jobs: store.list() });
        if (req.method === 'POST') {
          const b = await body(req);
          if (typeof b.repo !== 'string' || typeof b.spec !== 'string') throw new Refused(400, 'a submission needs repo (its name here) and spec (the file\'s text)');
          const s: Submission = { repo: b.repo, spec: b.spec, ...(typeof b.name === 'string' ? { name: b.name } : {}), ...(b.draft === true ? { draft: true } : {}) };
          return send(201, supervisor.submit(person, s));
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
