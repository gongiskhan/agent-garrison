// build-info.ts shells out to `git rev-parse --short HEAD` and caches the
// result. This asserts the one obvious thing: it returns a real short SHA
// in this checkout, and degrades to null (never throws) when git fails.
import { describe, it, expect, beforeEach } from "vitest";
import { readBuildSha, resetBuildInfoCache } from "../src/lib/build-info";

beforeEach(() => {
  resetBuildInfoCache();
});

describe("readBuildSha", () => {
  it("returns this checkout's short hex HEAD", () => {
    const sha = readBuildSha();
    expect(sha).toMatch(/^[0-9a-f]{7,}$/);
  });

  it("caches across calls until reset", () => {
    const first = readBuildSha();
    const second = readBuildSha();
    expect(second).toBe(first);
  });

  it("degrades to null instead of throwing when git fails", () => {
    const cwd = process.cwd();
    process.chdir("/");
    try {
      resetBuildInfoCache();
      expect(readBuildSha()).toBeNull();
    } finally {
      process.chdir(cwd);
      resetBuildInfoCache();
    }
  });
});
