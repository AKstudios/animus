// Fails when the branch changes a file that ships and adds nothing under
// `## Unreleased` in CHANGELOG.md. Run as `npm run changelog`.
import { execFileSync } from "node:child_process";

const SHIPPED = [
  "plugin/src/",
  "plugin/skills/",
  "plugin/config/",
  "plugin/display/",
  "helix/src/",
  "helix/ui/",
  "helix/deploy/",
];

function git(...args: string[]): string {
  return execFileSync("git", args, { encoding: "utf8", maxBuffer: 1 << 28 });
}

function mergeBase(): string {
  for (const ref of ["origin/main", "main"]) {
    try {
      return git("merge-base", "HEAD", ref).trim();
    } catch {}
  }
  throw new Error("no origin/main or main to compare the branch with");
}

const isShipped = (f: string) =>
  SHIPPED.some((d) => f.startsWith(d)) && !f.split("/").some((s) => s === "test" || s === "tests");

function addsUnreleasedLine(base: string): boolean {
  const diff = git("diff", "-U1000000", base, "--", "CHANGELOG.md");
  let inUnreleased = false;
  let inHunk = false;
  for (const line of diff.split("\n")) {
    if (line.startsWith("@@")) { inHunk = true; continue; }
    if (!inHunk || line.startsWith("-") || line.startsWith("\\")) continue;
    const text = line.slice(1);
    if (text.startsWith("## ")) inUnreleased = text.trim() === "## Unreleased";
    else if (line.startsWith("+") && inUnreleased && text.trim() !== "") return true;
  }
  return false;
}

const base = mergeBase();
const shipped = git("diff", "--name-only", base).split("\n").filter((f) => f && isShipped(f));
if (shipped.length > 0 && !addsUnreleasedLine(base)) {
  console.error(
    `These shipped files changed, but CHANGELOG.md adds nothing under "## Unreleased":\n` +
      shipped.map((f) => `  ${f}`).join("\n") +
      `\nAdd an entry under "## Unreleased" in CHANGELOG.md.`,
  );
  process.exit(1);
}
