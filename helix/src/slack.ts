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
import { jobIsOver, type Supervisor } from './supervisor.ts';
import { animusVersion } from '../../plugin/src/version.ts';

const USAGE = 'Usage: /animus draft <what you want, with links>, /animus project <name>, /animus jobs, /animus job <id>, /animus cancel <id>, /animus me, /animus status, /animus invite @user <github-login>, /animus link @user <person>, /animus notify off|on, or /animus help';
/** /animus help, and what an empty or unknown command gets: every command, one line each; the owner's only to the owner. */
export function helpText(byOwner: boolean): string {
  return [
    '*Animus* turns a written request into a pull request. Commands:',
    '`/animus draft <what you want, with links>`: draft a job\'s spec in a thread. Reply there to change it, then press Submit. `@Animus <text>` in a channel does the same.',
    '`/animus jobs`: your queued, running and waiting jobs, with their threads.',
    '`/animus job <id>`: what one job is doing, or how it ended.',
    '`/animus cancel <id>`: cancel a queued or running job.',
    '`/animus me`: what Helix knows about you: your jobs, projects and page.',
    '`/animus status`: how busy Helix is and which version it runs.',
    '`/animus project <name>`: the project drafts in this channel are for.',
    '`/animus notify off|on`: stop or start your jobs posting their progress to you.',
    ...(byOwner ? [
      '`/animus invite @user <github-login>`: invite someone (owner only).',
      '`/animus link @user <person>`: link a Slack user to someone who already joined (owner only).',
    ] : []),
    '`/animus help`: this list.',
    'In a job\'s thread: reply to answer its question, or press Cancel.',
  ].join('\n');
}
const INVITE_USAGE = 'An invite sent on Slack names their GitHub login, so only a token that signs in as it is taken: /animus invite @user <github-login>';
const INSTALL = `https://raw.githubusercontent.com/${SOURCE.repo}/${SOURCE.ref}/install.sh`;

type Core = { store: Store; config: Config };

/** What answering, cancelling and submitting a job go through, the same calls `animus answer`, `animus cancel` and `animus run` reach on Helix. */
type Jobs = Pick<Supervisor, 'answer' | 'cancel' | 'submit' | 'progress'>;

const CANCEL = 'cancel_job';
const mrkdwn = (text: string) => ({ type: 'section', text: { type: 'mrkdwn', text } });

/** The state a job's card shows, in words. */
function stateWord(job: HelixJob): string {
  if (job.state === 'running') return 'Running';
  if (job.state === 'cancelled') return 'Cancelled';
  if (job.state !== 'ended') return 'Queued';
  if (job.outcome === 'needs-input') return 'Needs input';
  if (job.pr) return 'Pull request opened';
  return job.outcome === 'refused' ? 'Refused' : 'Failed';
}

/**
 * A job's card, the thread's opening post: title, project and number, state,
 * labelled links, and the Cancel button while the job can be cancelled. Never
 * the question or the reason; the thread's replies carry those. text is the
 * one line Slack shows in a notification.
 */
export function jobCard(job: HelixJob, config: Pick<Config, 'url' | 'lan_url'> = {}): { text: string; blocks: unknown[] } {
  const state = stateWord(job);
  const pages = ([[config.url, 'Tailscale'], [config.lan_url, 'office network']] as const)
    .filter(([base]) => base)
    .map(([base, label]) => `<${base!.replace(/\/+$/, '')}/jobs/${job.id}|${label}>`);
  return {
    text: `Job ${job.id}: ${job.title}, ${state}`,
    blocks: [
      { type: 'header', text: { type: 'plain_text', text: job.title.slice(0, 150) } },
      { type: 'context', elements: [{ type: 'mrkdwn', text: `Project ${job.repo}, job ${job.id}` }] },
      mrkdwn(`*State:* ${state}`),
      ...(pages.length ? [mrkdwn(`*Job page:* ${pages.join(', ')}`)] : []),
      ...(job.pr ? [mrkdwn(`*Pull request:* <${job.pr}|Open pull request>`)] : []),
      ...(jobIsOver(job) ? [] : [{ type: 'actions', elements: [{ type: 'button', action_id: CANCEL, value: String(job.id), text: { type: 'plain_text', text: 'Cancel job' } }] }]),
    ],
  };
}

