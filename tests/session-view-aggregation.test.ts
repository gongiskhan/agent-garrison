import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { parseStateJson } from "@/lib/garrison-sessions";

// We test the aggregation logic by testing parseStateJson directly
// (the actual route wires it together; integration is verified against real hardware).

const STATE_FIXTURE = JSON.stringify({
  version: 1,
  projects: {
    "/Users/dev/myapp": {
      path: "/Users/dev/myapp",
      name: "myapp",
      sessions: {
        "feature-x": {
          branch: "feature-x",
          worktreePath: "/Users/dev/myapp/.worktrees/feature-x",
          lastStatus: "working",
          lastStatusAt: "2026-05-11T10:00:00.000Z",
        },
        main: {
          branch: "main",
          worktreePath: "/Users/dev/myapp",
          lastStatus: "idle",
          lastStatusAt: "2026-05-11T09:00:00.000Z",
        },
      },
    },
  },
});

describe("parseStateJson", () => {
  it("parses a valid state.json into WorktreeSession[]", () => {
    const sessions = parseStateJson(STATE_FIXTURE);
    expect(sessions).toHaveLength(2);
    const feature = sessions.find((s) => s.branch === "feature-x");
    expect(feature).toBeDefined();
    expect(feature?.lastStatus).toBe("working");
    expect(feature?.projectName).toBe("myapp");
    expect(feature?.worktreePath).toBe(
      "/Users/dev/myapp/.worktrees/feature-x"
    );
  });

  it("returns empty array for invalid JSON", () => {
    expect(parseStateJson("not json")).toEqual([]);
  });

  it("returns empty array for empty JSON object", () => {
    expect(parseStateJson("{}")).toEqual([]);
  });

  it("handles missing optional fields gracefully", () => {
    const minimal = JSON.stringify({
      version: 1,
      projects: {
        "/p": {
          sessions: {
            main: {}
          }
        }
      }
    });
    const sessions = parseStateJson(minimal);
    expect(sessions).toHaveLength(1);
    expect(sessions[0].lastStatus).toBe("idle");
    expect(sessions[0].branch).toBe("main");
  });
});

// ---------------------------------------------------------------------------
// Outpost cache round-trip (file I/O)
// ---------------------------------------------------------------------------

describe("outpost-cache JSON round-trip", () => {
  let tmpDir: string;

  beforeEach(() => {
    tmpDir = fs.mkdtempSync(path.join(os.tmpdir(), "garrison-agg-"));
  });

  afterEach(() => {
    fs.rmSync(tmpDir, { recursive: true, force: true });
  });

  it("can write and read back the cache format the aggregator uses", async () => {
    const cachePath = path.join(tmpDir, "outpost-cache.json");
    const sessions = parseStateJson(STATE_FIXTURE).map((s) => ({
      ...s,
      machine: "development",
      online: true,
    }));
    const cache: Record<string, typeof sessions> = { development: sessions };
    fs.writeFileSync(cachePath, JSON.stringify(cache, null, 2));
    const loaded = JSON.parse(
      fs.readFileSync(cachePath, "utf8")
    ) as typeof cache;
    expect(loaded.development).toHaveLength(2);
    expect(loaded.development[0].machine).toBe("development");
  });
});
