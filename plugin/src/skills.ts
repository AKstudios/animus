// Skills by role (docs/factory.md, "Skills"). A skill reaches an agent only
// as text in that role's instructions, from a copy vendored at a commit
// someone read (plugin/vendor/sources.yaml). plugin/config/profiles.yaml
// grants each skill to the roles that need it, so the reviewer never sees the
// implementer's, and no session can load a skill by itself. The repository's
// own skills (.claude/skills/) are listed for every role, since they are that
// project's knowledge and arrive with the clone.
import { existsSync, readdirSync, readFileSync } from 'node:fs';
import { join } from 'node:path';
import { parse } from 'yaml';
import { isRecord } from './profile.ts';
import { PLUGIN_ROOT, type Factory } from './profiles.ts';
import { AnimusError } from './proc.ts';

export const VENDOR = join(PLUGIN_ROOT, 'vendor');

export type Grant = { name: string; file: string };

/** The vendored skills a role gets on a job of this type, with the file each contributes. */
export function grantsFor(factory: Pick<Factory, 'skills'>, role: string, type: string): Grant[] {
  return Object.entries(factory.skills ?? {}).flatMap(([name, g]) => {
    const file = g.roles?.[role];
    return file && (!g.types || g.types.includes(type)) ? [{ name, file }] : [];
  });
}

const body = (text: string) => text.replace(/^---\r?\n[\s\S]*?\r?\n---\r?\n?/, '').trim();

function frontMatter(text: string): Record<string, unknown> {
  const m = /^---\r?\n([\s\S]*?)\r?\n---/.exec(text);
  if (!m) return {};
  try {
    const raw = parse(m[1]!) as unknown;
    return isRecord(raw) ? raw : {};
  } catch {
    return {};
  }
}

/** The repository's own skills: name, description and file, for an agent to read when one applies. */
export function projectSkills(worktree: string): { name: string; description: string; file: string }[] {
  const dir = join(worktree, '.claude', 'skills');
  if (!existsSync(dir)) return [];
  return readdirSync(dir).sort().flatMap((entry) => {
    const file = join(dir, entry, 'SKILL.md');
    if (!existsSync(file)) return [];
    const fm = frontMatter(readFileSync(file, 'utf8'));
    return [{ name: typeof fm.name === 'string' ? fm.name : entry, description: typeof fm.description === 'string' ? fm.description.trim().replace(/\s+/g, ' ') : '', file: join('.claude', 'skills', entry, 'SKILL.md') }];
  });
}

export type RoleSkills = {
  /** For the run log: vendored skills by name, the repository's as repo:<name>. */
  names: string[];
  /** Appended to the role's instructions; empty when it has no skills. */
  system: string;
  /** Folders the session must be able to read. */
  dirs: string[];
};

/** Everything a role is given about skills for one job. */
export function roleSkills(factory: Pick<Factory, 'skills'>, role: string, type: string, worktree?: string, vendor = VENDOR): RoleSkills {
  const parts: string[] = [];
  const names: string[] = [];
  const dirs: string[] = [];
  for (const g of grantsFor(factory, role, type)) {
    const dir = join(vendor, g.name);
    const file = join(dir, g.file);
    if (!existsSync(file)) throw new AnimusError(`profiles.yaml grants ${role} the skill ${g.name}, but ${file} does not exist`);
    const note = join(vendor, `${g.name}.${role}.md`);
    parts.push([
      `# Skill: ${g.name}`,
      existsSync(note) ? readFileSync(note, 'utf8').trim() : '',
      `The skill's text follows. Files it refers to are under ${dir}/ and you may Read them; nothing there is to be run.`,
      body(readFileSync(file, 'utf8')),
    ].filter(Boolean).join('\n\n'));
    names.push(g.name);
    dirs.push(dir);
  }
  const own = worktree ? projectSkills(worktree) : [];
  if (own.length) {
    parts.push(`# This repository's skills\n\nThe project keeps its own guidance in these files. Read one before work it covers:\n\n${own.map((s) => `- ${s.file}: ${s.description || s.name}`).join('\n')}`);
    names.push(...own.map((s) => `repo:${s.name}`));
  }
  return { names, system: parts.join('\n\n'), dirs };
}

type Source = { repo?: string; commit?: string; license?: string };

/** `animus skills`: each vendored skill, where it came from, and who gets it. */
export function describeSkills(factory: Pick<Factory, 'skills'>, vendor = VENDOR): string {
  const file = join(vendor, 'sources.yaml');
  const sources = (existsSync(file) ? parse(readFileSync(file, 'utf8')) : {}) as Record<string, Source>;
  const names = [...new Set([...Object.keys(sources ?? {}), ...Object.keys(factory.skills ?? {})])];
  if (!names.length) return 'no vendored skills';
  return names.map((name) => {
    const s = sources?.[name];
    const g = factory.skills?.[name];
    const who = g ? Object.entries(g.roles ?? {}).map(([role, f]) => `${role} (${f})`).join(', ') : '';
    return [
      name,
      `  from     ${s ? `${s.repo} at ${s.commit?.slice(0, 10)} (${s.license})` : 'not in sources.yaml'}`,
      `  given to ${who || 'nobody: vendored but not granted'}${g?.types ? `, on ${g.types.join(', ')} jobs only` : ''}`,
    ].join('\n');
  }).join('\n');
}
