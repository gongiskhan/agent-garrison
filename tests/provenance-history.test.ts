import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import {
  readLedger,
  recordWritten,
  recordWrittenBatch,
  parkEntry,
  unparkEntry,
  forgetEntry
} from "@/lib/provenance";
import { provenanceLedgerPath } from "@/lib/claude-home";

// The append-only history contract (S3f1, RUN_SPEC assumption 3, constraint 10):
// a primitive keeps its ownership lineage as it is written, moved between
// fittings, parked, and unparked. Echo-suppression via lastWrittenHash must be
// unaffected. These exercise the provenance functions directly against an
// isolated ledger (GARRISON_HOME -> temp dir).

let garrisonRoot: string;
let priorHome: string | undefined;

beforeEach(() => {
  priorHome = process.env.GARRISON_HOME;
  garrisonRoot = fs.mkdtempSync(path.join(os.tmpdir(), "gar-prov-"));
  process.env.GARRISON_HOME = garrisonRoot;
});

afterEach(() => {
  if (priorHome === undefined) delete process.env.GARRISON_HOME;
  else process.env.GARRISON_HOME = priorHome;
  fs.rmSync(garrisonRoot, { recursive: true, force: true });
});

describe("recordWritten history", () => {
  it("records a 'written' event on first ownership", async () => {
    await recordWritten("skill:foo", "sha256:aaa", { surface: "skill", fittingId: "garrison-skills" });
    const ledger = await readLedger();
    expect(ledger["skill:foo"].fittingId).toBe("garrison-skills");
    expect(ledger["skill:foo"].lastWrittenHash).toBe("sha256:aaa");
    expect(ledger["skill:foo"].history).toEqual([
      expect.objectContaining({ fittingId: "garrison-skills", event: "written" })
    ]);
  });

  it("appends a 'moved' event preserving the prior owner when fittingId changes", async () => {
    await recordWritten("skill:garrison-plan", "sha256:aaa", {
      surface: "skill",
      fittingId: "garrison-skills"
    });
    await recordWritten("skill:garrison-plan", "sha256:bbb", {
      surface: "skill",
      fittingId: "duty-plan"
    });

    const entry = (await readLedger())["skill:garrison-plan"];
    // Current owner updated...
    expect(entry.fittingId).toBe("duty-plan");
    expect(entry.lastWrittenHash).toBe("sha256:bbb");
    // ...and the move is recorded, preserving the prior owner.
    const moved = entry.history!.filter((h) => h.event === "moved");
    expect(moved).toHaveLength(1);
    expect(moved[0].fittingId).toBe("garrison-skills");
    expect(moved[0].at).toMatch(/^\d{4}-\d\d-\d\dT/);
  });

  it("does not grow history on repeated writes with the same owner", async () => {
    await recordWritten("skill:foo", "sha256:a", { surface: "skill", fittingId: "garrison-skills" });
    await recordWritten("skill:foo", "sha256:b", { surface: "skill", fittingId: "garrison-skills" });
    await recordWritten("skill:foo", "sha256:c", { surface: "skill", fittingId: "garrison-skills" });
    const entry = (await readLedger())["skill:foo"];
    expect(entry.history).toHaveLength(1);
    expect(entry.lastWrittenHash).toBe("sha256:c");
  });

  it("does not append a history event when no owner is supplied", async () => {
    await recordWritten("rule:x", "sha256:a");
    const entry = (await readLedger())["rule:x"];
    expect(entry.history).toEqual([]);
    expect(entry.lastWrittenHash).toBe("sha256:a");
  });
});

describe("recordWrittenBatch history", () => {
  it("records the same move semantics per entry", async () => {
    await recordWrittenBatch([
      { id: "skill:a", surface: "skill", fittingId: "owner-1", lastWrittenHash: "sha256:1" }
    ]);
    await recordWrittenBatch([
      { id: "skill:a", surface: "skill", fittingId: "owner-2", lastWrittenHash: "sha256:2" }
    ]);
    const entry = (await readLedger())["skill:a"];
    expect(entry.fittingId).toBe("owner-2");
    expect(entry.history!.map((h) => h.event)).toEqual(["written", "moved"]);
    expect(entry.history!.find((h) => h.event === "moved")!.fittingId).toBe("owner-1");
  });
});

describe("parkEntry / unparkEntry lineage", () => {
  it("park preserves history, appends 'parked', and drops the live hash", async () => {
    await recordWritten("skill:foo", "sha256:aaa", { surface: "skill", fittingId: "duty-plan" });
    await parkEntry("skill:foo");

    const entry = (await readLedger())["skill:foo"];
    // Echo-suppression: no live hash after park (identical to a deleted entry).
    expect(entry.lastWrittenHash).toBeUndefined();
    expect(entry.fittingId).toBeUndefined();
    // History survived and gained a 'parked' event naming the owner at park time.
    expect(entry.history!.map((h) => h.event)).toEqual(["written", "parked"]);
    const parked = entry.history!.find((h) => h.event === "parked")!;
    expect(parked.fittingId).toBe("duty-plan");
  });

  it("park on an absent entry is a no-op", async () => {
    await parkEntry("skill:missing");
    expect((await readLedger())["skill:missing"]).toBeUndefined();
  });

  it("unpark appends an 'unparked' event, continuing the lineage", async () => {
    await recordWritten("skill:foo", "sha256:aaa", { surface: "skill", fittingId: "duty-plan" });
    await parkEntry("skill:foo");
    await unparkEntry("skill:foo");

    const entry = (await readLedger())["skill:foo"];
    expect(entry.history!.map((h) => h.event)).toEqual(["written", "parked", "unparked"]);
  });

  it("a full write -> move -> park -> unpark -> re-promote lineage is complete", async () => {
    await recordWritten("skill:foo", "sha256:1", { surface: "skill", fittingId: "garrison-skills" });
    await recordWritten("skill:foo", "sha256:2", { surface: "skill", fittingId: "duty-plan" });
    await parkEntry("skill:foo");
    await unparkEntry("skill:foo");
    await recordWritten("skill:foo", "sha256:3", { surface: "skill", fittingId: "duty-plan" });

    const events = (await readLedger())["skill:foo"].history!.map((h) => h.event);
    expect(events).toEqual(["written", "moved", "parked", "unparked", "written"]);
  });
});

describe("forgetEntry still hard-deletes", () => {
  it("removes the entry and its history entirely", async () => {
    await recordWritten("skill:foo", "sha256:aaa", { surface: "skill", fittingId: "duty-plan" });
    await forgetEntry("skill:foo");
    expect((await readLedger())["skill:foo"]).toBeUndefined();
  });
});
