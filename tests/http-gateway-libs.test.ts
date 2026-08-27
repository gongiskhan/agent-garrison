import { describe, expect, it } from "vitest";
import path from "node:path";

const LIB_DIR = path.resolve(__dirname, "..", "fittings", "seed", "http-gateway", "scripts", "lib");

describe("http-gateway libs (Phase 9B)", () => {
  describe("jsonl-watcher / projectDirForCwd", () => {
    it("converts slashes to dashes, keeping the leading dash", async () => {
      const mod = await import(path.join(LIB_DIR, "jsonl-watcher.mjs"));
      expect(mod.projectDirForCwd("/Users/ggomes/Projects/agent-garrison")).toBe(
        "-Users-ggomes-Projects-agent-garrison"
      );
      expect(mod.projectDirForCwd("/tmp/x")).toBe("-tmp-x");
    });

    it("builds JSONL path under ~/.claude/projects/<dir>/<sid>.jsonl", async () => {
      const mod = await import(path.join(LIB_DIR, "jsonl-watcher.mjs"));
      const p = mod.jsonlPath("/foo/bar", "abc-123");
      expect(p).toContain(".claude/projects/-foo-bar/abc-123.jsonl");
    });
  });

});
