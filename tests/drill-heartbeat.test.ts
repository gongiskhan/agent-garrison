import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import path from "node:path";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { findPendingHeartbeatRuns, runHeartbeatSweep } from "../fittings/seed/drill/lib/heartbeat.mjs";
import { newDrillRun, saveDrillRun, addFinding, setFindingStatus, getDrillRun } from "../fittings/seed/drill/lib/runs-store.mjs";

// D10/S29/self-test-item-7 — heartbeat dispatch pickup: the autonomous flow
// confirms high-confidence findings itself and picks them up on its next
// beat, without a human pressing the button.

let dir: string;
beforeEach(() => {
  dir = mkdtempSync(path.join(tmpdir(), "garrison-heartbeat-"));
  process.env.GARRISON_HOME = dir;
});
afterEach(() => {
  delete process.env.GARRISON_HOME;
  rmSync(dir, { recursive: true, force: true });
});

async function runWithConfirmedFinding(dispatch: string) {
  const r = newDrillRun({ dispatch });
  const f = addFinding(r, { kind: "step-fail", pageId: "chat", stepId: "s1", text: "x" });
  setFindingStatus(r, f.id, "confirmed");
  await saveDrillRun(r);
  return r;
}

describe("findPendingHeartbeatRuns", () => {
  it("only finds heartbeat-mode runs with a confirmed finding and no prior dispatch", async () => {
    const heartbeatRun = await runWithConfirmedFinding("heartbeat");
    await runWithConfirmedFinding("manual"); // wrong mode
    await runWithConfirmedFinding("immediate"); // wrong mode
    const noFindingRun = newDrillRun({ dispatch: "heartbeat" });
    await saveDrillRun(noFindingRun); // heartbeat mode but nothing confirmed

    const pending = await findPendingHeartbeatRuns();
    expect(pending.map((r) => r.id)).toEqual([heartbeatRun.id]);
  });

  it("excludes a heartbeat run that was already dispatched", async () => {
    const r = await runWithConfirmedFinding("heartbeat");
    r.dispatchedAt = new Date().toISOString();
    await saveDrillRun(r);
    expect(await findPendingHeartbeatRuns()).toHaveLength(0);
  });
});

describe("runHeartbeatSweep", () => {
  it("dispatches every pending heartbeat run exactly once and marks dispatchedAt", async () => {
    const r1 = await runWithConfirmedFinding("heartbeat");
    const r2 = await runWithConfirmedFinding("heartbeat");
    const dispatched: string[] = [];
    const dispatchFn = async (record: any) => { dispatched.push(record.id); return { id: `card-for-${record.id}` }; };

    const results = await runHeartbeatSweep(dispatchFn);
    expect(dispatched.sort()).toEqual([r1.id, r2.id].sort());
    expect(results.every((r: any) => r.dispatched)).toBe(true);

    const reloaded1 = await getDrillRun(r1.id);
    expect(reloaded1?.dispatchedAt).toBeTruthy();

    // A second sweep picks up NOTHING — no double-dispatch.
    dispatched.length = 0;
    const secondResults = await runHeartbeatSweep(dispatchFn);
    expect(secondResults).toHaveLength(0);
    expect(dispatched).toHaveLength(0);
  });

  it("a failed dispatch is reported but does not block sweeping the other runs, and leaves dispatchedAt unset for a retry", async () => {
    const ok = await runWithConfirmedFinding("heartbeat");
    const bad = await runWithConfirmedFinding("heartbeat");
    const dispatchFn = async (record: any) => {
      if (record.id === bad.id) throw new Error("kanban-loop unreachable");
      return { id: "card-ok" };
    };
    const results = await runHeartbeatSweep(dispatchFn);
    const okResult = results.find((r: any) => r.runId === ok.id);
    const badResult = results.find((r: any) => r.runId === bad.id);
    expect(okResult.dispatched).toBe(true);
    expect(badResult.dispatched).toBe(false);
    expect(badResult.error).toContain("unreachable");

    const reloadedBad = await getDrillRun(bad.id);
    expect(reloadedBad?.dispatchedAt).toBeNull(); // eligible for the next sweep to retry
  });
});
