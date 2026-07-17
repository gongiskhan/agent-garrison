import { mkdtempSync, rmSync, readdirSync } from "node:fs";
import { tmpdir } from "node:os";
import path from "node:path";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import {
  drillHomeDir,
  newDrillRun,
  saveDrillRun,
  getDrillRun,
  listDrillRuns,
  addFeedback,
  setOverride,
  addObservation,
  addFinding,
  setFindingStatus,
  confirmedFindings
} from "../fittings/seed/drill/lib/runs-store.mjs";

let dir: string;
beforeEach(() => {
  dir = mkdtempSync(path.join(tmpdir(), "garrison-drill-home-"));
  process.env.GARRISON_HOME = dir;
});
afterEach(() => {
  delete process.env.GARRISON_HOME;
  rmSync(dir, { recursive: true, force: true });
});

describe("drillHomeDir", () => {
  it("nests under GARRISON_HOME/drill", () => {
    expect(drillHomeDir()).toBe(path.join(dir, "drill"));
  });
});

describe("Drill run records (machine-local, atomic)", () => {
  it("round-trips a new run and lists it, most recent first", async () => {
    const r1 = newDrillRun({ contextTag: "drill" });
    await saveDrillRun(r1);
    await new Promise((r) => setTimeout(r, 2));
    const r2 = newDrillRun({ contextTag: "drill-adversarial" });
    await saveDrillRun(r2);

    expect(await getDrillRun(r1.id)).toMatchObject({ id: r1.id, contextTag: "drill" });
    const list = await listDrillRuns();
    expect(list.map((r) => r.id)).toEqual([r2.id, r1.id]);
  });

  it("rejects a path-traversal run id", async () => {
    await expect(getDrillRun("../escape")).rejects.toThrow(/invalid run id/);
  });

  it("writes atomically (no leftover .tmp files)", async () => {
    await saveDrillRun(newDrillRun());
    const files = readdirSync(path.join(dir, "drill", "runs"));
    expect(files.some((f) => f.endsWith(".tmp"))).toBe(false);
  });
});

describe("per-step feedback + verdict overrides (D4/D5)", () => {
  it("addFeedback appends notes keyed by page:step, no re-run needed", () => {
    const r = newDrillRun();
    addFeedback(r, "chat", "s1", "sources render ~6s after the answer finished");
    addFeedback(r, "chat", "s1", "still slow on the next run");
    expect(r.feedback["chat:s1"]).toHaveLength(2);
    expect(r.feedback["chat:s1"][0].note).toContain("sources render");
  });

  it("setOverride flips a verdict in either direction with a note", () => {
    const r = newDrillRun();
    setOverride(r, "chat", "s1", "failed", "a pass I know is wrong");
    expect(r.overrides["chat:s1"]).toMatchObject({ verdict: "failed", note: "a pass I know is wrong" });
    setOverride(r, "chat", "s1", "passed", "actually fine on recheck");
    expect(r.overrides["chat:s1"].verdict).toBe("passed"); // overwrites, doesn't stack
  });
});

describe("run-level observations (D9)", () => {
  it("addObservation records a free-form note, unconverted by default", () => {
    const r = newDrillRun();
    const obs = addObservation(r, "Sources panel flickered twice while the answer streamed.");
    expect(r.observations).toHaveLength(1);
    expect(obs.convertedToStep).toBeNull();
    expect(obs.convertedToFinding).toBeNull();
  });
});

describe("findings report: triage (D10/R10)", () => {
  it("pools findings as proposed, then confirm/dismiss, and confirmedFindings filters correctly", () => {
    const r = newDrillRun();
    const f1 = addFinding(r, { kind: "step-fail", pageId: "chat", stepId: "s3", text: "citation mapping bug" });
    const f2 = addFinding(r, { kind: "ux", pageId: "chat", text: "focus ring contrast" });
    expect(f1.status).toBe("proposed");
    setFindingStatus(r, f1.id, "confirmed");
    setFindingStatus(r, f2.id, "dismissed");
    expect(confirmedFindings(r)).toHaveLength(1);
    expect(confirmedFindings(r)[0].id).toBe(f1.id);
  });

  it("rejects an unknown finding id or an invalid status", () => {
    const r = newDrillRun();
    expect(() => setFindingStatus(r, "nope", "confirmed")).toThrow(/not found/);
    const f = addFinding(r, { kind: "observation", pageId: "chat", text: "x" });
    expect(() => setFindingStatus(r, f.id, "archived" as any)).toThrow(/invalid finding status/);
  });
});
