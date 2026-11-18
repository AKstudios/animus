// A fake GitHub for Helix's GitHub App: the device flow and token endpoints
// (github.com/login/...) and the few API routes Helix reads (the user, their
// installations and each one's repositories), on one local server. Its
// answers, errors included, are shaped as GitHub's. No test talks to GitHub.
import { createServer } from 'node:http';
import type { AddressInfo } from 'node:net';
import type { GitHubUrls } from '../src/github-app.ts';

export type FakeGitHub = GitHubUrls & {
  /** Every request, as `<METHOD> <path>`. */
  calls: string[];
  /** The person with this user code approves it on github.com/login/device, as this login. */
  approve(userCode: string, login: string): void;
  /** The person cancels at github.com/login/device. */
  deny(userCode: string): void;
  /** An access token's eight hours are up: the API answers 401 for it; its refresh token still works. */
  expire(accessToken: string): void;
  /** How many polls to answer with slow_down before anything else. */
  slowDowns: number;
  /** The repositories the app is installed on, by owner. */
  installed: Record<string, string[]>;
  /** Each installation's permissions, by owner; one left out has contents and pull requests write. */
  permissions: Record<string, Record<string, string>>;
  /** The repositories (owner/name) each login has access to; a login left out has access to every installed one. */
  access: Record<string, string[]>;
  /** An issue (or pull request) on owner/name, as the issue and comment routes serve it. */
  addIssue(repo: string, number: number, issue: { title: string; body: string; pull?: boolean }): void;
  /** A comment by a login on an issue; created defaults to now. updated is when it was last edited, by default created. Returns its id. */
  addComment(repo: string, number: number, login: string, body: string, created?: string): number;
  /** The login edits a comment: its update time, which `since` goes by, moves to at (default now). */
  edit(id: number, at?: string): void;
  /** Every comment, including those the API was asked to post. */
  comments: { id: number; repo: string; number: number; login: string; body: string; created_at: string; updated_at: string }[];
  /** The comments and reactions posted through the API, as the token's login. */
  posted: { repo: string; number: number; login: string; body: string }[];
  reactions: { repo: string; comment: number; login: string; content: string }[];
  close(): Promise<void>;
};

type Device = { code: string; user: string; state: 'pending' | 'approved' | 'denied' | 'used'; login?: string };

