// D9 backstop (2026-07-11) — when the chat reply loses the next-step token
// (observed: a Workflow completion banner swallowing the operative's final
// line), the engine reads the verdict from the phase's own durable gate record
// (gateEvidenceNextList) before spending an LLM nudge turn. These tests pin the
// reader across the three shapes gates land in on disk.
import { describe, it, expect, beforeEach, afterAll } from "vitest";
import path from "node:path";
import { mkdtempSync, mkdirSync, writeFileSync, rmSync, utimesSync } from "node:fs";
import { tmpdir } from "node:os";
import { pathToFileURL } from "node:url";

const ROOT = path.resolve(__dirname, "..");
const policyMod = () =>
  import(pathToFileURL(path.join(ROOT, "fittings/seed/kanban-loop/lib/policy.mjs")).href);

let cwd: string;
let runDir: string;

beforeEach(() => {
  cwd = mkdtempSync(path.join(tmpdir(), "kgv-"));
  runDir = path.join(cwd, "runs", "r1");
  mkdirSync(runDir, { recursive: true });
});
afterAll(() => {
  rmSync(cwd, { recursive: true, force: true });
});

describe("gateEvidenceNextList — durable verdict reader", () => {
  it("reads next_phase from the per-phase sidecar (the observed review case)", async () => {
    const { gateEvidenceNextList } = await policyMod();
    writeFileSync(
      path.join(runDir, "gate-status.review.json"),
      JSON.stringify({ phase: "review", status: "complete", verdict: "approve", next_phase: "adversarial-review" })
    );
    expect(gateEvidenceNextList(cwd, runDir, "review", ["adversarial-review", "implement"])).toBe("adversarial-review");
  });

  it("reads next_phase from the run-level gates{} entry, camelCase key included", async () => {
    const { gateEvidenceNextList } = await policyMod();
    writeFileSync(
      path.join(runDir, "gate-status.json"),
      JSON.stringify({ gates: { adversarialReview: { status: "passed", next_phase: "test" } } })
    );
    expect(gateEvidenceNextList(cwd, runDir, "adversarial-review", ["test", "implement"])).toBe("test");
  });

  it("honors a FAILED gate's loop-back target", async () => {
    const { gateEvidenceNextList } = await policyMod();
    writeFileSync(
      path.join(runDir, "gate-status.review.json"),
      JSON.stringify({ phase: "review", status: "failed", verdict: "rework", next_phase: "implement" })
    );
    expect(gateEvidenceNextList(cwd, runDir, "review", ["adversarial-review", "implement"])).toBe("implement");
  });

  it("rejects a next_phase outside validNext (never lets the record teleport a card)", async () => {
    const { gateEvidenceNextList } = await policyMod();
    writeFileSync(
      path.join(runDir, "gate-status.review.json"),
      JSON.stringify({ phase: "review", status: "complete", next_phase: "done" })
    );
    expect(gateEvidenceNextList(cwd, runDir, "review", ["adversarial-review", "implement"])).toBeNull();
  });

  it("returns null when there is no gate record or no next_phase", async () => {
    const { gateEvidenceNextList, inspectPhaseGateEvidence } = await policyMod();
    expect(gateEvidenceNextList(cwd, runDir, "review", ["implement"])).toBeNull();
    writeFileSync(path.join(runDir, "gate-status.review.json"), JSON.stringify({ phase: "review", status: "complete" }));
    expect(gateEvidenceNextList(cwd, runDir, "review", ["implement"])).toBeNull();
    expect(inspectPhaseGateEvidence(cwd, runDir, "review")).toEqual({
      exists: true,
      declaresNext: false,
      nextLists: []
    }); // status-only historical gates remain compatible evidence
  });

  it("distinguishes an explicit mismatched verdict from a status-only legacy gate", async () => {
    const { inspectPhaseGateEvidence } = await policyMod();
    writeFileSync(
      path.join(runDir, "gate-status.test.json"),
      JSON.stringify({ phase: "test", status: "passed", next_phase: "adversarial-test" })
    );
    expect(inspectPhaseGateEvidence(cwd, runDir, "test")).toEqual({
      exists: true,
      declaresNext: true,
      nextLists: ["adversarial-test"]
    });
  });

  it("uses the newest phase record so a stale matching aggregate cannot mask a current mismatching sidecar", async () => {
    const { gateEvidenceNextList, inspectPhaseGateEvidence } = await policyMod();
    const stale = path.join(runDir, "gate-status.json");
    const current = path.join(runDir, "gate-status.test.json");
    writeFileSync(stale, JSON.stringify({ gates: { test: { status: "passed", next_phase: "done" } } }));
    writeFileSync(current, JSON.stringify({ phase: "test", status: "passed", next_phase: "adversarial-test" }));
    utimesSync(stale, new Date("2026-01-01T00:00:00Z"), new Date("2026-01-01T00:00:00Z"));
    utimesSync(current, new Date("2026-01-01T00:01:00Z"), new Date("2026-01-01T00:01:00Z"));

    expect(inspectPhaseGateEvidence(cwd, runDir, "test")).toEqual({
      exists: true,
      declaresNext: true,
      nextLists: ["adversarial-test"]
    });
    expect(gateEvidenceNextList(cwd, runDir, "test", ["done", "adversarial-test"])).toBe("adversarial-test");
  });

  it("ignores a newer aggregate that has no entry for the requested phase", async () => {
    const { inspectPhaseGateEvidence } = await policyMod();
    const current = path.join(runDir, "gate-status.test.json");
    const unrelated = path.join(runDir, "gate-status.json");
    writeFileSync(current, JSON.stringify({ phase: "test", status: "passed", next_phase: "done" }));
    writeFileSync(unrelated, JSON.stringify({ gates: { review: { status: "passed", next_phase: "test" } } }));
    utimesSync(current, new Date("2026-01-01T00:00:00Z"), new Date("2026-01-01T00:00:00Z"));
    utimesSync(unrelated, new Date("2026-01-01T00:01:00Z"), new Date("2026-01-01T00:01:00Z"));

    expect(inspectPhaseGateEvidence(cwd, runDir, "test")).toEqual({
      exists: true,
      declaresNext: true,
      nextLists: ["done"]
    });
  });
});
