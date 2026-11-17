// `animus project add`: puts the repository of the checkout it runs in on
// Helix, under the name `animus submit` from that checkout uses. Helix checks
// it before taking it (helix/src/projects.ts) and this waits, printing what
// the check says, until the project is ready or has failed.
import { existsSync } from 'node:fs';
import { basename, join } from 'node:path';
import { githubUrl, mainCheckout } from './git.ts';
import { AnimusError, tryGit } from './proc.ts';
import { PROFILE_PATH } from './profile.ts';
import * as helix from './remote.ts';

/** How often the check is asked how it is going. */
const POLL_MS = 2000;

export async function addProject(cwd: string, opts: { name?: string; say: (line: string) => void; sleep?: (ms: number) => Promise<void> }): Promise<helix.RemoteProject> {
  const dir = mainCheckout(cwd);
  const origin = tryGit(dir, ['remote', 'get-url', 'origin']);
  if (!origin) throw new AnimusError(`${dir} has no origin: Helix clones a project from GitHub`);
  const url = githubUrl(origin);
  if (!url) throw new AnimusError(`${dir}'s origin is ${origin}, which is not on GitHub: Helix opens pull requests there`);
  // Helix reads the profile from what it clones, so one only here would fail its check.
  if (!existsSync(join(dir, PROFILE_PATH))) throw new AnimusError(`${dir} has no ${PROFILE_PATH}: run animus init, correct what it drafts, commit and push it, then add the project`);
  if (tryGit(dir, ['ls-files', '--error-unmatch', PROFILE_PATH]) === undefined) throw new AnimusError(`${PROFILE_PATH} is not committed: commit and push it first, since Helix reads it from GitHub`);
  const name = opts.name ?? basename(dir);
  const sleep = opts.sleep ?? ((ms: number) => new Promise<void>((r) => { setTimeout(r, ms); }));

  await helix.addProject({ name, url });
  opts.say(`Helix is checking ${name} (${url}): a clone with your GitHub token, a push that sends nothing, its profile, and its setup once. This can take some minutes.`);
  let shown = 0;
  for (;;) {
    const p = await helix.project(name);
    const lines = (p.log ?? '').split('\n').filter(Boolean);
    for (const line of lines.slice(shown)) opts.say(`  ${line}`);
    shown = Math.max(shown, lines.length);
    if (p.state !== 'checking') return p;
    await sleep(POLL_MS);
  }
}