/** clientId is the app's, with the device flow on unless deviceFlow is false. */
export async function fakeGitHub(opts: { clientId?: string; deviceFlow?: boolean } = {}): Promise<FakeGitHub> {
  const clientId = opts.clientId ?? 'Iv23liGood';
  const devices: Device[] = [];
  // Tokens to the login they act for.
  const access = new Map<string, string>();
  const refresh = new Map<string, string>();
  let issued = 0;
  const issue = (login: string) => {
    issued += 1;
    access.set(`ghu_${issued}`, login);
    refresh.set(`ghr_${issued}`, login);
    return { access_token: `ghu_${issued}`, expires_in: 28800, refresh_token: `ghr_${issued}`, refresh_token_expires_in: 15811200, token_type: 'bearer', scope: '' };
  };
  const ids: Record<string, number> = {};
  const issues = new Map<string, { title: string; body: string; pull?: boolean }>();
  const second = () => `${new Date().toISOString().slice(0, 19)}Z`;
  const fake: FakeGitHub = {
    web: '', api: '', calls: [], slowDowns: 0, installed: {}, access: {}, permissions: {},
    comments: [], posted: [], reactions: [],
    addIssue: (repo, number, issue) => { issues.set(`${repo}#${number}`, issue); },
    addComment(repo, number, login, body, created = second()) {
      const id = fake.comments.length + 1;
      fake.comments.push({ id, repo, number, login, body, created_at: created, updated_at: created });
      return id;
    },
    edit(id, at = second()) { fake.comments.find((c) => c.id === id)!.updated_at = at; },
    approve: (userCode, login) => Object.assign(devices.find((d) => d.user === userCode)!, { state: 'approved', login }),
    deny: (userCode) => { devices.find((d) => d.user === userCode)!.state = 'denied'; },
    expire: (accessToken) => { access.delete(accessToken); },
    close: () => new Promise((r) => { server.close(() => r()); }),
  };
  const reaches = (login: string, owner: string, repo: string) => !fake.access[login] || fake.access[login]!.includes(`${owner}/${repo}`);
  const installations = (login: string) => Object.entries(fake.installed)
    .map(([owner, repos], i) => ({ id: i + 1, owner, repos: repos.filter((r) => reaches(login, owner, r)) }))
    .filter((inst) => inst.repos.length);

  const oauth = (path: string, body: Record<string, string>): [number, unknown] => {
    // GitHub says why with a 200 for every grant but the first request.
    if (body.client_id !== clientId) return [401, { error: 'incorrect_client_credentials', error_description: 'The client_id and/or client_secret passed are incorrect.' }];
    if (opts.deviceFlow === false) return [400, { error: 'device_flow_disabled', error_description: 'Device Flow must be explicitly enabled for this App' }];
    if (path === '/login/device/code') {
      const n = devices.length + 1;
      devices.push({ code: `dc-${n}`, user: `WDJB-MJH${n}`, state: 'pending' });
      return [200, { device_code: `dc-${n}`, user_code: `WDJB-MJH${n}`, verification_uri: `${fake.web}/login/device`, expires_in: 899, interval: 5 }];
    }
    if (body.grant_type === 'refresh_token') {
      const login = refresh.get(body.refresh_token ?? '');
      if (!login) return [200, { error: 'bad_refresh_token', error_description: 'The refresh token passed is incorrect or expired.' }];
      // Each refresh token works once; the new pair replaces it, and the access token issued with it ends at once, as on GitHub.
      refresh.delete(body.refresh_token!);
      access.delete(body.refresh_token!.replace(/^ghr_/, 'ghu_'));
      return [200, issue(login)];
    }
    if (body.grant_type !== 'urn:ietf:params:oauth:grant-type:device_code') return [200, { error: 'unsupported_grant_type' }];
    const device = devices.find((d) => d.code === body.device_code);
    if (!device || device.state === 'used') return [200, { error: 'incorrect_device_code', error_description: 'The device_code provided is not valid.' }];
    if (fake.slowDowns > 0) { fake.slowDowns -= 1; return [200, { error: 'slow_down', error_description: 'Too many requests have been made in the same timeframe.', interval: 10 }]; }
    if (device.state === 'denied') return [200, { error: 'access_denied', error_description: 'The authorization request was denied.' }];
    if (device.state === 'pending') return [200, { error: 'authorization_pending', error_description: 'The authorization request is still pending.' }];
    device.state = 'used';
    return [200, issue(device.login!)];
  };

  const shown = (c: FakeGitHub['comments'][number]) => ({
    id: c.id, body: c.body, user: { login: c.login }, created_at: c.created_at, updated_at: c.updated_at,
    html_url: `https://github.com/${c.repo}/${issues.get(`${c.repo}#${c.number}`)?.pull ? 'pull' : 'issues'}/${c.number}#issuecomment-${c.id}`,
  });

  /** The repository routes: issues, their comments, and comment reactions. */
  const repoApi = (method: string, path: string, login: string, body: Record<string, string>): [number, unknown] | undefined => {
    const m = /^\/repos\/([^/]+)\/([^/]+)\/issues(?:\/(.*))?$/.exec(new URL(path, 'http://x').pathname);
    if (!m) return undefined;
    const repo = `${m[1]}/${m[2]}`;
    if (!reaches(login, m[1]!, m[2]!)) return [404, { message: 'Not Found' }];
    const rest = m[3] ?? '';
    const url = new URL(path, 'http://x');
    if (method === 'GET' && rest === 'comments') {
      const since = Date.parse(url.searchParams.get('since') ?? '1970-01-01');
      const per = Number(url.searchParams.get('per_page') ?? 30);
      const page = Number(url.searchParams.get('page') ?? 1);
      const all = fake.comments.filter((c) => c.repo === repo && Date.parse(c.updated_at) >= since)
        .sort((a, b) => Date.parse(a.created_at) - Date.parse(b.created_at) || a.id - b.id);
      return [200, all.slice((page - 1) * per, page * per).map(shown)];
    }
    const one = /^comments\/(\d+)$/.exec(rest);
    if (method === 'GET' && one) {
      const found = fake.comments.find((c) => c.repo === repo && c.id === Number(one[1]));
      return found ? [200, shown(found)] : [404, { message: 'Not Found' }];
    }
    const reaction = /^comments\/(\d+)\/reactions$/.exec(rest);
    if (method === 'POST' && reaction) {
      fake.reactions.push({ repo, comment: Number(reaction[1]), login, content: body.content! });
      return [201, { content: body.content }];
    }
    const issue = /^(\d+)(\/comments)?$/.exec(rest);
    const found = issue && issues.get(`${repo}#${issue[1]}`);
    if (!found) return [404, { message: 'Not Found' }];
    const number = Number(issue[1]);
    if (method === 'POST' && issue[2]) {
      fake.posted.push({ repo, number, login, body: body.body! });
      return [201, shown(fake.comments[fake.addComment(repo, number, login, body.body!) - 1]!)];
    }
    if (issue[2]) return [200, fake.comments.filter((c) => c.repo === repo && c.number === number).map(shown)];
    return [200, { title: found.title, body: found.body, state: 'open', html_url: `https://github.com/${repo}/${found.pull ? 'pull' : 'issues'}/${number}`, user: { login: 'someone' }, ...(found.pull ? { pull_request: {} } : {}) }];
  };

  const api = (method: string, path: string, token: string, body: Record<string, string>): [number, unknown] => {
    const login = access.get(token);
    if (!login) return [401, { message: 'Bad credentials' }];
    const repoRoute = repoApi(method, path, login, body);
    if (repoRoute) return repoRoute;
    const url = new URL(path, 'http://x');
    if (url.pathname === '/user') return [200, { login, id: ids[login] ??= 1000 + Object.keys(ids).length }];
    if (url.pathname === '/user/installations') {
      const all = installations(login).map((i) => ({ id: i.id, app_slug: 'animus-helix', account: { login: i.owner }, permissions: fake.permissions[i.owner] ?? { contents: 'write', metadata: 'read', pull_requests: 'write' } }));
      return [200, { total_count: all.length, installations: all }];
    }
    const m = /^\/user\/installations\/(\d+)\/repositories$/.exec(url.pathname);
    const inst = m && installations(login).find((i) => i.id === Number(m[1]));
    if (!inst) return [404, { message: 'Not Found' }];
    // GitHub's pages, so a client that reads only the first misses the rest.
    const per = Number(url.searchParams.get('per_page') ?? 30);
    const page = Number(url.searchParams.get('page') ?? 1);
    const repos = inst.repos.map((name) => ({ name, full_name: `${inst.owner}/${name}`, owner: { login: inst.owner } }));
    return [200, { total_count: repos.length, repositories: repos.slice((page - 1) * per, page * per) }];
  };

  const server = createServer((req, res) => {
    let raw = '';
    req.on('data', (c: Buffer) => { raw += c; });
    req.on('end', () => {
      const path = req.url!.startsWith('/api/') ? req.url!.slice(4) : req.url!;
      fake.calls.push(`${req.method} ${req.url!.split('?')[0]}`);
      const body = (req.headers['content-type'] ?? '').includes('json') ? JSON.parse(raw || '{}') as Record<string, string> : Object.fromEntries(new URLSearchParams(raw));
      const [status, answer] = req.url!.startsWith('/api/')
        ? api(req.method!, path, (req.headers.authorization ?? '').replace(/^(Bearer|token) /, ''), body)
        : oauth(path, body);
      res.writeHead(status, { 'content-type': 'application/json' });
      res.end(JSON.stringify(answer));
    });
  });
  await new Promise<void>((r) => { server.listen(0, '127.0.0.1', r); });
  const base = `http://127.0.0.1:${(server.address() as AddressInfo).port}`;
  fake.web = base;
  fake.api = `${base}/api`;
  return fake;
}
