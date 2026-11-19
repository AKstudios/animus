// Whether a queued job fits now: the machine has memory and CPU to spare, and
// its Claude tier is not already at its limit. Pure: the machine is a reading
// passed in, so tests give fixed ones and nothing here depends on the OS but
// readMachine. Helix's queue uses it; the plugin never imports Helix.
import { execFileSync } from 'node:child_process';
import { availableParallelism, freemem, loadavg } from 'node:os';
import type { Tier } from './profiles.ts';

export type Reading = { freeBytes: number; load: number; cores: number };

/** The room settings of a queue's config (Helix's config.yaml has these keys). */
export type Room = { reserve_memory?: string; job_memory?: string; tier_limits?: Partial<Record<Tier, number>> };

const UNITS: Record<string, number> = { '': 1, b: 1, k: 1024, m: 1024 ** 2, g: 1024 ** 3, t: 1024 ** 4 };

/** A memory size as container memory is written (`6g`, `512m`), in bytes; undefined when it is not one. */
export function parseMemory(text: unknown): number | undefined {
  const m = /^(\d+(?:\.\d+)?)([bkmgt]?)b?$/i.exec(String(text).trim());
  return m && Number(m[1]) > 0 ? Number(m[1]) * UNITS[m[2]!.toLowerCase()]! : undefined;
}

/** Bytes the system would hand over from `vm_stat` output: free, inactive and speculative pages; undefined when the output is not vm_stat's. */
export function parseVmStat(text: string): number | undefined {
  const size = /page size of (\d+) bytes/.exec(text)?.[1];
  const pages = (name: string) => new RegExp(`^Pages ${name}:\\s+(\\d+)\\.`, 'm').exec(text)?.[1];
  const [free, inactive, speculative] = ['free', 'inactive', 'speculative'].map(pages);
  if (!size || !free || !inactive || !speculative) return undefined;
  return (Number(free) + Number(inactive) + Number(speculative)) * Number(size);
}

/**
 * The machine now. Memory is what the system would hand over: on macOS, whose
 * os.freemem() counts only never-used pages, free + inactive + speculative
 * pages from vm_stat; elsewhere Node's free memory.
 */
export function readMachine(): Reading {
  let freeBytes = freemem();
  if (process.platform === 'darwin') {
    try { freeBytes = parseVmStat(execFileSync('vm_stat', { encoding: 'utf8' })) ?? freeBytes; } catch { /* no vm_stat: keep Node's reading */ }
  }
  return { freeBytes, load: loadavg()[0]!, cores: availableParallelism() };
}

const GB = 1024 ** 3;
const gb = (bytes: number) => `${Math.round((bytes / GB) * 10) / 10} GB`;

/** Why a job with this tier must wait for room, or undefined when it fits. `running` holds the tiers of the jobs running now (none known: undefined). */
export function waitReason(config: Room, running: readonly (Tier | undefined)[], tier: Tier | undefined, machine: Reading, memory?: string): string | undefined {
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
