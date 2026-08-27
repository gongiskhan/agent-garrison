import { existsSync, mkdtempSync, readFileSync, rmSync, statSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import path from "node:path";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import {
  readSidebarPins,
  setSidebarPinsMeshStore,
  sidebarPinsPath,
  writeSidebarPins,
  type SidebarPinsMeshStore
} from "@/lib/sidebar-pins";
import { StateApiError, StateUnavailableError } from "@/lib/state-client";
import { COMMAND_ITEMS, HOME_ITEM_ID, shouldAutoExpandGroup } from "@/components/chrome/Sidebar";

// The sidebar Pinned group's store. The list is MESH-SHARED (state config doc
// `sidebar.pins`); the file under GARRISON_HOME is the standalone store and the
// degraded-read materialisation. Sandbox GARRISON_HOME so the user's real pins
// are never touched, and drive the mesh side through the injected seam so no
// test can reach a real service.

let sandbox: string;
const priorHome = process.env.GARRISON_HOME;

beforeEach(() => {
  sandbox = mkdtempSync(path.join(tmpdir(), "garrison-sidebar-pins-"));
  process.env.GARRISON_HOME = sandbox;
});

afterEach(() => {
  setSidebarPinsMeshStore(null);
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

  it("accepts nav: command ids alongside fitting ids", async () => {
    // One flat list holds both, so the Pinned group can mix a Garrison route
    // with a fitting; a store that rejected `nav:` ids would silently drop
    // every command pin.
    const result = await writeSidebarPins(["nav:vault", "drill", "nav:quarters"]);
    expect(result.pinned).toEqual(["nav:vault", "drill", "nav:quarters"]);
    expect((await readSidebarPins()).pinned).toEqual(["nav:vault", "drill", "nav:quarters"]);
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
      shouldAutoExpandGroup({ activeGroupId: "fittings", pinsLoaded: true, activeIsReachable: true })
    ).toBe(false);
  });

  it("still expands for an unpinned fitting, so navigation context is never hidden", () => {
    expect(
      shouldAutoExpandGroup({ activeGroupId: "fittings", pinsLoaded: true, activeIsReachable: false })
    ).toBe(true);
  });

  it("waits for the pin list before deciding", () => {
    // Pins load from the server; an empty list before that means "unknown", and
    // acting on it would expand the very group a pin was meant to skip.
    expect(
      shouldAutoExpandGroup({ activeGroupId: "fittings", pinsLoaded: false, activeIsReachable: false })
    ).toBe(false);
  });

  it("treats the dashboard as reachable, so Command does not spring open on /", () => {
    // "/" is where the shell lands and the brand link above the menu goes to the
    // same place. Auto-expanding Command there would leave the group open
    // essentially always, which is not a collapsed menu.
    expect(HOME_ITEM_ID).toBe("nav:garrison");
    expect(COMMAND_ITEMS.find((i) => i.id === HOME_ITEM_ID)?.href).toBe("/");
  });

  it("does nothing when the route is in no group", () => {
    expect(shouldAutoExpandGroup({ activeGroupId: null, pinsLoaded: true, activeIsReachable: false })).toBe(false);
  });
});

// ── the mesh-shared list ───────────────────────────────────────────────────
//
// The whole point of moving pins off the node: pin something on the Air and the
// menu changes on dev-madrid. The seam below stands in for the state service.

function meshSeam(initial: string[] | null): SidebarPinsMeshStore & {
  doc: { pinned: string[]; rev: number } | null;
  writes: number;
  fail: null | (() => never);
} {
  const seam = {
    doc: initial === null ? null : { pinned: initial, rev: 3 },
    writes: 0,
    fail: null as null | (() => never),
    enrolled: () => true,
    async read() {
      if (seam.fail) seam.fail();
      return seam.doc;
    },
    async write(pinned: string[], ifMatchRev: number) {
      if (seam.fail) seam.fail();
      const rev = seam.doc?.rev ?? 0;
      if (ifMatchRev !== rev) throw new StateApiError(409, { error: "rev-mismatch" });
      seam.doc = { pinned, rev: rev + 1 };
      seam.writes += 1;
    }
  };
  return seam;
}

