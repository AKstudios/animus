// The client side of Helix (docs/factory.md, "The office machine"): submit a
// spec to the machine that runs jobs, and ask about it. Five thin HTTP calls;
// the result never depends on them, since it lands as a pull request.
import { AnimusError } from './proc.ts';

/** A job as Helix reports it. */
export type RemoteJob = {
  id: number; state: string; person: string; repo: string; title: string; submitted: string; started?: string; ended?: string;
  animus_job?: string; outcome?: string; pr?: string; reason?: string; question?: string; cost_usd?: number; log?: string;
};

async function call<T>(method: string, path: string, body?: unknown): Promise<T> {
  const url = process.env.HELIX_URL;
  const token = process.env.HELIX_TOKEN;
  if (!url || !token) throw new AnimusError('set HELIX_URL (where Helix listens, such as http://office:7420) and HELIX_TOKEN (yours, from helix add-person)');
  let res: Response;
  try {
    res = await fetch(new URL(path, url), { method, headers: { authorization: `Bearer ${token}`, 'content-type': 'application/json' }, ...(body === undefined ? {} : { body: JSON.stringify(body) }) });
  } catch (err) {
    throw new AnimusError(`could not reach Helix at ${url}: ${(err as Error).cause instanceof Error ? ((err as Error).cause as Error).message : (err as Error).message}`);
  }
  const value = (await res.json().catch(() => ({}))) as { error?: string };
  if (!res.ok) throw new AnimusError(`Helix refused: ${value.error ?? res.statusText}`);
  return value as T;
}

export const submit = (s: { repo: string; spec: string; name: string; draft?: boolean }) => call<RemoteJob>('POST', '/jobs', s);
export const jobs = () => call<{ slots: number; jobs: RemoteJob[] }>('GET', '/jobs');
export const job = (id: string) => call<RemoteJob>('GET', `/jobs/${encodeURIComponent(id)}`);
export const cancel = (id: string) => call<RemoteJob>('POST', `/jobs/${encodeURIComponent(id)}/cancel`);
export const answer = (id: string, text: string) => call<RemoteJob>('POST', `/jobs/${encodeURIComponent(id)}/answer`, { answer: text });

const how = (j: RemoteJob) => (j.state === 'ended' ? j.outcome ?? 'ended' : j.state);

/** `animus status`: one line per job, newest last. */
export function describeJobs(list: readonly RemoteJob[]): string {
  if (!list.length) return 'no jobs';
  const rows = list.map((j) => [String(j.id), j.person, j.repo, how(j), j.title, j.pr ?? j.question ?? j.reason?.split('\n')[0]?.slice(0, 60) ?? '']);
  const widths = rows[0]!.map((_, i) => Math.max(...rows.map((row) => row[i]!.length)));
  return rows.map((row) => row.map((cell, i) => cell.padEnd(widths[i]!)).join('  ').trimEnd()).join('\n');
}

/** `animus status <id>`: the job, then the end of its log. */
export function describeJob(j: RemoteJob): string {
  return [
    `job ${j.id}: ${j.title}`,
    `  ${how(j)}${j.pr ? `: ${j.pr}` : ''}`,
    `  for ${j.person} on ${j.repo}, submitted ${j.submitted.slice(0, 16).replace('T', ' ')}`,
    ...(j.question ? [`  it asks: ${j.question}`, `  answer with: animus answer ${j.id} "<your answer>"`] : []),
    ...(j.reason ? [`  reason: ${j.reason.split('\n')[0]}`] : []),
    ...(j.log ? ['', j.log] : []),
  ].join('\n');
}
