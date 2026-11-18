// Whether a queued job fits now: the machine has memory and CPU to spare, and
// its Claude tier is not already at its limit. Pure: the machine is a reading
// passed in, so tests give fixed ones and nothing here depends on the OS.
import { availableParallelism, freemem, loadavg } from 'node:os';
import type { Tier } from '../../plugin/src/profiles.ts';
import { parseMemory, type Config } from './config.ts';

export type Reading = { freeBytes: number; load: number; cores: number };

/** The machine as Node's os reports it. */
export const readMachine = (): Reading => ({ freeBytes: freemem(), load: loadavg()[0]!, cores: availableParallelism() });

const GB = 1024 ** 3;
const gb = (bytes: number) => `${Math.round((bytes / GB) * 10) / 10} GB`;

/** Why a job with this tier must wait for room, or undefined when it fits. `running` holds the tiers of the jobs running now (none known: undefined). */
export function waitReason(config: Config, running: readonly (Tier | undefined)[], tier: Tier | undefined, machine: Reading, memory?: string): string | undefined {
  const limit = tier ? config.tier_limits?.[tier] : undefined;
  const using = running.filter((t) => t === tier).length;
  if (tier && limit !== undefined && using >= limit) return `waiting for the ${tier} tier: ${using} of ${limit} running`;
  const needs = parseMemory(memory ?? config.job_memory ?? '4g')!;
  const kept = parseMemory(config.reserve_memory ?? '2g')!;
  if (machine.freeBytes < needs + kept) return `waiting for memory: ${gb(machine.freeBytes)} free, needs ${gb(needs)} plus ${gb(kept)} kept free`;
  // shortcut: a load of exactly 0 is taken as Windows, which has no load average; a truly idle Unix machine passes the check anyway.
  if (machine.load > 0 && machine.load >= machine.cores) return `waiting for CPU: load ${Math.round(machine.load * 10) / 10} on ${machine.cores} cores`;
  return undefined;
}
