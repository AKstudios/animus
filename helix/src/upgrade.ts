// Which release `helix upgrade --follow` moves this machine to. The stable
// branch is what teammates' Claude Code follows (docs/releases.md), so Helix
// follows it too, and the two move together.
import { atLeast, parseVersion } from '../../plugin/src/version.ts';
import type { Upgrade } from './store.ts';

export type Follow = { tag: string } | { stay: string };

/**
 * head: the commit checked out here. stable: the commit origin's stable
 * branch is at, if it has one. tags: the tags at that commit. last: the
 * last try at the newest of those tags on this machine.
 */
export function releaseToFollow(o: { head: string; stable?: string; tags: string[]; last?: (tag: string) => Upgrade | undefined }): Follow {
  if (!o.stable) return { stay: 'origin has no stable branch' };
  const releases = o.tags.filter((t) => /^v\d+\.\d+\.\d+$/.test(t) && parseVersion(t.slice(1)));
  const tag = releases.sort((a, b) => (atLeast(a.slice(1), b.slice(1)) ? -1 : 1))[0];
  if (o.stable === o.head) return { stay: `already on ${tag ?? `stable (${o.stable.slice(0, 12)})`}` };
  if (!tag) return { stay: `stable (${o.stable.slice(0, 12)}) is not at a release tag` };
  const last = o.last?.(tag);
  if (last && !last.ok) return { stay: `${tag} failed here at ${last.at}${last.detail ? ` (${last.detail})` : ''}, so it is not tried again on its own: helix upgrade ${tag} tries it` };
  return { tag };
}
