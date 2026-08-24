// The merge duty's deterministic half.
//
// The judgement half (reconciling two people's edits) lives in the skill and is
// not testable here. What IS testable is everything the skill must not be
// allowed to improvise: the shape of the revert tag, the definition of "trivial"
// that decides whether a decision card gets filed at all, and the refusal list
// that stops a lockfile or a binary from being merged on a guess.

import { execFileSync } from "node:child_process";
import { mkdtempSync, mkdirSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import path from "node:path";
import { afterAll, beforeAll, describe, expect, it } from "vitest";

// @ts-ignore - dependency-free fitting JavaScript
import { conflictPaths, isNonTrivialMerge, isTrivialFastForward, parsePremergeTag, premergeTag, refusalList, tagTimestamp } from "../fittings/seed/merge-agent/lib/merge.mjs";

function git(cwd: string, ...args: string[]): string {
  return execFileSync("git", args, { cwd, encoding: "utf8", stdio: ["ignore", "pipe", "pipe"] });
}

function initRepo(dir: string): string {
  mkdirSync(dir, { recursive: true });
  git(dir, "init", "--quiet");
  git(dir, "symbolic-ref", "HEAD", "refs/heads/main");
  git(dir, "config", "user.email", "fixture@garrison.test");
  git(dir, "config", "user.name", "Garrison Fixture");
  git(dir, "config", "commit.gpgsign", "false");
  writeFileSync(path.join(dir, "README.md"), "# fixture\n");
  git(dir, "add", "-A");
  git(dir, "commit", "--quiet", "-m", "initial");
  return dir;
}

function commitFile(dir: string, rel: string, body: string, message: string): void {
  writeFileSync(path.join(dir, rel), body);
  git(dir, "add", "-A");
  git(dir, "commit", "--quiet", "-m", message);
}

describe("premerge tag — rail 1, the one-command revert", () => {
  it("is a git-legal ref: no colons, and it still sorts by time", () => {
    const at = new Date("2026-08-24T19:11:34.512Z");
    const tag = premergeTag("garrison", "dev-madrid", at);
    expect(tag).toBe("garrison/premerge/garrison/dev-madrid/2026-08-24T191134Z");
    // `git check-ref-format` forbids ':' outright — an unflattened ISO instant
    // would produce a tag git refuses to create, at the exact moment you need it.
    expect(tag).not.toContain(":");
    execFileSync("git", ["check-ref-format", `refs/tags/${tag}`]);

    const earlier = premergeTag("garrison", "dev-madrid", new Date("2026-08-24T09:00:00Z"));
    expect(earlier < tag).toBe(true);
  });

  it("round-trips back into its parts", () => {
    const at = new Date("2026-08-24T19:11:34.000Z");
    const parsed = parsePremergeTag(premergeTag("ekoa-mono", "mac-pro", at));
    expect(parsed).toMatchObject({ project: "ekoa-mono", node: "mac-pro" });
    expect(parsed.at.toISOString()).toBe("2026-08-24T19:11:34.000Z");
    expect(parsePremergeTag("refs/heads/main")).toBeNull();
    expect(parsePremergeTag("garrison/premerge/a/b/not-a-stamp")).toBeNull();
  });

  it("REFUSES a project or node name that is not usable in a ref", () => {
    for (const bad of ["has space", "a/b", "..", "-leading", "trailing.lock", "", "a:b", "a~b"]) {
      expect(() => premergeTag(bad, "node"), bad).toThrow(/not usable in a git ref/);
      expect(() => premergeTag("proj", bad), bad).toThrow(/not usable in a git ref/);
    }
  });

  it("flattens the timestamp deterministically", () => {
    expect(tagTimestamp(new Date("2026-01-02T03:04:05.006Z"))).toBe("2026-01-02T030405Z");
  });
});

describe("isTrivialFastForward — what decides whether a card is filed", () => {
  let base: string;
  let repo: string;

  beforeAll(() => {
    base = mkdtempSync(path.join(tmpdir(), "garrison-merge-ff-"));
    repo = initRepo(path.join(base, "repo"));
    // `feature` is main plus one commit; main is untouched, so main..feature is
    // a fast-forward. (A ref created in a throwaway fixture, not in this repo.)
    git(repo, "update-ref", "refs/heads/feature", "HEAD");
    git(repo, "symbolic-ref", "HEAD", "refs/heads/feature");
    commitFile(repo, "feature.txt", "feature work\n", "feature: work");
    git(repo, "symbolic-ref", "HEAD", "refs/heads/main");
    git(repo, "reset", "--hard", "--quiet");
  });

  afterAll(() => rmSync(base, { recursive: true, force: true }));

  it("is TRUE when HEAD is already an ancestor of the incoming ref", async () => {
    expect(await isTrivialFastForward(repo, "feature")).toBe(true);
  });

  it("is TRUE for an already-merged ref (nothing to do is trivial too)", async () => {
    expect(await isTrivialFastForward(repo, "HEAD")).toBe(true);
  });

  it("is FALSE once this side has its own commit — the histories diverged", async () => {
    commitFile(repo, "main.txt", "main work\n", "main: work");
    expect(await isTrivialFastForward(repo, "feature")).toBe(false);
  });

  it("is FALSE for a ref that does not resolve — an unknown ref is never 'trivial'", async () => {
    expect(await isTrivialFastForward(repo, "origin/does-not-exist")).toBe(false);
  });

  it("names the conflicting paths of an in-progress merge", async () => {
    // Both sides changed the same line of the same file.
    git(repo, "symbolic-ref", "HEAD", "refs/heads/feature");
    git(repo, "reset", "--hard", "--quiet");
    commitFile(repo, "shared.txt", "feature side\n", "feature: shared");
    git(repo, "symbolic-ref", "HEAD", "refs/heads/main");
    git(repo, "reset", "--hard", "--quiet");
    commitFile(repo, "shared.txt", "main side\n", "main: shared");
    try {
      git(repo, "-c", "core.hooksPath=/dev/null", "merge", "--no-ff", "feature");
    } catch {
      /* the conflict is the point */
    }
    expect(await conflictPaths(repo)).toContain("shared.txt");
    git(repo, "merge", "--abort");
    expect(await conflictPaths(repo)).toEqual([]);
  });
});

describe("refusalList — refuse and escalate, never guess", () => {
  it("flags every lockfile as REGENERATE, not merge", () => {
    const flagged = refusalList([
      "package-lock.json",
      "apm.lock.yaml",
      "web/pnpm-lock.yaml",
      "services/api/Cargo.lock",
      "go.sum",
      "uv.lock"
    ]);
    expect(flagged).toHaveLength(6);
    for (const entry of flagged) {
      expect(entry.action).toBe("regenerate");
      expect(entry.reason).toMatch(/lockfile/);
    }
  });

  it("flags binaries, which have no line structure to merge", () => {
    const flagged = refusalList(["ui/logo.png", "docs/spec.pdf", "bin/tool.wasm", "a/b/data.sqlite"]);
    expect(flagged.map((e: any) => e.path)).toEqual(["ui/logo.png", "docs/spec.pdf", "bin/tool.wasm", "a/b/data.sqlite"]);
    for (const entry of flagged) expect(entry.action).toBe("escalate");
  });

  it("flags the never-travels paths, which are machine-local or secret", () => {
    const flagged = refusalList([
      ".env",
      "compositions/default/.env.local",
      "data/vault.json",
      "compositions/default/local.yml",
      "compositions/default/.garrison/owner.json",
      "apm_modules/_local/x/index.mjs",
      "node_modules/left-pad/index.js",
      ".claude/settings.json"
    ]);
    expect(flagged).toHaveLength(8);
    for (const entry of flagged) expect(entry.action).toBe("escalate");
    expect(flagged.find((e: any) => e.path === "data/vault.json").reason).toMatch(/vault/);
  });

  it("passes ordinary source files through — an over-broad list would block every merge", () => {
    expect(refusalList(["src/lib/runner.ts", "docs/SPEC.md", "fittings/seed/x/apm.yml", "Makefile"])).toEqual([]);
  });

  it("normalises the path shapes a git conflict list can produce", () => {
    expect(refusalList(["./package-lock.json"])[0].path).toBe("package-lock.json");
    expect(refusalList(["web\\pnpm-lock.yaml"])[0].path).toBe("web/pnpm-lock.yaml");
    expect(refusalList([null, undefined, ""])).toEqual([]);
  });

  it("does not mistake a file merely NAMED like a lockfile inside a path", () => {
    // "notes-about-package-lock.json" is a real file someone can write.
    expect(refusalList(["docs/notes-about-package-lock.json"])).toEqual([]);
  });
});

describe("isNonTrivialMerge — rail 2's trigger", () => {
  it("files nothing for a clean fast-forward", () => {
    expect(isNonTrivialMerge({ fastForward: true, conflicts: [], bothChanged: [] })).toBe(false);
    // Even a fast-forward that touched many files stays trivial: nothing of ours
    // could have been lost, so a card would be noise.
    expect(isNonTrivialMerge({ fastForward: true, conflicts: ["a"], bothChanged: ["b"] })).toBe(false);
  });

  it("files a card for any conflict resolved or any file both sides changed", () => {
    expect(isNonTrivialMerge({ fastForward: false, conflicts: ["src/a.ts"] })).toBe(true);
    expect(isNonTrivialMerge({ fastForward: false, conflicts: [], bothChanged: ["src/b.ts"] })).toBe(true);
  });

  it("files nothing for a true merge that touched disjoint files", () => {
    expect(isNonTrivialMerge({ fastForward: false, conflicts: [], bothChanged: [] })).toBe(false);
  });
});