describe("pins are shared across the mesh", () => {
  it("reads the shared document, not this node's file", async () => {
    await writeSidebarPins(["local-only"]);
    setSidebarPinsMeshStore(meshSeam(["drill", "nav:mesh"]));
    expect((await readSidebarPins()).pinned).toEqual(["drill", "nav:mesh"]);
  });

  it("materialises the shared list locally so an outage degrades to it", async () => {
    const seam = meshSeam(["drill", "nav:vault"]);
    setSidebarPinsMeshStore(seam);
    await readSidebarPins();
    // Now the service goes away: the read must still answer with the last
    // known list rather than an empty menu.
    seam.fail = () => {
      throw new StateUnavailableError("http://state.invalid", new Error("down"));
    };
    expect((await readSidebarPins()).pinned).toEqual(["drill", "nav:vault"]);
    expect(JSON.parse(readFileSync(sidebarPinsPath(), "utf8")).pinned).toEqual([
      "drill",
      "nav:vault"
    ]);
  });

  it("does not rewrite the local file when the shared list has not moved", async () => {
    const seam = meshSeam(["drill"]);
    setSidebarPinsMeshStore(seam);
    await readSidebarPins();
    const stamp = readFileSync(sidebarPinsPath(), "utf8");
    const mtime = statSync(sidebarPinsPath()).mtimeMs;
    await new Promise((r) => setTimeout(r, 10));
    await readSidebarPins();
    expect(readFileSync(sidebarPinsPath(), "utf8")).toBe(stamp);
    expect(statSync(sidebarPinsPath()).mtimeMs).toBe(mtime);
  });

  it("seeds the shared document from this node's pins the first time", async () => {
    // Upgrading a mesh that already had per-node pins: the first node to read
    // hands its list to the mesh instead of everyone starting empty.
    await writeSidebarPins(["drill", "nav:quarters"]);
    const seam = meshSeam(null);
    setSidebarPinsMeshStore(seam);
    expect((await readSidebarPins()).pinned).toEqual(["drill", "nav:quarters"]);
    expect(seam.doc?.pinned).toEqual(["drill", "nav:quarters"]);
  });

  it("REFUSES the write when the state service is unreachable", async () => {
    // A local-only write would fork this node's menu from the mesh silently —
    // exactly the drift the shared list exists to remove. Fail loudly instead,
    // and leave the file alone.
    const seam = meshSeam(["drill"]);
    setSidebarPinsMeshStore(seam);
    await readSidebarPins();
    seam.fail = () => {
      throw new StateUnavailableError("http://state.invalid", new Error("down"));
    };
    await expect(writeSidebarPins(["drill", "nav:vault"])).rejects.toBeInstanceOf(
      StateUnavailableError
    );
    expect(JSON.parse(readFileSync(sidebarPinsPath(), "utf8")).pinned).toEqual(["drill"]);
  });

  it("resolves a concurrent write from another node last-writer-wins", async () => {
    // Two nodes pinning at once: the user authored a whole list and cannot act
    // on a conflict, so the second write retries against the fresh revision
    // instead of surfacing a 409.
    const seam = meshSeam(["drill"]);
    setSidebarPinsMeshStore(seam);
    const stale = seam.read.bind(seam);
    let first = true;
    seam.read = async () => {
      const doc = await stale();
      if (first) {
        first = false;
        // Another node lands its write between our read and our put.
        seam.doc = { pinned: ["nav:mesh"], rev: (seam.doc?.rev ?? 0) + 1 };
        return doc;
      }
      return seam.doc;
    };
    expect((await writeSidebarPins(["drill", "nav:vault"])).pinned).toEqual([
      "drill",
      "nav:vault"
    ]);
    expect(seam.doc?.pinned).toEqual(["drill", "nav:vault"]);
  });
});

describe("the Command group", () => {
  it("gives every route a nav: id the pin store accepts", () => {
    for (const item of COMMAND_ITEMS) {
      expect(item.id.startsWith("nav:"), `${item.id} is not nav:-prefixed`).toBe(true);
      expect(item.id).toMatch(/^nav:[a-z0-9][a-z0-9._-]*$/);
    }
  });

  it("has unique ids, labels and routes", () => {
    expect(new Set(COMMAND_ITEMS.map((i) => i.id)).size).toBe(COMMAND_ITEMS.length);
    expect(new Set(COMMAND_ITEMS.map((i) => i.label)).size).toBe(COMMAND_ITEMS.length);
    expect(new Set(COMMAND_ITEMS.map((i) => i.href)).size).toBe(COMMAND_ITEMS.length);
  });

  it("matches its own route and nobody else's", () => {
    // A second item claiming the active route would light two rows at once, and
    // auto-expand would resolve the wrong one.
    for (const item of COMMAND_ITEMS) {
      const matches = COMMAND_ITEMS.filter((other) => other.isActive(item.href));
      expect(matches.map((m) => m.id)).toEqual([item.id]);
    }
  });

  it("leaves fitting routes to the Fittings group", () => {
    for (const route of ["/fitting/drill", "/embed/web-channel-default"]) {
      expect(COMMAND_ITEMS.filter((item) => item.isActive(route))).toEqual([]);
    }
  });
});
