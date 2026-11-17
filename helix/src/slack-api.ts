// Slack's Web API on Node's own fetch, with no Slack SDK (docs/adr/0002), and
// the transport the bot's core talks to Slack through: events in, posts out.
// `helix slack setup` is here too: it tries the owner's two tokens against
// Slack and keeps them beside the people's credentials.
import { chmodSync, mkdirSync, writeFileSync } from 'node:fs';
import { dirname, join } from 'node:path';
import { AnimusError } from '../../plugin/src/proc.ts';
import { helixHome, loadConfig, updateConfig } from './config.ts';
import type { Store } from './store.ts';

export const SLACK_API = 'https://slack.com/api';

/** A Slack user id, as in U0123ABCD. */
export const SLACK_USER = /^[UW][A-Z0-9]{2,}$/;

/** The bot token (xoxb-) and the app token (xapp-), out of config.yaml. */
export const slackEnvFile = () => join(helixHome(), 'credentials', 'slack.env');

/**
 * What reaches the bot from Slack: a /helix command, a message written to it
 * (in a thread when it has one; mentioned when it is a channel message that
 * names the bot), or a press of a button the bot posted.
 */
export type SlackEvent =
  | { kind: 'command'; user: string; channel: string; text: string; responseUrl: string }
  | { kind: 'message'; user: string; channel: string; text: string; thread?: string; mentioned?: true }
  | { kind: 'action'; user: string; channel: string; action: string; value: string; responseUrl: string };

/** How the bot's core talks to Slack. Tests give it a fake that records what is posted. */
export type Transport = {
  /** Calls handle with each event Slack sends, once it has been acknowledged. */
  onEvent(handle: (event: SlackEvent) => Promise<void>): void;
  /** Posts to a channel, or into a thread of it, with Block Kit blocks if given; returns the message's ts, which names a thread. */
  post(channel: string, text: string, thread?: string, blocks?: unknown[]): Promise<string>;
  /** The DM channel with a Slack user. */
  dm(user: string): Promise<string>;
  /** A reply in a channel that only this user sees. Slack refuses it where the bot is not a member, so only for the bot's own DMs. */
  ephemeral(channel: string, user: string, text: string): Promise<void>;
  /** A private reply to a command, at the response_url Slack gave it, which works in any channel. */
  respond(responseUrl: string, text: string): Promise<void>;
};

/** Calls a Web API method; Slack's refusal, such as invalid_auth, is the error's message. */
export async function slackCall(token: string, method: string, body: Record<string, unknown> = {}, api = SLACK_API): Promise<Record<string, unknown>> {
  let res: Response;
  try {
    res = await fetch(`${api}/${method}`, { method: 'POST', headers: { authorization: `Bearer ${token}`, 'content-type': 'application/json; charset=utf-8' }, body: JSON.stringify(body) });
  } catch (err) { throw new AnimusError(`Slack could not be reached: ${(err as Error).message}`); }
  const answer = (await res.json().catch(() => undefined)) as Record<string, unknown> | undefined;
  if (answer?.ok !== true) throw new AnimusError(typeof answer?.error === 'string' ? answer.error : `HTTP ${res.status}`);
  return answer;
}

/** The transport's way out: Web API calls with the bot token. */
export const slackWeb = (bot: string, api = SLACK_API): Omit<Transport, 'onEvent'> => ({
  post: async (channel, text, thread, blocks) => String((await slackCall(bot, 'chat.postMessage', { channel, text, ...(thread ? { thread_ts: thread } : {}), ...(blocks ? { blocks } : {}) }, api)).ts),
  dm: async (user) => String(((await slackCall(bot, 'conversations.open', { users: user }, api)).channel as { id: string }).id),
  ephemeral: async (channel, user, text) => { await slackCall(bot, 'chat.postEphemeral', { channel, user, text }, api); },
  respond: async (responseUrl, text) => {
    // The URL is the authority, so no token goes with it; Slack answers plain text, not JSON.
    const res = await fetch(responseUrl, { method: 'POST', headers: { 'content-type': 'application/json; charset=utf-8' }, body: JSON.stringify({ response_type: 'ephemeral', text }) });
    if (!res.ok) throw new AnimusError(`Slack refused the reply: HTTP ${res.status} ${await res.text()}`);
  },
});

/** The owner, whose Slack user setup links; refused before anything is asked when there is none. */
export function slackOwner(): string {
  const { owner } = loadConfig();
  if (!owner) throw new AnimusError('helix slack setup links the owner\'s Slack user, and this Helix has no owner: helix owner <person> first');
  return owner;
}

/**
 * Tries both tokens against Slack, then keeps them in slack.env, turns the bot
 * on in config.yaml and links the Slack user given to the owner. A token Slack
 * refuses leaves nothing written. Returns the workspace the bot token is for.
 */
export async function slackSetup(store: Store, answers: { bot: string; app: string; user: string }, api = SLACK_API): Promise<{ team?: string }> {
  const owner = slackOwner();
  const user = answers.user.trim();
  if (!SLACK_USER.test(user)) throw new AnimusError(`${user} is not a Slack user id: one starts with U, as in U0123ABCD (in Slack, your profile, ⋮, Copy member ID)`);
  const tokens = { bot: answers.bot.trim(), app: answers.app.trim() };
  const tried = async (what: keyof typeof tokens, method: string) => {
    // One line in slack.env each: anything but printable characters is no token.
    if (!/^[\x21-\x7e]+$/.test(tokens[what])) throw new AnimusError(`the ${what} token is empty or holds spaces`);
    try { return await slackCall(tokens[what], method, {}, api); } catch (err) { throw new AnimusError(`Slack refused the ${what} token: ${(err as Error).message}. Nothing was written`); }
  };
  const bot = await tried('bot', 'auth.test');
  // Opens a Socket Mode link only to see the app token work; one left unused ends by itself.
  await tried('app', 'apps.connections.open');
  const file = slackEnvFile();
  mkdirSync(dirname(file), { recursive: true, mode: 0o700 });
  writeFileSync(file, `SLACK_BOT_TOKEN=${tokens.bot}\nSLACK_APP_TOKEN=${tokens.app}\n`, { mode: 0o600 });
  chmodSync(file, 0o600);
  updateConfig({ slack: { enabled: true } });
  store.linkSlack(owner, user);
  return typeof bot.team === 'string' ? { team: bot.team } : {};
}
