import { compatible } from '../plugin/src/version.ts';

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

/** What a pull request body says under `## Breaking`, or undefined when it has no such section or the section says only "None." */
export function breakingOf(body: string): string | undefined {
  const m = /^## Breaking[ \t]*\n([\s\S]*?)(?=^## |^<details>|(?![\s\S]))/m.exec(body.replace(/\r\n/g, '\n'));
  const text = m?.[1]?.trim();
  return text && !/^none\.?$/i.test(text) ? text : undefined;
}

// shortcut: only merge commits ("Merge pull request #N") name a pull request, so a squash merge is listed by its subject; upgrade when merges are squashed.
export function collect({ git, pull }: Deps): Notes {
  // `tag --list` prints nothing when there is no release yet, where `describe` would fail, and the real git helper exits the process on failure.
  const last = git('tag', '--list', 'v*', '--merged', 'HEAD', '--sort=-v:refname').split('\n')[0]!;
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
  const lines = render(notes, m[1]!);
  if (!lines) throw new Error('nothing was merged since the last release, and nothing is written under "## Unreleased"');
  // A replacer function, so a `$&` or `$$` in a title is not read as a replacement pattern.
  return changelog.replace(m[0], () => `## Unreleased\n\n## ${version} (${date})\n\n${lines}\n\n`);
}

/** Why the release must not be cut without --breaking, or undefined when it may be. */
export function breakingRefusal(notes: Notes, current: string, version: string, breaking: boolean | undefined): string | undefined {
  if (breaking) return undefined;
  if (!compatible(current, version)) {
    return `${version} cannot work with ${current} clients: Helix will refuse every animus not yet updated. Pass --breaking if that is meant, and upgrade Helix and tell the team together`;
  }
  if (notes.breaking.length) {
    return `these pull requests break something: ${notes.breaking.map((b) => `#${b.pull.number} ${b.pull.title}`).join('; ')}. Pass --breaking if the release is meant to, and upgrade Helix and tell the team together`;
  }
  return undefined;
}
