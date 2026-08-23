import { existsSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import path from "node:path";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { readSidebarPins, sidebarPinsPath, writeSidebarPins } from "@/lib/sidebar-pins";
import { shouldAutoExpandGroup } from "@/components/chrome/Sidebar";

// The sidebar Pinned group's server-side store (~/.garrison/sidebar-pins.json).
// Sandbox GARRISON_HOME so the user's real pins are never touched.

let sandbox: string;
const priorHome = process.env.GARRISON_HOME;

beforeEach(() => {
  sandbox = mkdtempSync(path.join(tmpdir(), "garrison-sidebar-pins-"));
  process.env.GARRISON_HOME = sandbox;
});

afterEach(() => {
  if (priorHome === undefined) {
    delete process.env.GARRISON_HOME;
  } else {
    process.env.GARRISON_HOME = priorHome;
  }
  rmSync(sandbox, { recursive: true, force: true });
});

describe("sidebar pins store", () => {
  it("reads empty when the file is absent", async () => {
    expect(await readSidebarPins()).toEqual({ version: 1, pinned: [] });
  });

  it("round-trips pins in order and writes the file under GARRISON_HOME", async () => {
    await writeSidebarPins(["drill", "web-channel-default", "basic-memory"]);
    expect(sidebarPinsPath().startsWith(sandbox)).toBe(true);
    expect(existsSync(sidebarPinsPath())).toBe(true);
    expect((await readSidebarPins()).pinned).toEqual([
      "drill",
      "web-channel-default",
      "basic-memory"
    ]);
  });

  it("a full-replace write reorders and unpins", async () => {
    await writeSidebarPins(["a1", "b2", "c3"]);
    await writeSidebarPins(["c3", "a1"]);
    expect((await readSidebarPins()).pinned).toEqual(["c3", "a1"]);
  });

  it("dedupes while preserving first occurrence", async () => {
    const result = await writeSidebarPins(["drill", "drill", "taste"]);
    expect(result.pinned).toEqual(["drill", "taste"]);
  });

  it("drops malformed ids without blocking the rest of the write", async () => {
    // One bad entry must never eat the whole list (a rejected write would
    // silently kill pin persistence for the session).
    expect((await writeSidebarPins(["../escape", "ok"])).pinned).toEqual(["ok"]);
    expect((await writeSidebarPins(["ok", ""])).pinned).toEqual(["ok"]);
    expect((await readSidebarPins()).pinned).toEqual(["ok"]);
  });

  it("accepts clone-shaped ids (dots and underscores)", async () => {
    const result = await writeSidebarPins(["drill_v2", "drill.mine", "web-channel-default"]);
    expect(result.pinned).toEqual(["drill_v2", "drill.mine", "web-channel-default"]);
  });

  it("tolerates a corrupt file by reading empty (and filters junk entries)", async () => {
    writeFileSync(sidebarPinsPath(), "{not json");
    expect((await readSidebarPins()).pinned).toEqual([]);
    writeFileSync(
      sidebarPinsPath(),
      JSON.stringify({ version: 1, pinned: ["good", 42, "../bad", "good"] })
    );
    expect((await readSidebarPins()).pinned).toEqual(["good"]);
    // The store file itself is untouched by reads.
    expect(readFileSync(sidebarPinsPath(), "utf8")).toContain("42");
  });
});

describe("clicking a pinned fitting does not reorganise the menu", () => {
  // The report: clicking a row in the Pinned group opened the page AND expanded
  // that fitting's category group. The pin is there so the row is reachable
  // without expanding anything, so the expansion was pure noise.
  it("skips the auto-expand for a pinned fitting", () => {
    expect(
      shouldAutoExpandGroup({ activeGroupId: "interfaces", pinsLoaded: true, activeIsPinned: true })
    ).toBe(false);
  });

  it("still expands for an unpinned fitting, so navigation context is never hidden", () => {
    expect(
      shouldAutoExpandGroup({ activeGroupId: "interfaces", pinsLoaded: true, activeIsPinned: false })
    ).toBe(true);
  });

  it("waits for the pin list before deciding", () => {
    // Pins load from the server; an empty list before that means "unknown", and
    // acting on it would expand the very group a pin was meant to skip.
    expect(
      shouldAutoExpandGroup({ activeGroupId: "interfaces", pinsLoaded: false, activeIsPinned: false })
    ).toBe(false);
  });

  it("does nothing when the route is not a fitting", () => {
    expect(shouldAutoExpandGroup({ activeGroupId: null, pinsLoaded: true, activeIsPinned: false })).toBe(false);
  });
});
