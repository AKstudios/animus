// The Slack bot's core: what it does with each event Slack sends, through a
// transport (slack-api.ts), so tests drive it without Slack. A Slack user with
// no Slack link is told, privately, to ask the owner for an invite, and
// nothing they send is kept. The owner is the Slack user linked to the owner
// person. A linked person's jobs post their progress to them, one DM thread
// per job.
import { AnimusError } from '../../plugin/src/proc.ts';
import { SOURCE } from '../../plugin/src/setup.ts';
import type { Config } from './config.ts';
import { DISCARD, OPEN, PICK, SUBMIT, type Drafts } from './drafts.ts';
import { INVITE_HOURS, invite } from './join.ts';
import { isOwner } from './owner.ts';
import { SLACK_USER, type SlackEvent, type Transport } from './slack-api.ts';
import type { HelixJob, Store } from './store.ts';
import type { Supervisor } from './supervisor.ts';
import { animusVersion } from '../../plugin/src/version.ts';

const USAGE = 'Usage: /helix draft <what you want, with links>, /helix project <name>, /helix jobs, /helix status, /helix invite @user <github-login>, /helix link @user <person>, /helix notify off|on, or /helix help';
/** /helix help, and what an empty or unknown command gets: every command, one line each; the owner's only to the owner. */
export function helpText(byOwner: boolean): string {
  return [
    '*Helix* turns a written request into a pull request. Commands:',
    '`/helix draft <what you want, with links>`: draft a job\'s spec in a thread. Reply there to change it, then press Submit. `@Helix <text>` in a channel does the same.',
    '`/helix jobs`: your queued, running and waiting jobs, with their threads.',
    '`/helix status`: how busy Helix is and which version it runs.',
    '`/helix project <name>`: the project drafts in this channel are for.',
    '`/helix notify off|on`: stop or start your jobs posting their progress to you.',
    ...(byOwner ? [
      '`/helix invite @user <github-login>`: invite someone (owner only).',
      '`/helix link @user <person>`: link a Slack user to someone who already joined (owner only).',
    ] : []),
    '`/helix help`: this list.',
    'In a job\'s thread: reply to answer its question, or press Cancel.',
  ].join('\n');
}
const INVITE_USAGE = 'An invite sent on Slack names their GitHub login, so only a token that signs in as it is taken: /helix invite @user <github-login>';
const INSTALL = `https://raw.githubusercontent.com/${SOURCE.repo}/${SOURCE.ref}/install.sh`;

type Core = { store: Store; config: Config };

/** What answering, cancelling and submitting a job go through, the same calls `animus answer`, `animus cancel` and `animus run` reach on Helix. */
type Jobs = Pick<Supervisor, 'answer' | 'cancel' | 'submit'>;

const CANCEL = 'cancel_job';
const cancelBlocks = (id: number, text: string) => [
  { type: 'section', text: { type: 'mrkdwn', text } },
  { type: 'actions', elements: [{ type: 'button', action_id: CANCEL, value: String(id), text: { type: 'plain_text', text: 'Cancel job' } }] },
];

/** Where a job's thread is in Slack, for a link. */
const threadLink = (t: { channel: string; ts: string }) => `https://slack.com/app_redirect?channel=${t.channel}&message_ts=${t.ts}`;

/**
 * Answers what reaches the bot. The owner and their Slack link are read at
 * each event, so helix owner or a new link changes who it is. Without
 * `supervisor`, jobs can be neither answered nor cancelled from Slack.
 */
export function slackBot(transport: Transport, opts: Core & { supervisor?: Jobs; drafts?: Drafts }): void {
  const { store, config, supervisor, drafts } = opts;
  transport.onEvent(async (event) => {
    const ownerUser = config.owner ? store.slackOf(config.owner) : undefined;
    const owner = ownerUser ? `<@${ownerUser}>` : 'the owner';
    // A command or button may come from a channel the bot is not in, where Slack refuses postEphemeral; its response_url works anywhere.
    const reply = (text: string) => event.kind === 'message' ? transport.ephemeral(event.channel, event.user, text) : transport.respond(event.responseUrl, text);
    const person = store.personBySlack(event.user);
    if (!person) return reply(`You're not on this Helix. Ask ${owner} for an invite.`);
    const byOwner = isOwner(config, person);
    const draft = async (text: string) => {
      if (!drafts) return;
      if (!text) return reply(USAGE);
      const said = await drafts.start(person, event.user, event.channel, text);
      if (said) await reply(said);
    };
    if (event.kind === 'message') {
      const text = event.text.replace(/<@[A-Z0-9]+>/g, '').trim();
      // A mention outside a thread asks for a draft; one in an open draft's thread revises it, in a job's may answer it.
      if (event.mentioned && !event.thread) return draft(text);
      const open = event.thread && drafts ? store.draftOfThread(event.channel, event.thread) : undefined;
      if (open && drafts && OPEN.includes(open.state)) {
        // As with a job's thread: any reply in a DM, in a channel only one to the bot.
        if (!(event.mentioned || event.channel.startsWith('D'))) return;
        const said = await drafts.reply(person, open, text);
        return said ? reply(said) : undefined;
      }
      return supervisor && answer(transport, store, supervisor, event, person);
    }
    if (event.kind === 'action') {
      if (event.action === PICK && drafts) {
        const said = await drafts.pick(person, event.value);
        return said ? reply(said) : undefined;
      }
      if ((event.action === SUBMIT || event.action === DISCARD) && drafts) {
        const said = event.action === DISCARD ? await drafts.discard(person, event.user, event.value)
          : supervisor ? await drafts.submit(person, event.value, supervisor) : 'Helix takes no jobs from this Slack bot.';
        return said ? reply(said) : undefined;
      }
      if (event.action !== CANCEL || !supervisor) return;
      const job = store.get(Number(event.value));
      if (!job) return reply(`There is no job ${event.value}.`);
      if (!byOwner && job.person !== person) return reply(`Only ${job.person} or ${owner} may cancel job ${job.id}.`);
      try {
        supervisor.cancel(job.person, job.id);
      } catch (err) {
        if (err instanceof AnimusError) return reply(err.message);
        throw err;
      }
      const thread = store.slackThread(job.id);
      if (thread) await transport.post(thread.channel, `Job ${job.id} was cancelled by <@${event.user}>.`, thread.ts);
      return;
    }
    const [sub, ...args] = event.text.trim().split(/\s+/);
    if (sub === 'jobs') return reply(jobsCommand(store, person));
    if (sub === 'status') return reply(statusCommand(store, config));
    if (sub === 'invite') return reply(byOwner ? await inviteCommand(transport, opts, args) : `Only ${owner} invites people to this Helix.`);
    if (sub === 'link') return reply(byOwner ? link(store, args) : `Only ${owner} links Slack users to people on this Helix.`);
    if (sub === 'notify') return reply(notifyCommand(store, person, args));
    if (sub === 'draft') return draft(event.text.trim().slice(sub.length).trim());
    if (sub === 'project') return reply(projectCommand(store, person, event.channel, args));
    return reply(helpText(byOwner));
  });
}

