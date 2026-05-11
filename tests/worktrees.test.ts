import fs from "node:fs";
import path from "node:path";
import os from "node:os";
import { describe, expect, it } from "vitest";
import {
  parseWorktreePorcelain,
  slugifyBranch,
  assertValidBranchName,
  assertValidRef,
  InvalidArgumentError
} from "@/lib/worktrees";

describe("parseWorktreePorcelain", () => {
  it("returns an empty list for empty input", () => {
    expect(parseWorktreePorcelain("")).toEqual([]);
  });

  it("parses a single worktree block", () => {
    const output = [
      "worktree /tmp/repo",
      "HEAD 1234567890abcdef1234567890abcdef12345678",
      "branch refs/heads/main",
      ""
    ].join("\n");
    const result = parseWorktreePorcelain(output);
    expect(result).toHaveLength(1);
    expect(result[0].worktreePath).toBe("/tmp/repo");
    expect(result[0].branch).toBe("main");
    expect(result[0].commit).toBe("12345678");
  });

  it("handles a detached HEAD without a branch line", () => {
    const output = [
      "worktree /tmp/repo/wt-detached",
      "HEAD abcdef1234567890abcdef1234567890abcdef12",
      "detached",
      ""
    ].join("\n");
    const result = parseWorktreePorcelain(output);
    expect(result).toHaveLength(1);
    expect(result[0].branch).toBe("(detached)");
  });

  it("parses multiple blocks separated by blank lines", () => {
    const output = [
      "worktree /tmp/repo",
      "HEAD aaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaa",
      "branch refs/heads/main",
      "",
      "worktree /tmp/repo-feature",
      "HEAD bbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbb",
      "branch refs/heads/feature/foo",
      ""
    ].join("\n");
    const result = parseWorktreePorcelain(output);
    expect(result).toHaveLength(2);
    expect(result[0].branch).toBe("main");
    expect(result[1].branch).toBe("feature/foo");
  });

  it("marks the main worktree by resolved path match — not by parse order", () => {
    const tmpRoot = fs.mkdtempSync(path.join(os.tmpdir(), "agent-garrison-wt-"));
    try {
      const main = path.join(tmpRoot, "main-repo");
      const feature = path.join(tmpRoot, "feature-checkout");
      fs.mkdirSync(main, { recursive: true });
      fs.mkdirSync(feature, { recursive: true });
      // Block order intentionally puts the feature worktree first; the old
      // `result.length === 0` heuristic would have called feature "main".
      const output = [
        `worktree ${feature}`,
        "HEAD aaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaa",
        "branch refs/heads/feature",
        "",
        `worktree ${main}`,
        "HEAD bbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbb",
        "branch refs/heads/main",
        ""
      ].join("\n");
      const result = parseWorktreePorcelain(output, main);
      expect(result[0].isMain).toBe(false);
      expect(result[1].isMain).toBe(true);
    } finally {
      fs.rmSync(tmpRoot, { recursive: true, force: true });
    }
  });

  it("returns isMain false everywhere when no repoPath hint is given", () => {
    const output = [
      "worktree /tmp/repo",
      "HEAD aaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaa",
      "branch refs/heads/main",
      ""
    ].join("\n");
    const result = parseWorktreePorcelain(output);
    expect(result[0].isMain).toBe(false);
  });
});

describe("slugifyBranch", () => {
  it("preserves alphanumerics, dots, hyphens, underscores", () => {
    expect(slugifyBranch("feature_foo.bar-1")).toBe("feature_foo.bar-1");
  });

  it("replaces slashes and spaces with hyphens", () => {
    expect(slugifyBranch("feature/my branch")).toBe("feature-my-branch");
  });

  it("trims leading and trailing hyphens", () => {
    expect(slugifyBranch("---foo---")).toBe("foo");
  });

  it("strips unicode and exotic characters and trims trailing hyphens", () => {
    expect(slugifyBranch("féature/ñ")).toBe("f-ature");
  });
});

describe("assertValidBranchName", () => {
  it("accepts a normal branch name", () => {
    expect(() => assertValidBranchName("feature/foo")).not.toThrow();
  });

  it("rejects empty strings", () => {
    expect(() => assertValidBranchName("")).toThrow(InvalidArgumentError);
    expect(() => assertValidBranchName("   ")).toThrow(InvalidArgumentError);
  });

  it("rejects whitespace inside the name", () => {
    expect(() => assertValidBranchName("foo bar")).toThrow(InvalidArgumentError);
  });

  it("rejects names starting with a hyphen", () => {
    expect(() => assertValidBranchName("-foo")).toThrow(InvalidArgumentError);
  });

  it("rejects names containing .. or @{ or backslash", () => {
    expect(() => assertValidBranchName("foo..bar")).toThrow(InvalidArgumentError);
    expect(() => assertValidBranchName("foo@{1}")).toThrow(InvalidArgumentError);
    expect(() => assertValidBranchName("foo\\bar")).toThrow(InvalidArgumentError);
  });
});

describe("assertValidRef", () => {
  it("accepts forms like main, origin/main, release/v2", () => {
    expect(() => assertValidRef("main")).not.toThrow();
    expect(() => assertValidRef("origin/main")).not.toThrow();
    expect(() => assertValidRef("release/v2")).not.toThrow();
  });

  it("rejects empty or whitespace-only refs", () => {
    expect(() => assertValidRef("")).toThrow(InvalidArgumentError);
    expect(() => assertValidRef("   ")).toThrow(InvalidArgumentError);
  });

  it("rejects refs with whitespace, leading hyphen, or git-special sequences", () => {
    expect(() => assertValidRef("foo bar")).toThrow(InvalidArgumentError);
    expect(() => assertValidRef("-foo")).toThrow(InvalidArgumentError);
    expect(() => assertValidRef("foo..bar")).toThrow(InvalidArgumentError);
  });
});
