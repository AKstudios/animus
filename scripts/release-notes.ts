// The release's section of CHANGELOG.md, made from the pull requests merged
// since the last release tag. The git and GitHub calls are passed in, so
// tests use a fake.
export type Pull = { number: number; title: string; body: string; url: string };
export type Deps = {
  /** Runs git and returns its output, trimmed. */
  git: (...args: string[]) => string;
  /** Reads one pull request, with `gh`. */
  pull: (number: number) => Pull;
};
export type Notes = { breaking: { pull: Pull; text: string }[]; changes: Pull[]; direct: string[] };

/** What a pull request body says under `## Breaking`, or undefined when it has no such section. */
export function breakingOf(body: string): string | undefined {
  const m = /^## Breaking[ \t]*\n([\s\S]*?)(?=^## |(?![\s\S]))/m.exec(body.replace(/\r\n/g, '\n'));
  return m?.[1]?.trim() || undefined;
}

// shortcut: only merge commits ("Merge pull request #N") name a pull request, so a squash merge is listed by its subject; upgrade when merges are squashed.
export function collect({ git, pull }: Deps): Notes {
  let last = '';
  try { last = git('describe', '--tags', '--abbrev=0', '--match', 'v*'); } catch { /* no release yet: everything counts */ }
  const log = git('log', '--first-parent', '--format=%s', ...(last ? [`${last}..HEAD`] : []));
  const notes: Notes = { breaking: [], changes: [], direct: [] };
  for (const subject of log.split('\n').filter(Boolean)) {
    const n = /^Merge pull request #(\d+)\b/.exec(subject)?.[1];
    if (!n) { notes.direct.push(subject); continue; }
    const p = pull(Number(n));
    const text = breakingOf(p.body);
    if (text) notes.breaking.push({ pull: p, text }); else notes.changes.push(p);
  }
  return notes;
}

const link = (p: Pull) => `${p.title} ([#${p.number}](${p.url}))`;

/** The lines under the release's heading: the hand-written ones, then breaking pull requests, the rest, the direct commits. */
export function render(notes: Notes, handWritten: string): string {
  return [
    handWritten.trim(),
    ...notes.breaking.map(({ pull, text }) => `- **Breaking:** ${link(pull)}: ${text.replace(/\n/g, '\n  ')}`),
    ...notes.changes.map((p) => `- ${link(p)}`),
    ...notes.direct.map((s) => `- ${s}`),
  ].filter(Boolean).join('\n');
}

/** The changelog with Unreleased emptied and `## <version> (<date>)` holding its lines and the generated ones. */
export function cut(changelog: string, notes: Notes, version: string, date: string): string {
  const m = /^## Unreleased\n([\s\S]*?)(?=^## |(?![\s\S]))/m.exec(changelog);
  if (!m) throw new Error('CHANGELOG.md has no "## Unreleased" heading');
  return changelog.replace(m[0], `## Unreleased\n\n## ${version} (${date})\n\n${render(notes, m[1]!)}\n\n`);
}
