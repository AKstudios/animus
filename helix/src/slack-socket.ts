// The Slack bot's link inside `helix serve`: Socket Mode on Node's own
// WebSocket (docs/adr/0002), so Helix opens no port for Slack. Each envelope
// is acked the moment it arrives, inside Slack's three seconds, and only then
// is its event handed to the bot's core. A socket Slack drops or asks to
// refresh is replaced; nothing that came while it was down is replayed.
import { existsSync } from 'node:fs';
import { AnimusError } from '../../plugin/src/proc.ts';
import { envFileVars, type Config } from './config.ts';
import { SLACK_API, slackCall, slackEnvFile, slackWeb, type SlackEvent, type Transport } from './slack-api.ts';

const MAX_RETRY_MS = 30_000;

/** The transport, and a way to end it when Helix stops. */
export type SlackBot = Transport & { close(): void };

/** The part of a Socket Mode envelope the bot reads. */
type Envelope = {
  envelope_id?: string; type?: string;
  payload?: {
    user_id?: string; channel_id?: string; text?: string; response_url?: string;
    event?: { type?: string; subtype?: string; bot_id?: string; channel_type?: string; user?: string; channel?: string; text?: string; thread_ts?: string };
    user?: { id?: string }; channel?: { id?: string }; actions?: { action_id?: string; value?: string }[];
  };
};

/** The event an envelope carries for the core, if it is one the bot answers. */
function eventOf(e: Envelope): SlackEvent | undefined {
  const p = e.payload;
  if (e.type === 'slash_commands' && p?.user_id && p.channel_id && p.response_url) return { kind: 'command', user: p.user_id, channel: p.channel_id, text: p.text ?? '', responseUrl: p.response_url };
  const a = p?.actions?.[0];
  if (e.type === 'interactive' && a?.action_id && a.value && p?.user?.id && p.channel?.id && p.response_url) return { kind: 'action', user: p.user.id, channel: p.channel.id, action: a.action_id, value: a.value, responseUrl: p.response_url };
  const m = p?.event;
  const thread = m?.thread_ts ? { thread: m.thread_ts } : {};
  // Only what a person writes in the bot's DM: never the bot's own posts, which would be answered forever, nor edits and joins.
  if (e.type === 'events_api' && m?.type === 'message' && m.channel_type === 'im' && !m.subtype && !m.bot_id && m.user && m.channel) return { kind: 'message', user: m.user, channel: m.channel, text: m.text ?? '', ...thread };
  // In a channel the bot only hears the messages that name it.
  if (e.type === 'events_api' && m?.type === 'app_mention' && !m.bot_id && m.user && m.channel) return { kind: 'message', user: m.user, channel: m.channel, text: m.text ?? '', mentioned: true, ...thread };
  return undefined;
}

/** Connects to Slack when config.yaml turns the bot on; with it off, nothing is opened and there is no bot. */
export function startSlack(config: Config, opts: { say: (line: string) => void; api?: string }): SlackBot | undefined {
  if (!config.slack?.enabled) return undefined;
  const file = slackEnvFile();
  const env = existsSync(file) ? envFileVars(file) : {};
  const app = env.SLACK_APP_TOKEN;
  const bot = env.SLACK_BOT_TOKEN;
  if (!app || !bot) throw new AnimusError(`config.yaml turns Slack on, but ${file} does not hold both of its tokens: run helix slack setup`);
  const { say } = opts;
  const api = opts.api ?? SLACK_API;
  let handle: ((event: SlackEvent) => Promise<void>) | undefined;
  let socket: WebSocket | undefined;
  let closed = false;
  let failures = 0;
  let timer: NodeJS.Timeout | undefined;

  const again = () => {
    if (closed) return;
    // At once after a socket that worked, then backing off while Slack cannot be reached.
    const ms = failures ? Math.min(1000 * 2 ** (failures - 1), MAX_RETRY_MS) : 0;
    failures++;
    timer = setTimeout(() => { void connect(); }, ms);
  };

  const connect = async () => {
    let ws: WebSocket;
    try {
      // Each socket needs a URL of its own, good for one connection.
      const { url } = await slackCall(app, 'apps.connections.open', {}, api);
      if (closed) return;
      ws = new WebSocket(String(url));
    } catch (err) { say(`Slack: no socket: ${(err as Error).message}`); return again(); }
    socket = ws;
    ws.addEventListener('message', (m) => {
      let e: Envelope;
      try { e = JSON.parse(String(m.data)) as Envelope; } catch { return; }
      if (e.envelope_id) ws.send(JSON.stringify({ envelope_id: e.envelope_id }));
      if (e.type === 'hello') { failures = 0; say('Slack: connected'); }
      // Slack will end this socket soon; its close opens the next.
      if (e.type === 'disconnect') ws.close();
      const event = eventOf(e);
      const core = handle;
      if (event && core) Promise.resolve().then(() => core(event)).catch((err: unknown) => say(`Slack: the ${event.kind} from ${event.user} failed: ${(err as Error).message}`));
    });
    ws.addEventListener('close', () => {
      if (socket !== ws) return;
      socket = undefined;
      if (!closed) say('Slack: the socket closed, opening another');
      again();
    });
  };

  void connect();
  return {
    onEvent: (h) => { handle = h; },
    ...slackWeb(bot, api),
    close: () => { closed = true; clearTimeout(timer); socket?.close(); },
  };
}
