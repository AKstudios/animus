import { test } from "node:test";
import assert from "node:assert/strict";
import { execFileSync, spawnSync } from "node:child_process";
import { mkdirSync, mkdtempSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { dirname, join } from "node:path";

const script = join(import.meta.dirname, "..", "changelog-check.ts");
const CHANGELOG = "# Changelog\n\n## Unreleased\n\n## 1.0.0 (2026-01-01)\n\n- first\n";

function repo(): string {
  const dir = mkdtempSync(join(tmpdir(), "changelog-"));
  git(dir, "init", "-q", "-b", "main");
  write(dir, "CHANGELOG.md", CHANGELOG);
  write(dir, "plugin/src/a.ts", "a\n");
  git(dir, "add", "-A");
  git(dir, "commit", "-qm", "base");
  git(dir, "checkout", "-qb", "work");
  return dir;
}
function git(dir: string, ...args: string[]) {
  execFileSync("git", ["-c", "user.name=t", "-c", "user.email=t@t", ...args], { cwd: dir });
}
function write(dir: string, file: string, text: string) {
  mkdirSync(dirname(join(dir, file)), { recursive: true });
  writeFileSync(join(dir, file), text);
}
function commit(dir: string) {
  git(dir, "add", "-A");
  git(dir, "commit", "-qm", "work");
}
function run(dir: string) {
  return spawnSync("node", ["--disable-warning=ExperimentalWarning", script], { cwd: dir, encoding: "utf8" });
}

test("fails naming the shipped files when there is no entry", () => {
  const dir = repo();
  write(dir, "plugin/src/a.ts", "b\n");
  commit(dir);
  const r = run(dir);
  assert.equal(r.status, 1);
  assert.match(r.stderr, /plugin\/src\/a\.ts/);
  assert.match(r.stderr, /## Unreleased/);
});

test("passes with a line added under Unreleased", () => {
  const dir = repo();
  write(dir, "plugin/src/a.ts", "b\n");
  write(dir, "CHANGELOG.md", CHANGELOG.replace("## Unreleased\n", "## Unreleased\n\n- new thing\n"));
  commit(dir);
  assert.equal(run(dir).status, 0);
});

test("passes when only unshipped files change, or nothing does", () => {
  const dir = repo();
  assert.equal(run(dir).status, 0);
  write(dir, "plugin/src/test/a.test.ts", "t\n");
  write(dir, "docs/x.md", "d\n");
  write(dir, "scripts/y.ts", "s\n");
  commit(dir);
  assert.equal(run(dir).status, 0);
});

test("a line added under a released version does not count", () => {
  const dir = repo();
  write(dir, "plugin/src/a.ts", "b\n");
  write(dir, "CHANGELOG.md", CHANGELOG + "- late\n");
  commit(dir);
  assert.equal(run(dir).status, 1);
});
