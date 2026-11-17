// The owner: the one person on Helix who may invite and remove people and act
// on any project or job, from their own laptop with their own Helix token.
// Only `helix owner` on the machine names them: shell access is the root of
// trust, so there is no second token or role table.
import { AnimusError } from '../../plugin/src/proc.ts';
import { configFile, loadConfig, updateConfig, type Config } from './config.ts';
import type { Store } from './store.ts';
import { Refused } from './supervisor.ts';

/** `helix owner <person>`: makes someone already on Helix the owner, in config.yaml. */
export function setOwner(store: Store, name: string): void {
  if (!store.person(name)) throw new AnimusError(`Helix has no person named ${name}: the owner is someone who has joined (helix invite ${name})`);
  updateConfig({ owner: name });
}

export const isOwner = (config: Pick<Config, 'owner'>, person: string | undefined) => Boolean(config.owner) && person === config.owner;

/** Refuses taking the owner off Helix, by leave or remove-person: it would be left with nobody who may invite. */
export function keepOwner(config: Pick<Config, 'owner'>, person: string): void {
  if (isOwner(config, person)) throw new Refused(409, 'name another owner first: helix owner <person> on the machine');
}

/**
 * Moves slack.owner, the Slack user id helix slack setup wrote before the
 * owner was a person, into the owner's Slack link and out of config.yaml. A
 * link the owner already has stands. With no owner yet the value stays, for a
 * start after helix owner. Returns what to tell whoever started Helix.
 */
export function moveSlackOwner(store: Store, file = configFile()): string | undefined {
  const config = loadConfig(file);
  const { owner: user, ...slack } = (config.slack ?? {}) as { enabled: boolean; owner?: unknown };
  if (typeof user !== 'string') return undefined;
  if (!config.owner) return `${file} names a Slack owner, ${user}, but this Helix has no owner to link it to: helix owner <person>, then restart`;
  const linked = store.slackOf(config.owner);
  if (!linked) store.linkSlack(config.owner, user);
  updateConfig({ slack }, file);
  return linked ? `${file}'s slack.owner is dropped: ${config.owner}, the owner, is linked to ${linked} already` : `${file}'s slack.owner ${user} is now linked to ${config.owner}, the owner`;
}

/** Refuses a request that only the owner may make, saying who the owner is. */
export function requireOwner(config: Config, person: string, what: string): void {
  if (!config.owner) throw new Refused(403, `this Helix has no owner: helix owner <person> on the machine names the one who may ${what}`);
  if (!isOwner(config, person)) throw new Refused(403, `only the owner, ${config.owner}, may ${what}`);
}
