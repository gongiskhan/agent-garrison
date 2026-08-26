// GARRISON-FLOW-V2 S1 (Q3) — the stability point predicate.
//
// Conversations cut: the three engine seams that FOLDED this into a phase
// transition (processCard / advanceCardPhase / processBatch) are deleted along
// with the duty-list engine, so there is no longer a transition to fold it at.
// `stabilityFields` itself survives untouched in lib/coordination.mjs, and this
// file keeps its predicate contract — first clean review only, never on the
// implement loop-back, never off the review seam, idempotent — so a future
// caller inherits the same rule rather than re-deriving it.
import { describe, it, expect } from "vitest";

process.env.GARRISON_POLICY_PATH = "/nonexistent/garrison-policy.json";
import { mkdtempSync as __mkdtemp } from "node:fs";
import { tmpdir as __tmpdir } from "node:os";
import { join as __join } from "node:path";
process.env.GARRISON_RUNS_DIR = __mkdtemp(__join(__tmpdir(), "runs-home-"));
process.env.GARRISON_HOME = __mkdtemp(__join(__tmpdir(), "gh-stability-"));

// @ts-ignore — pure .mjs
import { stabilityFields } from "../fittings/seed/kanban-loop/lib/coordination.mjs";

describe("stabilityFields — predicate", () => {
  it("emits on the first clean review (review -> not implement)", () => {
    const f = stabilityFields({ stabilityAt: null }, "review", "adversarial-review", () => "T");
    expect(f).not.toBeNull();
    expect(f.stabilityAt).toBe("T");
    expect(f.event.kind).toBe("stability");
  });
  it("does NOT emit when review loops back to implement", () => {
    expect(stabilityFields({ stabilityAt: null }, "review", "implement", () => "T")).toBeNull();
  });
  it("does NOT emit off the review seam", () => {
    expect(stabilityFields({ stabilityAt: null }, "implement", "review", () => "T")).toBeNull();
  });
  it("is idempotent once stabilityAt is set", () => {
    expect(stabilityFields({ stabilityAt: "earlier" }, "review", "adversarial-review", () => "T")).toBeNull();
  });
});
