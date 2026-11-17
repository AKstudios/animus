// `animus join` and `animus leave`: getting onto a Helix with a code from
// whoever runs it, and off again. Join checks this machine, has the person
// make a Claude token and a GitHub token, sends both with the code, and keeps
// the Helix token it gets back in ANIMUS_HOME/helix.json, so nobody sets
// HELIX_URL or HELIX_TOKEN by hand.
import { spawn, spawnSync } from 'node:child_process';
import { createInterface } from 'node:readline';
import { describeFindings, doctor } from './doctor.ts';
import { AnimusError } from './proc.ts';
import * as helix from './remote.ts';

/** What a job needs of GitHub: push its branch, open its pull request. Metadata read comes with any token. */
const PERMISSIONS = { contents: 'write', pull_requests: 'write' } as const;
const TOKEN_DAYS = 90;

/** The owner of a repository on GitHub, from its https address. */
export const ownerOf = (url: string) => /^https:\/\/github\.com\/([^/]+)\//.exec(url)?.[1];

/** GitHub's page for a new fine-grained token, filled in for a Helix: name, what it is for, how long, and the permissions. */
export function tokenPage(details: helix.InviteDetails): string {
  const owners = [...new Set(details.repos.map((r) => ownerOf(r.url)).filter((o): o is string => Boolean(o)))];
  const repos = details.repos.map((r) => r.url.replace(/^https:\/\/github\.com\//, '').replace(/\.git$/, '') || r.name);
  const q = new URLSearchParams({
    name: 'Animus on Helix',
    description: `Lets Helix push animus/* branches and open pull requests as you, on ${repos.join(', ') || 'its repositories'}. Choose "Only select repositories" and pick those.`.slice(0, 1024),
    expires_in: String(TOKEN_DAYS),
    // A token has one owner: with repositories under two, only the first is filled in.
    ...(owners[0] ? { target_name: owners[0] } : {}),
    ...PERMISSIONS,
  });
  return `https://github.com/settings/personal-access-tokens/new?${q.toString()}`;
}

/** Opens a page in the person's browser, on any system; they get the address printed too. */
export function openPage(url: string): void {
  const [command, args] = process.platform === 'darwin' ? ['open', [url]] : process.platform === 'win32' ? ['cmd', ['/c', 'start', '""', url.replace(/&/g, '^&')]] : ['xdg-open', [url]];
  try { spawn(command, args as string[], { stdio: 'ignore', detached: true }).on('error', () => {}).unref(); } catch { /* the printed address will do */ }
}

/** Asks on the terminal; a hidden answer is not echoed, since it is a token. */
export function ask(prompt: string, hidden = false): Promise<string> {
  return new Promise((resolve) => {
    const rl = createInterface({ input: process.stdin, output: process.stderr, terminal: true });
    let muted = false;
    (rl as unknown as { _writeToOutput: (s: string) => void })._writeToOutput = (s) => { if (!muted) process.stderr.write(s); };
    rl.question(prompt, (answer) => {
      rl.close();
      if (muted) process.stderr.write('\n');
      resolve(answer.trim());
    });
    muted = hidden;
  });
}

const say = (line = '') => console.error(line);

export async function joinHelix(url: string, code: string, cwd: string): Promise<helix.HelixLogin> {
  if (!process.stdin.isTTY) throw new AnimusError('animus join asks for two tokens, so it runs in a terminal');
  const base = url.replace(/\/+$/, '');

  say(`Checking this machine and ${base}`);
  const found = await doctor(cwd, process.env, { helixUrl: base });
  say(describeFindings(found));
  const blocking = found.filter((f) => f.level === 'fail' && (f.what === 'helix' || f.what === 'claude'));
  if (blocking.length) throw new AnimusError(`fix the ${blocking.map((f) => f.what).join(' and ')} line(s) above first`);
  if (found.some((f) => f.level === 'fail')) say('The other fail lines stop jobs run on this machine, not jobs on Helix.');

  const details = await helix.inviteDetails(base, code);
  say(`\nThis code lets in ${details.name}${details.github ? ` (GitHub account ${details.github})` : ''}, until ${details.expires.slice(0, 16).replace('T', ' ')} UTC.`);
  say(`Helix's repositories: ${details.repos.map((r) => r.name).join(', ') || 'none yet'}`);

  say('\n1. Your Claude token. Jobs run on your own Claude subscription.');
  say('   claude setup-token opens a sign-in in your browser and prints a token that lasts a year.\n');
  const setup = spawnSync('claude', ['setup-token'], { stdio: 'inherit' });
  if (setup.error || setup.status !== 0) say('   claude setup-token did not finish; run it yourself in another terminal if you need to.');
  const claude = await ask('   Paste the token it printed (sk-ant-oat...): ', true);
  if (!claude) throw new AnimusError('no Claude token given: nothing was sent');

  const page = tokenPage(details);
  say('\n2. Your GitHub token. Jobs push their branch and open their pull request as you.');
  say('   GitHub\'s page for a fine-grained token is opening with the permissions filled in (contents and pull requests: write).');
  say(`   Under Repository access choose "Only select repositories" and pick: ${details.repos.map((r) => r.url.replace(/^https:\/\/github\.com\//, '').replace(/\.git$/, '') || r.name).join(', ')}.`);
  const owners = new Set(details.repos.map((r) => ownerOf(r.url)).filter(Boolean));
  if (owners.size > 1) say(`   Those repositories have ${owners.size} owners and one token covers one: tell whoever runs Helix, since some pushes will fail.`);
  say('   If the owner is an organisation, check Resource owner shows it: GitHub sometimes resets it to you.');
  say(`   ${page}\n`);
  openPage(page);
  const github = await ask('   Paste the token GitHub showed (github_pat_...): ', true);
  if (!github) throw new AnimusError('no GitHub token given: nothing was sent');

  say('\nSending them to Helix, which tries both for real (a small Claude session and a push that sends nothing). This takes a minute or so.');
  const joined = await helix.join(base, code, { claude_token: claude, github_token: github });
  const login = { url: base, token: joined.token, name: joined.name };
  helix.saveHelixLogin(login);
  say(`\nYou are on Helix as ${joined.name}${joined.github ? ` (GitHub: ${joined.github})` : ''}. Your Helix token is kept in ${helix.helixFile()}.`);
  if (joined.cannot_push?.length) say(`Your GitHub token may not push to ${joined.cannot_push.join(', ')}, so Helix refuses your jobs there until it may: add them to the token's repositories on GitHub.`);
  say('From a repository Helix has: animus submit <spec.md>, then animus status. For one it has not: animus project add.');
  return login;
}

export async function leaveHelix(confirmed: boolean): Promise<string> {
  const login = helix.helixLogin();
  if (!login) throw new AnimusError('this machine has not joined a Helix');
  if (!confirmed) {
    if (!process.stdin.isTTY) throw new AnimusError('animus leave takes you off Helix and cancels your jobs there: run it with --yes to go ahead');
    const yes = await ask(`Leave ${login.url}${login.name ? ` as ${login.name}` : ''}? Your queued and running jobs there are cancelled and your tokens deleted. [y/N] `);
    if (!/^y(es)?$/i.test(yes)) return 'nothing changed';
  }
  const gone = await helix.leave();
  if (login.from === helix.helixFile()) helix.forgetHelixLogin();
  return [
    `${gone.name} is off ${login.url}${gone.cancelled.length ? `; job(s) ${gone.cancelled.join(', ')} were cancelled` : ''}.`,
    gone.kept ? `Helix kept a credentials file it did not make (${gone.kept}): ask whoever runs it to delete it.` : 'Helix deleted the tokens you gave it.',
    login.from === helix.helixFile() ? `${helix.helixFile()} is deleted.` : 'Unset HELIX_URL and HELIX_TOKEN.',
    'Revoke them too, since they still work elsewhere until you do:',
    '  - GitHub: Settings, Developer settings, Personal access tokens, Fine-grained tokens: "Animus on Helix".',
    '  - Claude: the token claude setup-token made, in your Claude account\'s settings.',
  ].join('\n');
}
