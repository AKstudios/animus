// A project's secrets: values a job of it gets by the names its profile's
// `secrets:` lists. Kept under Helix's home, one file per project for the
// shared values and one per person for their own, mode 600 in a 700 folder.
// A shared value is set or removed only by whoever added the project or the
// owner; anyone keeps their own, which a job of theirs gets before the shared.
// No value ever leaves Helix but into a job's environment or its add check's.
import { chmodSync, existsSync, mkdirSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';
import { profileOnBase } from '../../plugin/src/admit.ts';
import { MASKED_FROM, variableProblem } from '../../plugin/src/profile.ts';
import type { RemoteSecret, SetSecret } from '../../plugin/src/remote.ts';
import type { Config } from './config.ts';
import { isOwner } from './owner.ts';
import type { HelixJob, Store } from './store.ts';
import { Refused } from './supervisor.ts';

type Kept = Record<string, { value: string; by: string; at: string }>;

export const secretsDir = (home: string, project: string) => join(home, 'secrets', project);
const fileOf = (home: string, project: string, person?: string) =>
  person ? join(secretsDir(home, project), 'people', `${person}.json`) : join(secretsDir(home, project), 'shared.json');

const read = (file: string): Kept => (existsSync(file) ? (JSON.parse(readFileSync(file, 'utf8')) as Kept) : {});

function save(home: string, project: string, file: string, kept: Kept): void {
  for (const dir of [join(home, 'secrets'), secretsDir(home, project), join(secretsDir(home, project), 'people')]) {
    mkdirSync(dir, { recursive: true, mode: 0o700 });
    chmodSync(dir, 0o700);
  }
  writeFileSync(file, `${JSON.stringify(kept, null, 2)}\n`, { mode: 0o600 });
  chmodSync(file, 0o600);
}

type Opts = { store: Store; home: string; config: Pick<Config, 'owner'> };

/** The project, and the file person acts on: their own with mine, else the shared one, which only its adder or the owner may change. */
function target(opts: Opts, person: string, project: string, mine: boolean): string {
  const p = opts.store.project(project);
  if (!p) throw new Refused(404, `Helix has no project named ${project}`);
  if (!mine && p.added_by !== person && !isOwner(opts.config, person)) {
    throw new Refused(403, `${project} was added ${p.added_by ? `by ${p.added_by}` : 'on the machine'}: only ${p.added_by ? `${p.added_by} (who added it) or whoever runs Helix` : 'whoever runs Helix'} may change its shared secrets. Keep your own value with --mine`);
  }
  return fileOf(opts.home, project, mine ? person : undefined);
}

/** `POST /projects/<name>/secrets`: { name, value, mine }. masked: whether the value is long enough to be shown as *** in a job's output. */
export function setSecret(opts: Opts, person: string, project: string, body: Record<string, unknown>): SetSecret {
  const { name, value, mine } = body;
  if (typeof name !== 'string' || typeof value !== 'string' || !value || (mine !== undefined && typeof mine !== 'boolean')) throw new Refused(400, 'a secret needs name, value (not empty) and mine (true or false)');
  const problem = variableProblem(name);
  if (problem) throw new Refused(400, problem);
  const file = target(opts, person, project, mine === true);
  save(opts.home, project, file, { ...read(file), [name]: { value, by: person, at: new Date().toISOString() } });
  return { project, name, mine: mine === true, masked: value.length >= MASKED_FROM };
}

/** `DELETE /projects/<name>/secrets/<NAME>`, with ?mine for the person's own. */
export function removeSecret(opts: Opts, person: string, project: string, name: string, mine: boolean): void {
  const file = target(opts, person, project, mine);
  const { [name]: gone, ...rest } = read(file);
  if (!gone) throw new Refused(404, `${project} has no ${mine ? 'secret of yours' : 'shared secret'} ${name}`);
  save(opts.home, project, file, rest);
}

/** `GET /projects/<name>/secrets`: the shared ones and person's own, by name and who set them; never a value. */
export function listSecrets(opts: Pick<Opts, 'store' | 'home'>, person: string, project: string): RemoteSecret[] {
  if (!opts.store.project(project)) throw new Refused(404, `Helix has no project named ${project}`);
  const lines = (kept: Kept, scope: RemoteSecret['scope']) => Object.entries(kept).map(([name, s]) => ({ name, scope, by: s.by }));
  return [...lines(read(fileOf(opts.home, project)), 'shared'), ...lines(read(fileOf(opts.home, project, person)), 'mine')];
}

/** The values a job of person's gets: each of names that is set, their own before the shared one. */
export function secretsFor(home: string, project: string, person: string | undefined, names: readonly string[]): Record<string, string> {
  const shared = read(fileOf(home, project));
  const own = person ? read(fileOf(home, project, person)) : {};
  const env: Record<string, string> = {};
  for (const n of names) {
    const value = own[n]?.value ?? shared[n]?.value;
    if (value !== undefined) env[n] = value;
  }
  return env;
}

/** The supervisor's secrets: by the names the base branch's profile lists, which fresh or image has just fetched. */
export const jobSecrets = (home: string) => (job: HelixJob, repoDir: string) => secretsFor(home, job.repo, job.person, profileOnBase(repoDir)?.profile.secrets ?? []);

/** Removing a project removes its secrets. */
export const forgetSecrets = (home: string, project: string) => rmSync(secretsDir(home, project), { recursive: true, force: true });
