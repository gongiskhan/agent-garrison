import { execFileSync } from "node:child_process";
import { mkdtempSync, mkdirSync, readFileSync, rmSync, unlinkSync, writeFileSync } from "node:fs";
import os from "node:os";
import path from "node:path";
import { afterEach, expect, it } from "vitest";
// @ts-ignore - dependency-free fitting JavaScript
import { guardUnicodeAliases } from "../fittings/seed/vault-git-sync/scripts/git-unicode-aliases.mjs";

const roots: string[] = [];
const git = (cwd: string, ...args: string[]) => execFileSync("git", args, { cwd, encoding: "utf8", stdio: ["ignore", "pipe", "pipe"] }).trim();
const canonical = "Archive/Cafe\u0301/file [1].md";
const alias = canonical.normalize("NFC");
function stage(cwd: string, name: string, body: string | null) {
  const oid = body === null ? "0".repeat(40) : execFileSync("git", ["hash-object", "-w", "--stdin"], { cwd, input: body, encoding: "utf8" }).trim();
  // stdin preserves the spelling even when macOS normalizes Git argv.
  execFileSync("git", ["update-index", "-z", "--index-info"], { cwd, input: `${body === null ? "0" : "100644"} ${oid}\t${name}\0` });
}
function fixture() {
  const cwd = mkdtempSync(path.join(os.tmpdir(), "vault-unicode-")); roots.push(cwd);
  git(cwd, "init", "-q", "-b", "main");
  git(cwd, "config", "user.name", "Fixture"); git(cwd, "config", "user.email", "fixture@example.invalid");
  git(cwd, "config", "commit.gpgsign", "false");
  for (const name of [canonical, alias]) mkdirSync(path.dirname(path.join(cwd, name)), { recursive: true });
  writeFileSync(path.join(cwd, canonical), "original\n");
  stage(cwd, canonical, "original\n"); git(cwd, "commit", "-qm", "original");
  return cwd;
}
afterEach(() => { for (const cwd of roots.splice(0)) rmSync(cwd, { recursive: true, force: true }); });

it("removes identical aliases from the index, preserves both files and keeps later canonical edits", () => {
  const cwd = fixture(); writeFileSync(path.join(cwd, alias), "original\n");
  writeFileSync(path.join(cwd, ".git/info/exclude"), "# Existing owner rule\nprivate/\n");
  stage(cwd, alias, "original\n");
  expect(guardUnicodeAliases({ cwd, platform: "darwin" })).toEqual({ removed: 1 });
  expect(git(cwd, "diff", "--cached", "--name-only")).toBe("");
  expect(git(cwd, "status", "--porcelain")).toBe("");
  expect(readFileSync(path.join(cwd, alias), "utf8")).toBe("original\n");
  expect(readFileSync(path.join(cwd, canonical), "utf8")).toBe("original\n");
  expect(readFileSync(path.join(cwd, ".git/info/exclude"), "utf8")).toContain("private/\n");
  writeFileSync(path.join(cwd, canonical), "legitimate edit\n"); git(cwd, "add", "-A");
  expect(git(cwd, "diff", "--cached", "--numstat")).toContain("1\t1");
  expect(guardUnicodeAliases({ cwd, platform: "darwin" })).toEqual({ removed: 0 });
});

it("refuses different blobs before changing the index", () => {
  const cwd = fixture(); writeFileSync(path.join(cwd, alias), "different\n"); stage(cwd, alias, "different\n");
  const before = git(cwd, "ls-files", "--stage", "-z");
  expect(() => guardUnicodeAliases({ cwd, platform: "darwin" })).toThrow("Conflicting Unicode");
  expect(git(cwd, "ls-files", "--stage", "-z")).toBe(before);
  expect(readFileSync(path.join(cwd, alias), "utf8")).toBe("different\n");
});

it("does not suppress a genuinely new file or an explicit filename normalization", () => {
  const cwd = fixture(); stage(cwd, canonical, null); unlinkSync(path.join(cwd, canonical));
  writeFileSync(path.join(cwd, alias), "original\n"); stage(cwd, alias, "original\n");
  writeFileSync(path.join(cwd, "new.md"), "new\n"); stage(cwd, "new.md", "new\n");
  const before = git(cwd, "ls-files", "--stage", "-z");
  expect(guardUnicodeAliases({ cwd, platform: "darwin" })).toEqual({ removed: 0 });
  expect(git(cwd, "ls-files", "--stage", "-z")).toBe(before);
});

it("leaves other platforms alone", () => {
  const cwd = fixture(); writeFileSync(path.join(cwd, alias), "original\n"); stage(cwd, alias, "original\n");
  const before = git(cwd, "ls-files", "--stage", "-z");
  expect(guardUnicodeAliases({ cwd, platform: "linux" })).toEqual({ removed: 0 });
  expect(git(cwd, "ls-files", "--stage", "-z")).toBe(before);
});