/**
 * A reply in a job's thread answers the job when it is its person's and the
 * job waits for an answer: any reply in a DM (Slack's DM channel ids start
 * with D), or in a channel one that mentions the bot. Anything else is not
 * for the bot and is ignored without a word.
 */
async function answer(transport: Transport, store: Store, supervisor: Jobs, event: Extract<SlackEvent, { kind: 'message' }>, person: string): Promise<void> {
  if (!event.thread || !(event.mentioned || event.channel.startsWith('D'))) return;
  const id = store.jobOfThread(event.channel, event.thread);
  const job = id === undefined ? undefined : store.get(id);
  const text = event.text.replace(/<@[A-Z0-9]+>/g, '').trim();
  if (!job || job.person !== person || job.state !== 'ended' || job.outcome !== 'needs-input' || !text) return;
  supervisor.answer(person, job.id, text);
  await transport.post(event.channel, `Got your answer: job ${job.id} resumes.`, event.thread);
}

/** /helix jobs: the person's jobs that are not over or wait for an answer, each with where to follow it. */
function jobsCommand(store: Store, person: string): string {
  const mine = [...store.inState('running'), ...store.inState('queued'), ...store.inState('ended').filter((j) => j.outcome === 'needs-input')].filter((j) => j.person === person);
  if (!mine.length) return 'You have no queued, running or waiting jobs.';
  return mine.map((j) => {
    const thread = store.slackThread(j.id);
    const where = thread ? ` ${threadLink(thread)}` : j.pr ? ` ${j.pr}` : '';
    return `Job ${j.id} ${j.state === 'ended' ? 'needs input' : j.state}: ${j.title} (${j.repo})${where}`;
  }).join('\n');
}

/** /helix status: how busy this Helix is, and its Animus version. */
function statusCommand(store: Store, config: Config): string {
  return `Helix ${animusVersion()}: ${store.inState('running').length} of ${config.slots} slots in use, ${store.inState('queued').length} queued.`;
}

/** /helix notify off|on: whether the sender's jobs post their progress to them. */
function notifyCommand(store: Store, name: string, args: string[]): string {
  if (args.length !== 1 || (args[0] !== 'on' && args[0] !== 'off')) return USAGE;
  store.setNotify(name, args[0] === 'on');
  return args[0] === 'on' ? 'Job notifications are on: each of your jobs posts its progress to a thread in our DM.' : 'Job notifications are off. /helix notify on starts them again.';
}

/** /helix project <name>: the project drafts started in this channel are for, when their message links no issue of another. */
function projectCommand(store: Store, person: string, channel: string, args: string[]): string {
  const name = args[0];
  if (!name || args.length > 1) return USAGE;
  if (store.project(name)?.state !== 'ready') return `Helix has no project named ${name}.`;
  store.setChannelProject(channel, name);
  store.record(person, 'channel-project', { project: name });
  return `Drafts started here are for ${name} now, unless their message links an issue of another project.`;
}

/** What a job that just started or ended says in its thread; nothing for a state no one is told of. */
function progress(job: HelixJob): string | undefined {
  if (job.state === 'running') return job.animus_job ? `Job ${job.id} resumed` : `Job ${job.id} started: ${job.title} (${job.repo})`;
  if (job.state !== 'ended') return undefined;
  if (job.outcome === 'needs-input') return `Job ${job.id} needs input: ${job.question}\nReply in this thread to answer it, or run animus answer ${job.id} "<your answer>"`;
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
    // The opening post carries the button, so the thread can always cancel its job.
    store.putSlackThread(job.id, { channel, ts: await transport.post(channel, text, undefined, cancelBlocks(job.id, text)) });
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
  const lan = opts.config.lan_url;
  await transport.post(channel, [
    `You're invited to Helix as ${name}, with the GitHub login ${who.github}.`,
    `1. Connect Tailscale first: Helix is at ${url}, on the tailnet.`,
    '2. Then paste this in a terminal. It installs Animus if it is not there, and joins:',
    '```',
    `curl -fsSL ${INSTALL} | bash -s -- join ${url} ${made.code}`,
    '```',
    ...(lan ? [
      'In the office with Tailscale off, paste this instead:',
      '```',
      `curl -fsSL ${INSTALL} | bash -s -- join ${lan} ${made.code}`,
      '```',
    ] : []),
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
