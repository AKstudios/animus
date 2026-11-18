// helix serve's weekly retro (docs/specs/insights-2-lessons.md): once a week
// each ready project gets `animus retro`, run as an animus process in Helix's
// own Animus home, where the lessons it proposes are kept. The project's Slack
// channel is told how many there are and the command to see them.
import { spawn } from 'node:child_process';
import { delimiter, dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';
import type { Transport } from './slack-api.ts';
import type { Store } from './store.ts';

const CLI = join(dirname(fileURLToPath(import.meta.url)), '..', '..', 'plugin', 'src', 'cli.ts');

/** How often a project's retro runs, how often `helix serve` looks for one that is due, and how long after it starts it first does. */
export const RETRO_EVERY_MS = 7 * 24 * 60 * 60 * 1000;
export const RETRO_CHECK_MS = 60 * 60 * 1000;
export const RETRO_FIRST_MS = 15 * 60 * 1000;

/** Runs a project's retro, which reads the run records of Helix's own Animus home and of each of `homes`, and says how many lessons it proposed. Throws why it could not. */
export type RunRetro = (project: string, homes: string[]) => Promise<{ proposed: number }>;

/** `animus retro --json` in a process of its own, as Helix's account: Helix goes on answering meanwhile. */
export const retroProcess: RunRetro = (project, homes) => new Promise((resolve, reject) => {
  const child = spawn(process.execPath, ['--disable-warning=ExperimentalWarning', CLI, 'retro', '--project', project, '--json'], { stdio: ['ignore', 'pipe', 'pipe'], timeout: 30 * 60 * 1000, env: { ...process.env, ANIMUS_RETRO_HOMES: homes.join(delimiter) } });
  let out = '';
  let err = '';
  child.stdout.on('data', (c: Buffer) => { out += c.toString(); });
  child.stderr.on('data', (c: Buffer) => { err += c.toString(); });
  child.on('error', reject);
  child.on('close', (code) => {
    if (code !== 0) return reject(new Error(err.trim().split('\n').pop() || `animus retro exited ${code}`));
    try { resolve({ proposed: Number((JSON.parse(out) as { proposed: number }).proposed) }); } catch { reject(new Error('animus retro said nothing Helix could read')); }
  });
});

/** The Slack notice: how many lessons were proposed, and the command to see them. */
export const retroNotice = (project: string, proposed: number) =>
  `The weekly retro of ${project} proposed ${proposed} lesson${proposed === 1 ? '' : 's'}. See them with \`animus lessons\`, then \`animus lessons accept <id>\` or \`animus lessons dismiss <id>\`.`;

/**
 * Runs the retro of every ready project that has none from the last week. The
 * time is kept when a retro starts, not when it ends well: one that failed,
 * or had no runs to read, is not tried again every hour. Nothing is posted
 * when nothing was proposed.
 */
export async function weeklyRetros(opts: { store: Store; run?: RunRetro; /** The Animus homes beside Helix's own that jobs write their records to: each person's, with containers. */ homes?: () => string[]; slack?: Pick<Transport, 'post'>; say?: (line: string) => void; now?: number }): Promise<void> {
  const { store } = opts;
  const run = opts.run ?? retroProcess;
  const say = opts.say ?? (() => {});
  const now = opts.now ?? Date.now();
  for (const project of store.projects().filter((p) => p.state === 'ready')) {
    const last = store.lastRetro(project.name);
    if (last && now - Date.parse(last) < RETRO_EVERY_MS) continue;
    store.setLastRetro(project.name, new Date(now).toISOString());
    try {
      const { proposed } = await run(project.name, opts.homes?.() ?? []);
      say(`retro of ${project.name}: ${proposed} lesson${proposed === 1 ? '' : 's'} proposed`);
      if (!proposed || !opts.slack) continue;
      for (const channel of store.channelsOf(project.name)) {
        await opts.slack.post(channel, retroNotice(project.name, proposed)).catch((err: unknown) => say(`retro of ${project.name}: Slack refused the notice in ${channel}: ${(err as Error).message}`));
      }
    } catch (err) {
      say(`retro of ${project.name} did not run: ${(err as Error).message}`);
    }
  }
}