/** What a job's thread is told of an event, with the detail the card leaves out; nothing for a start, a resume or a cancel, which others announce. */
export function jobReply(job: HelixJob): { text: string; blocks: unknown[] } | undefined {
  if (job.state !== 'ended') return undefined;
  const said = (text: string, detail?: string) => ({ text: detail ? `${text}\n${detail}` : text, blocks: [mrkdwn(text), ...(detail ? [mrkdwn(detail)] : [])] });
  if (job.outcome === 'needs-input') {
    const quote = (job.question ?? '').split('\n').map((l) => `> ${l}`).join('\n');
    return said(`Job ${job.id} needs input. Reply in this thread to answer it, or run \`animus answer ${job.id} "<your answer>"\`.`, quote);
  }
  if (job.pr) return said(`Job ${job.id} opened a pull request: <${job.pr}|Open pull request>`);
  const reason = (job.reason ?? job.outcome ?? '').replace(/```/g, "'''");
  return said(`Job ${job.id} ${job.outcome === 'refused' ? 'was refused' : 'failed'}:`, `\`\`\`\n${reason}\n\`\`\``);
}

/** Where a job's page is, at each address Helix has set; never with a token. */
export const jobLinks = (config: Pick<Config, 'url' | 'lan_url'>, id: number): string[] =>
  ([[config.url, 'Tailscale'], [config.lan_url, 'office network']] as const)
    .filter(([base]) => base)
    .map(([base, label]) => `${label}: ${base!.replace(/\/+$/, '')}/jobs/${id}`);

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
      const said = await cancelJob(transport, store, config, supervisor, owner, byOwner, person, event.user, Number(event.value), event.value);
      return said ? reply(said) : undefined;
    }
    const [sub, ...args] = event.text.trim().split(/\s+/);
    if (sub === 'jobs') return reply(jobsCommand(store, person));
    if (sub === 'me') return reply(await meCommand(store, config, person, byOwner, drafts));
    if (sub === 'job') return reply(jobCommand(store, supervisor, owner, byOwner, person, args[0]));
    if (sub === 'cancel') {
      if (!supervisor) return;
      const said = await cancelJob(transport, store, config, supervisor, owner, byOwner, person, event.user, jobNumber(args[0]), args[0] ?? '');
      return reply(said ?? `Job ${jobNumber(args[0])} was cancelled.`);
    }
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

/** A job number as typed, with or without a leading #; undefined for anything else. */
const jobNumber = (word = ''): number | undefined => /^#?\d+$/.test(word) ? Number(word.replace('#', '')) : undefined;

/**
 * What the Cancel button and /helix cancel share: cancels the job when `by` may
 * and tells its thread. Returns what to tell the sender when it did not,
 * nothing when it did.
 */
async function cancelJob(transport: Transport, store: Store, config: Config, supervisor: Jobs, owner: string, byOwner: boolean, person: string, user: string, id: number | undefined, typed: string): Promise<string | undefined> {
  const job = id === undefined ? undefined : store.get(id);
  if (!job) return `There is no job ${typed}.`;
  if (!byOwner && job.person !== person) return `Only ${job.person} or ${owner} may cancel job ${job.id}.`;
  if (jobIsOver(job)) {
    // A button left on an old message, or a command for a finished job: say so and take the thread's button off.
    const thread = store.slackThread(job.id);
    if (thread) { const card = jobCard(job, config); await transport.update(thread.channel, thread.ts, card.text, card.blocks); }
    return `Job ${job.id} has already ended.`;
  }
  try {
    supervisor.cancel(job.person, job.id);
  } catch (err) {
    if (err instanceof AnimusError) return err.message;
    throw err;
  }
  const thread = store.slackThread(job.id);
  if (thread) await transport.post(thread.channel, `Job ${job.id} was cancelled by <@${user}>.`, thread.ts);
  return undefined;
}

/** /helix job <id>: one job of the sender's (any, for the owner) as the display shows it. */
function jobCommand(store: Store, supervisor: Jobs | undefined, owner: string, byOwner: boolean, person: string, word?: string): string {
  const id = jobNumber(word);
  const job = id === undefined ? undefined : store.get(id);
  if (!job || (!byOwner && job.person !== person)) return `There is no such job of yours: ${word ?? ''}`.trim();
  const lines = [`Job ${job.id}: ${job.title}`, `Project ${job.repo}, person ${job.person}`, `State: ${job.state}`];
  if (job.state === 'running') {
    const p = supervisor?.progress(job);
    if (p && job.started && p.at >= job.started) lines.push(`Stage ${p.stage}, ${p.who} working`);
  }
  if ((job.state === 'queued' || job.state === 'waiting') && job.waiting) lines.push(`Waiting: ${job.waiting}`);
  if (job.state === 'ended') {
    lines.push(`Outcome: ${job.outcome}`);
    if (job.outcome === 'needs-input') lines.push(`Question: ${job.question}`);
    else if (!job.pr) lines.push(`Reason: ${job.reason ?? job.outcome}`);
  }
  if (job.pr) lines.push(`Pull request: ${job.pr}`);
  const thread = store.slackThread(job.id);
  if (thread) lines.push(`Thread: ${threadLink(thread)}`);
  return lines.join('\n');
}

