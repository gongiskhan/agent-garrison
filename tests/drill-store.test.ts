import { mkdtempSync, rmSync, readdirSync } from "node:fs";
import { tmpdir } from "node:os";
import path from "node:path";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import {
  drillTargetRoot,
  safeId,
  getDrillBook,
  saveDrillBook,
  defaultDrillBook,
  listPages,
  getPage,
  savePage,
  defaultPage,
  deletePage,
  parseAreaRef
} from "../fittings/seed/drill/lib/store.mjs";

// Drill Book store (A1/A2, R6) — plans live in the TARGET APP repo, atomic
// writes (temp + rename + read-back verification), strict id sanitizing.

let dir: string;
let ghome: string;
const prevGarrisonHome = process.env.GARRISON_HOME;
beforeEach(() => {
  dir = mkdtempSync(path.join(tmpdir(), "garrison-drill-store-"));
  // GARRISON_HOME must be isolated too: drillTargetRoot() consults
  // activeProjectRoot() BEFORE the env pin, and the real ~/.garrison carries
  // the live UI's project selection - without this pin the test reads
  // whatever repo the user last selected instead of `dir`.
  ghome = mkdtempSync(path.join(tmpdir(), "garrison-drill-store-home-"));
  process.env.GARRISON_DRILL_TARGET_REPO = dir;
  process.env.GARRISON_HOME = ghome;
});
afterEach(() => {
  delete process.env.GARRISON_DRILL_TARGET_REPO;
  if (prevGarrisonHome === undefined) delete process.env.GARRISON_HOME;
  else process.env.GARRISON_HOME = prevGarrisonHome;
  rmSync(dir, { recursive: true, force: true });
  rmSync(ghome, { recursive: true, force: true });
});

describe("drillTargetRoot", () => {
  it("resolves from GARRISON_DRILL_TARGET_REPO", () => {
    expect(drillTargetRoot()).toBe(dir);
  });
});

describe("safeId", () => {
  it("accepts a clean slug and rejects path traversal", () => {
    expect(safeId("chat")).toBe("chat");
    expect(() => safeId("../escape")).toThrow(/invalid id/);
    expect(() => safeId("a/b")).toThrow(/invalid id/);
  });
});

describe("Drill Book (book-level)", () => {
  it("returns the default book when none exists on disk", async () => {
    expect(await getDrillBook()).toEqual(defaultDrillBook());
  });

  it("saveDrillBook merges onto the current on-disk book, writes atomically, and reads back", async () => {
    await saveDrillBook({ app: { name: "ekoa", url: "http://localhost:3000" } });
    const saved = await saveDrillBook({ fullDrill: true });
    expect(saved).toMatchObject({ app: { name: "ekoa", url: "http://localhost:3000" }, fullDrill: true });
    const reloaded = await getDrillBook();
    expect(reloaded).toEqual(saved);
    // no leftover .tmp files after a successful write
    const files = readdirSync(path.join(dir, "drills"));
    expect(files.some((f) => f.endsWith(".tmp"))).toBe(false);
  });
});

describe("Pages (per-page plan)", () => {
  it("lists no pages initially, then round-trips a saved page", async () => {
    expect(await listPages()).toEqual([]);
    const saved = await savePage("chat", { title: "Chat", path: "/chat" });
    expect(saved).toMatchObject({ id: "chat", title: "Chat", path: "/chat", mode: "steps" });
    expect(await getPage("chat")).toEqual(saved);
    expect(await listPages()).toEqual([saved]);
  });

  it("savePage merges onto the existing page (subtree-only mutation), not a full overwrite", async () => {
    await savePage("chat", { title: "Chat", areas: [{ n: 1, id: "chat#1", label: "Composer" }] });
    const updated = await savePage("chat", { title: "Chat (renamed)" });
    expect(updated.title).toBe("Chat (renamed)");
    expect(updated.areas).toEqual([{ n: 1, id: "chat#1", label: "Composer" }]); // preserved, not dropped
  });

  it("defaults a new page's shape", () => {
    expect(defaultPage("kb")).toMatchObject({ id: "kb", mode: "steps", areas: [], steps: [], states: [] });
  });

  it("deletePage removes the file and reports false for a missing page", async () => {
    await savePage("kb", { title: "Knowledge base" });
    expect(await deletePage("kb")).toBe(true);
    expect(await getPage("kb")).toBeNull();
    expect(await deletePage("kb")).toBe(false);
  });

  it("rejects a path-traversal page id", async () => {
    await expect(savePage("../escape", {})).rejects.toThrow(/invalid id/);
    await expect(getPage("../escape")).rejects.toThrow(/invalid id/);
  });

  it("skips an unparseable page file instead of failing the whole list", async () => {
    await savePage("chat", { title: "Chat" });
    const { writeFileSync, mkdirSync } = await import("node:fs");
    mkdirSync(path.join(dir, "drills", "pages"), { recursive: true });
    writeFileSync(path.join(dir, "drills", "pages", "broken.yml"), "not: [valid: yaml: at all");
    const pages = await listPages();
    expect(pages.map((p) => p.id)).toEqual(["chat"]);
  });
});

describe("parseAreaRef (B10/S16 cross-page refs)", () => {
  it("splits page#area", () => {
    expect(parseAreaRef("kb#entry-detail")).toEqual({ pageId: "kb", areaId: "entry-detail" });
  });
  it("returns null for a malformed ref", () => {
    expect(parseAreaRef("no-hash")).toBeNull();
    expect(parseAreaRef("#nopage")).toBeNull();
    expect(parseAreaRef("nopage#")).toBeNull();
  });
});
