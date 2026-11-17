// The client side of Helix (docs/factory.md, "The office machine"): submit a
// spec to the machine that runs jobs, ask about it, and add the projects
// jobs run for. Thin HTTP calls; a job's result never depends on them, since
// it lands as a pull request.
import { chmodSync, existsSync, mkdirSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import { dirname, join as joinPath } from 'node:path';
import { animusHome } from './log.ts';
import { AnimusError } from './proc.ts';
import { animusVersion } from './version.ts';

/** How a client tells Helix its version; Helix refuses one it cannot work with (version.ts, compatible). */
export const VERSION_HEADER = 'animus-version';

/** A job as Helix reports it. */
export type RemoteJob = {
  id: number; state: string; person: string; repo: string; title: string; submitted: string; started?: string; ended?: string;
  animus_job?: string; outcome?: string; pr?: string; reason?: string; question?: string; cost_usd?: number; log?: string;
  /** On a submission's answer: the submitter's skills Helix took with it. A Helix that predates them leaves this out. */
  skills?: string[];
};

/** Where `animus join` keeps the address and token it was given: the owner's eyes only. */
export const helixFile = (home = animusHome()) => joinPath(home, 'helix.json');

export type HelixLogin = { url: string; token: string; name?: string };

/** The Helix this client talks to: HELIX_URL and HELIX_TOKEN when both are set, else what `animus join` kept. */
export function helixLogin(env: NodeJS.ProcessEnv = process.env, file = helixFile()): (HelixLogin & { from: string }) | undefined {
  if (env.HELIX_URL && env.HELIX_TOKEN) return { url: env.HELIX_URL, token: env.HELIX_TOKEN, from: 'HELIX_URL and HELIX_TOKEN' };
  if (!existsSync(file)) return undefined;
  try {
    const saved = JSON.parse(readFileSync(file, 'utf8')) as Partial<HelixLogin>;
    if (typeof saved.url === 'string' && typeof saved.token === 'string') return { url: saved.url, token: saved.token, ...(saved.name ? { name: saved.name } : {}), from: file };
  } catch { /* unreadable: as if not there */ }
  return undefined;
}

export function saveHelixLogin(login: HelixLogin, file = helixFile()): void {
  mkdirSync(dirname(file), { recursive: true });
  writeFileSync(file, `${JSON.stringify(login, null, 2)}\n`, { mode: 0o600 });
  chmodSync(file, 0o600);
}

export const forgetHelixLogin = (file = helixFile()) => rmSync(file, { force: true });

const unreachable = (url: string, err: unknown) => new AnimusError(`could not reach Helix at ${url}: ${(err as Error).cause instanceof Error ? ((err as Error).cause as Error).message : (err as Error).message}`);

async function request<T>(method: string, url: string, path: string, token: string | undefined, body?: unknown): Promise<T> {
  let res: Response;
  try {
    res = await fetch(new URL(path, url), { method, headers: { ...(token ? { authorization: `Bearer ${token}` } : {}), 'content-type': 'application/json', [VERSION_HEADER]: animusVersion() }, ...(body === undefined ? {} : { body: JSON.stringify(body) }) });
  } catch (err) { throw unreachable(url, err); }
  const value = (await res.json().catch(() => ({}))) as { error?: string };
  if (!res.ok) throw new AnimusError(`Helix refused: ${value.error ?? res.statusText}`);
  return value as T;
}

async function call<T>(method: string, path: string, body?: unknown): Promise<T> {
  const login = helixLogin();
  if (!login) throw new AnimusError('this machine has not joined a Helix: animus join <url> <code>, with a code from whoever runs it (or set HELIX_URL and HELIX_TOKEN)');
  return request<T>(method, login.url, path, login.token, body);
}

/** Helix's version, asked without a token: what `animus doctor` compares with its own. */
export async function helixVersion(url: string): Promise<string> {
  let res: Response;
  try { res = await fetch(new URL('/version', url), { signal: AbortSignal.timeout(5000) }); } catch (err) { throw unreachable(url, err); }
  const value = (await res.json().catch(() => ({}))) as { version?: string };
  if (!res.ok || !value.version) throw new AnimusError(`Helix at ${url} did not say its version (${res.status}): it predates versioned releases`);
  return value.version;
}

export type SentSkill = { name: string; roles: string[]; types?: string[]; text: string };
export const submit = (s: { repo: string; spec: string; name: string; draft?: boolean; skills?: SentSkill[] }) => call<RemoteJob>('POST', '/jobs', s);
/** The person's own jobs; with all, every person's, which only the owner may see. */
export const jobs = (all = false) => call<{ slots: number; jobs: RemoteJob[] }>('GET', all ? '/jobs?all' : '/jobs');
export const job = (id: string) => call<RemoteJob>('GET', `/jobs/${encodeURIComponent(id)}`);
export const cancel = (id: string) => call<RemoteJob>('POST', `/jobs/${encodeURIComponent(id)}/cancel`);
export const answer = (id: string, text: string) => call<RemoteJob>('POST', `/jobs/${encodeURIComponent(id)}/answer`, { answer: text });
/** A project as Helix reports it: checking until Helix has tried it, then ready or failed. */
export type RemoteProject = { name: string; url: string; state: 'checking' | 'ready' | 'failed'; added: string; added_by?: string; reason?: string; log?: string };
export const projects = () => call<{ projects: RemoteProject[] }>('GET', '/projects');
export const project = (name: string) => call<RemoteProject>('GET', `/projects/${encodeURIComponent(name)}`);
export const addProject = (p: { name: string; url: string }) => call<RemoteProject>('POST', '/projects', p);
export const removeProject = (name: string) => call<RemoteProject>('DELETE', `/projects/${encodeURIComponent(name)}`);

/** `animus project list`: one line per project. */
export function describeProjects(list: readonly RemoteProject[]): string {
  if (!list.length) return 'no projects yet: animus project add, from a checkout of one';
  const rows = list.map((p) => [p.name, p.state, p.url, p.added_by ? `added by ${p.added_by}` : 'added on the machine', p.state === 'failed' ? (p.reason ?? '').split('\n')[0]!.slice(0, 80) : '']);
  const widths = rows[0]!.map((_, i) => Math.max(...rows.map((row) => row[i]!.length)));
  return rows.map((row) => row.map((cell, i) => cell.padEnd(widths[i]!)).join('  ').trimEnd()).join('\n');
}

export const leave = () => call<{ name: string; cancelled: number[]; kept?: string }>('POST', '/leave');

/** What an invite is for: asked with its code, before any token exists. */
export type InviteDetails = { name: string; github?: string; expires: string; repos: { name: string; url: string }[]; github_app?: boolean };
export const inviteDetails = (url: string, code: string) => request<InviteDetails>('POST', url, '/invite', undefined, { code });
/** An invite Helix made: its code, or the Slack user its bot sent it to; url is where Helix says people reach it. */
export type MadeInvite = { name: string; expires: string; code?: string; slack?: string; url?: string };
/** `animus invite`, from the owner's laptop: the same as helix invite on the machine. */
export const invite = (p: { name: string; github?: string; slack?: string }) => call<MadeInvite>('POST', '/people', p);

/** What helix invite and animus invite print: the code and the line to join with, or where the Slack bot sent it. */
export function describeInvite(made: MadeInvite, url: string | undefined): string {
  const until = made.expires.slice(0, 16).replace('T', ' ');
  if (made.slack) return `The Slack bot sent ${made.slack} the line that installs Animus and joins as ${made.name}; its code is good until ${until} UTC.`;
  return [
    `${made.name}'s code, shown this once, good until ${until} UTC:`,
    '',
    `  ${made.code}`,
    '',
    'They install the animus plugin in Claude Code, then run:',
    '',
    `  animus join ${url ?? '<the address they reach Helix at; url: in config.yaml fills it in here>'} ${made.code}`,
  ].join('\n');
}

/** A person Helix took off: their cancelled jobs, a credentials file it kept outside its home, their deleted folder. */
export type RemovedPerson = { name: string; cancelled: number[]; kept?: string; folder: string; home: string };
/** `animus remove-person`, from the owner's laptop: the same as helix remove-person on the machine. */
export const removePerson = (name: string) => call<RemovedPerson>('DELETE', `/people/${encodeURIComponent(name)}`);

/** What helix remove-person and animus remove-person print: what was done, and what is left to do elsewhere. */
export function describeRemoval(gone: RemovedPerson): string {
  return [
    `${gone.name} is off Helix: their token no longer works${gone.cancelled.length ? `, and job(s) ${gone.cancelled.join(', ')} were cancelled` : ''}.`,
    gone.kept ? `Their credentials file is outside ${gone.home}, so it was left: delete ${gone.kept}` : 'Their credentials file is deleted.',
    `Their folder ${gone.folder} (clones, job state, Claude config) is deleted.`,
    '',
    'Left to do elsewhere:',
    '  - GitHub: revoke the token they gave Helix (they can, or an org owner under the org\'s personal access tokens), and take them off the organisation or repositories.',
    '  - Claude: take them off your Claude organisation, or have them revoke the token they gave Helix.',
    '  - Tailscale: remove them from the tailnet, which takes their devices off it.',
    '  - Their open animus/* pull requests: close or take over; animus cleanup removes the branches of closed ones.',
  ].join('\n');
}

/** GitHub's device flow, started by Helix for an invite's code: user_code is what the person types at verification_uri. */
export type DeviceStart = { device_code: string; user_code: string; verification_uri: string; expires_in: number };
export const joinDevice = (url: string, code: string) => request<DeviceStart>('POST', url, '/join/device', undefined, { code });

/** A project Helix's GitHub App cannot reach for the person, and the link its owner installs the app with. */
export type Unreachable = { project: string; owner: string; install?: string };
export type Joined = { name: string; token: string; github?: string; cannot_push?: string[]; unreachable?: Unreachable[] };

/**
 * Joins with the Claude token and either a pasted GitHub token or, on a
 * Helix with a GitHub App, the device code: Helix then waits on GitHub a
 * while at a time, answering pending until the person approves.
 */
export async function join(url: string, code: string, tokens: { claude_token: string } & ({ github_token: string } | { device_code: string })): Promise<Joined> {
  for (;;) {
    const answer = await request<Joined | { pending: true }>('POST', url, '/join', undefined, { code, ...tokens });
    if (!('pending' in answer)) return answer;
  }
}

const how = (j: RemoteJob) => (j.state === 'ended' ? j.outcome ?? 'ended' : j.state);

/** `animus status`: one line per job, newest last. */
export function describeJobs(list: readonly RemoteJob[]): string {
  if (!list.length) return 'no jobs';
  const rows = list.map((j) => [String(j.id), j.person, j.repo, how(j), j.title, j.pr ?? j.question ?? j.reason?.split('\n')[0]?.slice(0, 60) ?? '']);
  const widths = rows[0]!.map((_, i) => Math.max(...rows.map((row) => row[i]!.length)));
  return rows.map((row) => row.map((cell, i) => cell.padEnd(widths[i]!)).join('  ').trimEnd()).join('\n');
}

/** `animus status <id>`: the job, then the end of its log. */
export function describeJob(j: RemoteJob): string {
  return [
    `job ${j.id}: ${j.title}`,
    `  ${how(j)}${j.pr ? `: ${j.pr}` : ''}`,
    `  for ${j.person} on ${j.repo}, submitted ${j.submitted.slice(0, 16).replace('T', ' ')}`,
    ...(j.question ? [`  it asks: ${j.question}`, `  answer with: animus answer ${j.id} "<your answer>"`] : []),
    ...(j.reason ? [`  reason: ${j.reason.split('\n')[0]}`] : []),
    ...(j.log ? ['', j.log] : []),
  ].join('\n');
}
