// `after:` in a spec's header: the spec files this one builds on. A job
// starts from the base branch as the remote has it, so a spec that needs an
// earlier one's work waits here until that one's pull request is merged, and
// then starts from a base that holds it. The earlier job is found in the run
// log by the spec file it ran.
import { existsSync } from 'node:fs';
import { dirname, resolve } from 'node:path';
import { readRuns } from './log.ts';
import type { PrLookup } from './pr.ts';
import { AnimusError } from './proc.ts';

const POLL_MS = 60_000;

/** The spec files an `after:` header names, as absolute paths: from the repo root, else beside the spec. */
export function resolveAfter(repo: string, specFile: string, after: readonly string[]): string[] {
  return after.map((name) => {
    const candidates = [resolve(repo, name), resolve(dirname(specFile), name)];
    const ran = new Set(readRuns().map((r) => r.spec_file));
    const found = candidates.find((c) => existsSync(c) || ran.has(c));
    if (!found) throw new AnimusError(`after: ${name} is not a spec file (looked for ${candidates.join(' and ')})`);
    if (found === resolve(specFile)) throw new AnimusError(`after: ${name} is this spec itself`);
    return found;
  });
}

/** Returns once every one of these spec files has a merged pull request in this repo. Throws if one was closed unmerged. */
export async function waitForMerged(p: { repo: string; files: readonly string[]; lookup: PrLookup; sleep?: (ms: number) => Promise<void>; log: (line: string) => void }): Promise<void> {
  const sleep = p.sleep ?? ((ms: number) => new Promise<void>((done) => { setTimeout(done, ms); }));
  for (const file of p.files) {
    let said = '';
    for (;;) {
      const pr = readRuns().findLast((r) => r.repo === p.repo && r.spec_file === file && r.pr)?.pr;
      const state = pr ? p.lookup(pr, p.repo) : undefined;
      if (state === 'MERGED') {
        p.log(`${file} is merged (${pr})`);
        break;
      }
      if (state === 'CLOSED') throw new AnimusError(`this spec runs after ${file}, whose pull request ${pr} was closed without merging`);
      const now = !pr ? 'no job from it has opened a pull request yet' : state ? `${pr} is open` : `the state of ${pr} could not be read`;
      if (now !== said) p.log(`waiting: this spec runs after ${file}, and ${now}. The job starts once that is merged; checked every minute.`);
      said = now;
      await sleep(POLL_MS);
    }
  }
}