/** /helix jobs: the person's jobs that are not over or wait for an answer, each with where to follow it. */
function jobsCommand(store: Store, person: string): string {
  const mine = [...store.inState('running'), ...store.inState('queued'), ...store.inState('waiting'), ...store.inState('ended').filter((j) => j.outcome === 'needs-input')].filter((j) => j.person === person);
  if (!mine.length) return 'You have no queued, running or waiting jobs.';
  return mine.map((j) => {
    const thread = store.slackThread(j.id);
    const where = thread ? ` ${threadLink(thread)}` : j.pr ? ` ${j.pr}` : '';
    return `Job ${j.id} ${j.state === 'ended' ? 'needs input' : j.state}: ${j.title} (${j.repo})${where}`;
  }).join('\n');
}

/** /helix me: what Helix knows about the sender. Never a token or credential. */
async function meCommand(store: Store, config: Config, name: string, byOwner: boolean, drafts?: Drafts): Promise<string> {
  const me = store.person(name);
  const projects = drafts ? await drafts.projects(name) : store.projects().filter((p) => p.state === 'ready').map((p) => p.name);
  const ended = store.inState('ended').filter((j) => j.person === name && j.outcome !== 'needs-input').sort((a, b) => b.id - a.id).slice(0, 5);
  const pages = ([[config.url, 'Tailscale'], [config.lan_url, 'office network']] as const)
    .filter(([base]) => base)
    .map(([base, label]) => `${label}: ${base!.replace(/\/+$/, '')}/people/${name}`);
  return [
    `*${name}*${me?.github ? `, GitHub ${me.github}` : ''}${byOwner ? ', the owner' : ''}`,
    `Joined: ${me?.joined ?? 'unknown'}`,
    `Job notifications: ${store.notifies(name) ? 'on' : 'off'}`,
    `Projects you may submit to: ${projects.join(', ') || 'none'}`,
    '*Jobs*',
    jobsCommand(store, name),
    '*Last ended jobs*',
    ...(ended.length ? ended.map((j) => `Job ${j.id} ${j.pr ? `opened ${j.pr}` : `failed: ${j.reason ?? j.outcome}`}: ${j.title} (${j.repo})`) : ['none']),
    ...pages,
  ].join('\n');
}

/** /helix status: how busy this Helix is, and its Animus version. */
function statusCommand(store: Store, config: Config): string {
  return `Helix ${animusVersion()}: ${store.inState('running').length} of ${config.slots} slots in use, ${store.inState('queued').length} queued.`;
}

/** /helix notify off|on: whether the sender's jobs post their progress to them. */
function notifyCommand(store: Store, name: string, args: string[]): string {
  if (args.length !== 1 || (args[0] !== 'on' && args[0] !== 'off')) return USAGE;
  store.setNotify(name, args[0] === 'on');
  return args[0] === 'on' ? 'Job notifications are on: each of your jobs posts its progress to a thread in our DM.' : 'Job notifications are off. /animus notify on starts them again.';
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

/**
 * The supervisor's notify for a Slack bot: a linked person's job opens one DM
 * thread of its own with its card, which is updated in place at each change,
 * and the thread is replied to for the events that have detail to say, unless
 * the person turned notifications off. Posts go out one at a time, so a job
 * that ends at once still finds the thread its start opened.
 */
export function slackNotifier(transport: Pick<Transport, 'dm' | 'post' | 'update'>, store: Store, say: (line: string) => void = () => {}, config: Pick<Config, 'url' | 'lan_url'> = {}): (job: HelixJob) => void {
  let last = Promise.resolve();
  const post = async (job: HelixJob, user: string) => {
    // Only a start, a resume or an end is shown; a queued or waiting job is not told of.
    if (job.state !== 'running' && job.state !== 'ended' && job.state !== 'cancelled') return;
    const card = jobCard(job, config);
    const reply = jobReply(job);
    let thread = store.slackThread(job.id);
    if (thread) {
      await transport.update(thread.channel, thread.ts, card.text, card.blocks);
    } else {
      // A cancelled job that never had a thread is not given one.
      if (job.state === 'cancelled') return;
      const channel = await transport.dm(user);
      thread = { channel, ts: await transport.post(channel, card.text, undefined, card.blocks) };
      store.putSlackThread(job.id, thread);
    }
    if (reply) await transport.post(thread.channel, reply.text, thread.ts, reply.blocks);
  };
  return (job) => {
    // Who is told, and whether, is settled when it happens, not when the post goes out.
    const user = store.slackOf(job.person);
    if (!user || !store.notifies(job.person)) return;
    last = last.then(() => post(job, user)).catch((err: unknown) => say(`Slack: job ${job.id}'s post failed: ${(err as Error).message}`));
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
