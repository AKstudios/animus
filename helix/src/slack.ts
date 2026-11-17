// The Slack bot's core: what it does with each event Slack sends, through a
// transport (slack-api.ts), so tests drive it without Slack. A Slack user with
// no Slack link is told, privately, to ask the owner for an invite, and
// nothing they send is kept. The owner may use the bot without a link. A
// linked person's jobs post their progress to them, one DM thread per job.
import { AnimusError } from '../../plugin/src/proc.ts';
import { SOURCE } from '../../plugin/src/setup.ts';
import type { Config } from './config.ts';
import { INVITE_HOURS, invite } from './join.ts';
import { SLACK_USER, type Transport } from './slack-api.ts';
import type { HelixJob, Store } from './store.ts';

const USAGE = 'Usage: /helix invite @user <github-login>, /helix link @user <person>, or /helix notify off|on';
const INVITE_USAGE = 'An invite sent on Slack names their GitHub login, so only a token that signs in as it is taken: /helix invite @user <github-login>';
const INSTALL = `https://raw.githubusercontent.com/${SOURCE.repo}/${SOURCE.ref}/install.sh`;

type Core = { store: Store; config: Config };

/** Answers what reaches the bot. The owner is read from config at each event, so a config edit changes it. */
export function slackBot(transport: Transport, opts: Core): void {
  const { store, config } = opts;
  transport.onEvent(async (event) => {
    const owner = config.slack?.owner ?? '';
    const reply = (text: string) => transport.ephemeral(event.channel, event.user, text);
    const isOwner = event.user === owner;
    if (!isOwner && !store.personBySlack(event.user)) return reply(`You're not on this Helix. Ask <@${owner}> for an invite.`);
    if (event.kind !== 'command') return;
    const [sub, ...args] = event.text.trim().split(/\s+/);
    if (sub === 'invite') return reply(isOwner ? await inviteCommand(transport, opts, args) : `Only <@${owner}> invites people to this Helix.`);
    if (sub === 'link') return reply(isOwner ? link(store, args) : `Only <@${owner}> links Slack users to people on this Helix.`);
    if (sub === 'notify') return reply(notifyCommand(store, event.user, args));
    return reply(USAGE);
  });
}

/** /helix notify off|on: whether the sender's jobs post their progress to them. */
function notifyCommand(store: Store, user: string, args: string[]): string {
  const name = store.personBySlack(user);
  // Only the owner gets here without a link.
  if (!name) return 'Your Slack user is linked to no person on this Helix, so no job posts to you: /helix link @you <person> first.';
  if (args.length !== 1 || (args[0] !== 'on' && args[0] !== 'off')) return USAGE;
  store.setNotify(name, args[0] === 'on');
  return args[0] === 'on' ? 'Job notifications are on: each of your jobs posts its progress to a thread in our DM.' : 'Job notifications are off. /helix notify on starts them again.';
}

/** What a job that just started or ended says in its thread; nothing for a state no one is told of. */
function progress(job: HelixJob): string | undefined {
  if (job.state === 'running') return job.animus_job ? `Job ${job.id} resumed` : `Job ${job.id} started: ${job.title} (${job.repo})`;
  if (job.state !== 'ended') return undefined;
  if (job.outcome === 'needs-input') return `Job ${job.id} needs input: ${job.question}\nAnswer it with animus answer ${job.id} "<your answer>"`;
  if (job.pr) return `Job ${job.id} opened a pull request: ${job.pr}`;
  return `Job ${job.id} failed: ${job.reason ?? job.outcome}`;
}

/**
 * The supervisor's notify for a Slack bot: a linked person's job posts each
 * step to one DM thread of its own, the first post opening it, unless the
 * person turned notifications off. Posts go out one at a time, so a job that
 * ends at once still finds the thread its start opened.
 */
export function slackNotifier(transport: Pick<Transport, 'dm' | 'post'>, store: Store, say: (line: string) => void = () => {}): (job: HelixJob) => void {
  let last = Promise.resolve();
  const post = async (job: HelixJob, text: string, user: string) => {
    const thread = store.slackThread(job.id);
    if (thread) { await transport.post(thread.channel, text, thread.ts); return; }
    const channel = await transport.dm(user);
    store.putSlackThread(job.id, { channel, ts: await transport.post(channel, text) });
  };
  return (job) => {
    // Who is told, and whether, is settled when it happens, not when the post goes out.
    const text = progress(job);
    const user = store.slackOf(job.person);
    if (!text || !user || !store.notifies(job.person)) return;
    last = last.then(() => post(job, text, user)).catch((err: unknown) => say(`Slack: job ${job.id}'s post failed: ${(err as Error).message}`));
  };
}

/** A Slack user from a mention, which Slack hands over as <@U123|name> when the command escapes users, or a bare id. */
function mention(arg = ''): { user: string; name?: string } {
  const m = /^<@([^|>]+)(?:\|([^>]*))?>$/.exec(arg);
  return m ? { user: m[1]!, ...(m[2] ? { name: m[2] } : {}) } : { user: arg };
}

/** /helix invite @user <github-login>: the person is named as Slack names the user. */
async function inviteCommand(transport: Transport, opts: Core, args: string[]): Promise<string> {
  const github = args[1];
  if (!args[0] || !github || args.length > 2) return INVITE_USAGE;
  // Slack may leave the name out of a mention; the login names the person then.
  const { user, name = github } = mention(args[0]);
  try {
    await slackInvite(transport, opts, name, { github, slack: user });
  } catch (err) {
    if (err instanceof AnimusError) return `The invite was not sent: ${err.message}`;
    throw err;
  }
  return `Sent <@${user}> an invite to join as ${name} with the GitHub login ${github}.`;
}

/**
 * Makes an invite for a Slack user and DMs it to them: Tailscale first, then
 * one line that installs Animus where it is missing and joins. The code is
 * only in that DM. Both /helix invite and helix invite --slack come here.
 */
export async function slackInvite(transport: Pick<Transport, 'dm' | 'post'>, opts: Core, name: string, who: { github?: string; slack: string }): Promise<{ code: string; expires: string }> {
  const url = opts.config.url;
  if (!url) throw new AnimusError('config.yaml has no url, the address people reach Helix at, which the join line needs');
  const made = invite(opts.store, name, who);
  const channel = await transport.dm(who.slack);
  await transport.post(channel, [
    `You're invited to Helix as ${name}, with the GitHub login ${who.github}.`,
    `1. Connect Tailscale first: Helix is at ${url}, on the tailnet.`,
    '2. Then paste this in a terminal. It installs Animus if it is not there, and joins:',
    '```',
    `curl -fsSL ${INSTALL} | bash -s -- join ${url} ${made.code}`,
    '```',
    `The code works once, for ${INVITE_HOURS} hours.`,
  ].join('\n'));
  return made;
}

/** /helix link @user <person>: links someone who joined before their Slack user was known. */
function link(store: Store, args: string[]): string {
  const { user } = mention(args[0]);
  const name = args[1];
  if (!SLACK_USER.test(user) || !name || args.length > 2) return USAGE;
  if (!store.person(name)) return `Helix has no person named ${name}.`;
  store.linkSlack(name, user);
  return `Linked <@${user}> to ${name}.`;
}
