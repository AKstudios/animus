// The Slack bot's core: what it does with each event Slack sends, through a
// transport (slack-api.ts), so tests drive it without Slack. A Slack user with
// no Slack link is told, privately, to ask the owner for an invite, and
// nothing they send is kept. The owner may use the bot without a link.
import { AnimusError } from '../../plugin/src/proc.ts';
import { SOURCE } from '../../plugin/src/setup.ts';
import type { Config } from './config.ts';
import { INVITE_HOURS, invite } from './join.ts';
import { SLACK_USER, type Transport } from './slack-api.ts';
import type { Store } from './store.ts';

const USAGE = 'Usage: /helix invite @user <github-login>, or /helix link @user <person>';
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
    return reply(USAGE);
  });
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
