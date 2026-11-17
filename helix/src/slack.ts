// The Slack bot's core: what it does with each event Slack sends, through a
// transport (slack-api.ts), so tests drive it without Slack. A Slack user with
// no Slack link is told, privately, to ask the owner for an invite, and
// nothing they send is kept. The owner may use the bot without a link.
import type { Config } from './config.ts';
import { SLACK_USER, type Transport } from './slack-api.ts';
import type { Store } from './store.ts';

const USAGE = 'Usage: /helix link @user <person>';

/** Answers what reaches the bot. The owner is read from config at each event, so a config edit changes it. */
export function slackBot(transport: Transport, opts: { store: Store; config: Config }): void {
  const { store, config } = opts;
  transport.onEvent(async (event) => {
    const owner = config.slack?.owner ?? '';
    const reply = (text: string) => transport.ephemeral(event.channel, event.user, text);
    const isOwner = event.user === owner;
    if (!isOwner && !store.personBySlack(event.user)) return reply(`You're not on this Helix. Ask <@${owner}> for an invite.`);
    if (event.kind !== 'command') return;
    const [sub, ...args] = event.text.trim().split(/\s+/);
    if (sub === 'link') return reply(isOwner ? link(store, args) : `Only <@${owner}> links Slack users to people on this Helix.`);
    return reply(USAGE);
  });
}

/** /helix link @user <person>: links someone who joined before their Slack user was known. */
function link(store: Store, args: string[]): string {
  // Slack hands a mention over as <@U123|name> when the command escapes users.
  const user = /^<@([^|>]+)(?:\|[^>]*)?>$/.exec(args[0] ?? '')?.[1] ?? args[0] ?? '';
  const name = args[1];
  if (!SLACK_USER.test(user) || !name || args.length > 2) return USAGE;
  if (!store.person(name)) return `Helix has no person named ${name}.`;
  store.linkSlack(name, user);
  return `Linked <@${user}> to ${name}.`;
}
