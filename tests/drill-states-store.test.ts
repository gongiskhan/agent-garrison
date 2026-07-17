import { mkdtempSync, rmSync, existsSync, readdirSync } from "node:fs";
import { tmpdir } from "node:os";
import path from "node:path";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { saveSnapshot, listSnapshots, getSnapshot, drillHomeDir } from "../fittings/seed/drill/lib/snapshots.mjs";
import { promoteSnapshotToState, slugifyStateId } from "../fittings/seed/drill/lib/states.mjs";
import { savePage, getPage } from "../fittings/seed/drill/lib/store.mjs";

let ghome: string;
let target: string;
beforeEach(() => {
  ghome = mkdtempSync(path.join(tmpdir(), "garrison-states-home-"));
  target = mkdtempSync(path.join(tmpdir(), "garrison-states-target-"));
  process.env.GARRISON_HOME = ghome;
  process.env.GARRISON_DRILL_TARGET_REPO = target;
});
afterEach(() => {
  delete process.env.GARRISON_HOME;
  delete process.env.GARRISON_DRILL_TARGET_REPO;
  rmSync(ghome, { recursive: true, force: true });
  rmSync(target, { recursive: true, force: true });
});

describe("snapshots (C3, machine-local, atomic)", () => {
  it("saves a snapshot with its screenshot as a plain file, lists it, reads it back", async () => {
    const b64 = Buffer.from([0xff, 0xd8, 0xff, 0xd9]).toString("base64");
    const saved = await saveSnapshot("build", { url: "https://x/build", title: "Build", headingText: "Building", shapeSketch: "a:1,b:1", viewport: { w: 1280, h: 800 }, screenshotB64: b64 });
    expect(saved.pageId).toBe("build");
    expect(existsSync(saved.screenshotPath!)).toBe(true);

    const list = await listSnapshots("build");
    expect(list).toHaveLength(1);
    expect(list[0].id).toBe(saved.id);

    expect(await getSnapshot("build", saved.id)).toMatchObject({ id: saved.id, headingText: "Building" });
    expect(await getSnapshot("build", "nope")).toBeNull();
  });

  it("a snapshot with no screenshot still saves (screenshotPath null)", async () => {
    const saved = await saveSnapshot("kb", { url: "https://x/kb", title: "KB", headingText: "KB", shapeSketch: "" });
    expect(saved.screenshotPath).toBeNull();
  });

  it("lists most-recent first and scopes snapshots per page", async () => {
    await saveSnapshot("build", { url: "u", title: "t", headingText: "h1", shapeSketch: "" });
    await new Promise((r) => setTimeout(r, 2));
    const second = await saveSnapshot("build", { url: "u", title: "t", headingText: "h2", shapeSketch: "" });
    await saveSnapshot("other-page", { url: "u", title: "t", headingText: "h3", shapeSketch: "" });
    const list = await listSnapshots("build");
    expect(list).toHaveLength(2);
    expect(list[0].id).toBe(second.id);
  });

  it("nests snapshots under GARRISON_HOME/drill/snapshots/<projectKey>/<pageId>, never the target app repo", async () => {
    const saved = await saveSnapshot("build", { url: "u", title: "t", headingText: "h", shapeSketch: "", screenshotB64: Buffer.from([1]).toString("base64") });
    // Project-scoped since the project-picker change: a hash segment for the
    // target root sits between snapshots/ and the pageId.
    expect(saved.screenshotPath!.startsWith(path.join(ghome, "drill", "snapshots") + path.sep)).toBe(true);
    expect(path.basename(path.dirname(saved.screenshotPath!))).toBe("build");
    expect(saved.project).toBeTruthy();
    expect(readdirSync(target)).not.toContain("drill"); // never leaked into the repo
  });
});

describe("slugifyStateId", () => {
  it("lowercases, replaces non-alphanumerics, trims edges", () => {
    expect(slugifyStateId("Building…")).toBe("building");
    expect(slugifyStateId("  New Build!! ")).toBe("new-build");
    expect(slugifyStateId("")).toBe("state");
  });
});

describe("promoteSnapshotToState (C4)", () => {
  it("writes the state's fingerprint + reachPath + screenshotPath into the page's repo YAML", async () => {
    await savePage("build", { title: "Builder", path: "/build", states: [] });
    const b64 = Buffer.from([0xff, 0xd8, 0xff, 0xd9]).toString("base64");
    const snap = await saveSnapshot("build", { url: "https://x/build", title: "Build", headingText: "Building", shapeSketch: "a:1,b:1,c:1", viewport: { w: 1280, h: 800 }, screenshotB64: b64 });

    const state = await promoteSnapshotToState("build", snap.id, { label: "building", reachPath: [{ id: "reach-1", description: "click start build" }] });
    expect(state).toMatchObject({
      id: "building",
      label: "building",
      fingerprint: { url: "https://x/build", headingText: "Building", shapeSketch: "a:1,b:1,c:1" },
      matcher: { assertion: null },
      reachPath: [{ id: "reach-1", description: "click start build" }],
      screenshotPath: snap.screenshotPath
    });

    const reloaded = await getPage("build");
    expect(reloaded?.states).toHaveLength(1);
    expect(reloaded?.states[0].id).toBe("building");
  });

  it("re-promoting the SAME state id replaces it, not duplicates it", async () => {
    await savePage("build", { title: "Builder", path: "/build", states: [] });
    const snap1 = await saveSnapshot("build", { url: "u1", title: "t", headingText: "Building", shapeSketch: "a:1" });
    const snap2 = await saveSnapshot("build", { url: "u2", title: "t", headingText: "Building", shapeSketch: "b:1" });
    await promoteSnapshotToState("build", snap1.id, { label: "building" });
    await promoteSnapshotToState("build", snap2.id, { label: "building" });
    const reloaded = await getPage("build");
    expect(reloaded?.states).toHaveLength(1);
    expect(reloaded?.states[0].fingerprint.shapeSketch).toBe("b:1"); // the second promotion won
  });

  it("preserves other existing states on the page", async () => {
    await savePage("build", { title: "Builder", path: "/build", states: [{ id: "default", label: "default" }] });
    const snap = await saveSnapshot("build", { url: "u", title: "t", headingText: "Building", shapeSketch: "a:1" });
    await promoteSnapshotToState("build", snap.id, { label: "building" });
    const reloaded = await getPage("build");
    expect(reloaded?.states.map((s: any) => s.id).sort()).toEqual(["building", "default"]);
  });

  it("throws for a missing page or a missing snapshot", async () => {
    await expect(promoteSnapshotToState("missing", "x", {})).rejects.toThrow(/page not found/);
    await savePage("build", { title: "Builder", path: "/build" });
    await expect(promoteSnapshotToState("build", "missing-snap", {})).rejects.toThrow(/snapshot not found/);
  });
});
