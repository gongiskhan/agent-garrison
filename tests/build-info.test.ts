import { afterEach, describe, expect, it, vi } from "vitest";

// commitShort() caches at module scope and shells out to git, so each case
// re-imports the module against its own stubbed child_process.
async function loadWithGit(impl: () => string) {
  vi.resetModules();
  const execFileSync = vi.fn(impl);
  vi.doMock("node:child_process", () => ({ execFileSync }));
  const { commitShort } = await import("../src/lib/build-info");
  return { commitShort, execFileSync };
}

const originalCommitEnv = process.env.GARRISON_COMMIT;

afterEach(() => {
  vi.doUnmock("node:child_process");
  vi.resetModules();
  if (originalCommitEnv === undefined) delete process.env.GARRISON_COMMIT;
  else process.env.GARRISON_COMMIT = originalCommitEnv;
});

describe("commitShort", () => {
  it("prefers GARRISON_COMMIT, truncates it, and never spawns git", async () => {
    process.env.GARRISON_COMMIT = "0123456789abcdef0123456789abcdef01234567";
    const { commitShort, execFileSync } = await loadWithGit(() => "deadbee\n");
    expect(commitShort()).toBe("0123456");
    expect(execFileSync).not.toHaveBeenCalled();
  });

  it("trims whitespace around GARRISON_COMMIT", async () => {
    process.env.GARRISON_COMMIT = "  abc1234  ";
    const { commitShort } = await loadWithGit(() => "deadbee\n");
    expect(commitShort()).toBe("abc1234");
  });

  it("falls through to git when GARRISON_COMMIT is blank", async () => {
    process.env.GARRISON_COMMIT = "   ";
    const { commitShort, execFileSync } = await loadWithGit(() => "deadbee\n");
    expect(commitShort()).toBe("deadbee");
    expect(execFileSync).toHaveBeenCalledTimes(1);
  });

  it("reads the short hash from the checkout the server runs in", async () => {
    delete process.env.GARRISON_COMMIT;
    const { commitShort, execFileSync } = await loadWithGit(() => "abcdef0\n");
    expect(commitShort()).toBe("abcdef0");
    expect(execFileSync).toHaveBeenCalledWith(
      "git",
      ["rev-parse", "--short", "HEAD"],
      expect.objectContaining({ cwd: process.cwd(), encoding: "utf8" })
    );
  });

  it("returns null when git fails", async () => {
    delete process.env.GARRISON_COMMIT;
    const { commitShort } = await loadWithGit(() => {
      throw new Error("not a git repository");
    });
    expect(commitShort()).toBeNull();
  });

  it("returns null when git answers with nothing", async () => {
    delete process.env.GARRISON_COMMIT;
    const { commitShort } = await loadWithGit(() => "  \n");
    expect(commitShort()).toBeNull();
  });

  it("serves repeated calls from the cache", async () => {
    delete process.env.GARRISON_COMMIT;
    const { commitShort, execFileSync } = await loadWithGit(() => "abcdef0\n");
    expect(commitShort()).toBe("abcdef0");
    expect(commitShort()).toBe("abcdef0");
    expect(execFileSync).toHaveBeenCalledTimes(1);
  });

  it("works against the real checkout", async () => {
    delete process.env.GARRISON_COMMIT;
    vi.resetModules();
    const { commitShort } = await import("../src/lib/build-info");
    const value = commitShort();
    // Null stays acceptable for environments without git or without a repo.
    expect(value === null || /^[0-9a-f]{7,40}$/.test(value)).toBe(true);
  });
});
