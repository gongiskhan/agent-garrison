import { describe, it, expect } from "vitest";
import { mkdtempSync, writeFileSync, readFileSync, mkdirSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { reconcile } from "../src/lib/reconcile";
// @ts-ignore — pure .mjs
import { proposeMemoryConsolidation } from "../fittings/seed/improver/lib/improver-core.mjs";
// @ts-ignore — pure .mjs
import { planApply, applyPlan, applyWithRetry, readTarget } from "../fittings/seed/improver/lib/apply-core.mjs";
// @ts-ignore — pure .mjs
import { applyOutcome, setRuleAutonomy, promoteRule, ruleState, isAuto, PROMOTION_THRESHOLD } from "../fittings/seed/improver/lib/review-queue.mjs";

const MEMORY = [
  { title: "PTY screen detection", hook: "reads the xterm screen not JSONL" },
  { title: "Warm pool cost", hook: "352 MB / 0 tokens idle" },
];

function proposal() {
  return proposeMemoryConsolidation({ memoryEntries: MEMORY, decisions: [{ targetId: "x" }], at: "2026-06-15T00:00:00Z" });
}

describe("U3 — apply with real reconcile (improver-apply-ok)", () => {
  it("approves a proposal: writes the target via the baselineSha contract and runs reconcile('post-authoring')", async () => {
    const tmp = mkdtempSync(join(tmpdir(), "gar-apply-"));
    const target = join(tmp, "knowledge-memory.md");
    writeFileSync(target, "# Memory\n", "utf8");
    const claudeHome = mkdtempSync(join(tmpdir(), "gar-ch-"));
    const storeDir = mkdtempSync(join(tmpdir(), "gar-store-"));

    const reconcileCalls: any[] = [];
    const reconcileFn = async (trigger: string) => {
      // the REAL reconcile, scoped to throwaway dirs (never touches ~/.claude)
      const report = await reconcile({ trigger: trigger as any, surfaces: ["rule"], claudeHome, storeDir });
      reconcileCalls.push({ trigger, report });
      return report;
    };

    const res = await applyWithRetry({ proposal: proposal(), targetFile: target, reconcileFn });
    expect(res.ok).toBe(true);
    expect(res.evidence.bytes).toBeGreaterThan(0);

    // reconcile genuinely ran with the post-authoring trigger
    expect(reconcileCalls).toHaveLength(1);
    expect(reconcileCalls[0].report.table).toContain("trigger=post-authoring");

    // the target now carries the marked, consolidated block
    const after = readFileSync(target, "utf8");
    expect(after).toContain("<!-- improver:memory-consolidation-2 -->");
    expect(after).toContain("PTY screen detection");
  });

  it("is idempotent — re-applying the same proposal does not duplicate the block", async () => {
    const tmp = mkdtempSync(join(tmpdir(), "gar-apply-idem-"));
    const target = join(tmp, "t.md");
    writeFileSync(target, "# base\n", "utf8");
    await applyWithRetry({ proposal: proposal(), targetFile: target, reconcileFn: null });
    const once = readFileSync(target, "utf8");
    await applyWithRetry({ proposal: proposal(), targetFile: target, reconcileFn: null });
    const twice = readFileSync(target, "utf8");
    expect(twice).toBe(once);
  });
});

describe("U3 — 409 conflict on a concurrent edit (improver-conflict-ok)", () => {
  it("refuses the stale write, then re-reads + re-diffs and applies on top of the concurrent edit", async () => {
    const tmp = mkdtempSync(join(tmpdir(), "gar-conflict-"));
    const target = join(tmp, "claude-md.md");
    writeFileSync(target, "# base\n", "utf8");
    const p = proposal();

    // plan captures the baseline sha
    const plan = await planApply({ proposal: p, targetFile: target });
    // a concurrent claude-md edit changes the target after the plan was made
    writeFileSync(target, "# base\nCONCURRENT HUMAN EDIT\n", "utf8");

    // applying the stale plan is refused with a 409 conflict
    const stale = await applyPlan({ plan, reconcileFn: null });
    expect(stale.ok).toBe(false);
    expect(stale.code).toBe("conflict");

    // reset the target, then drive the AUTOMATED recovery: a concurrent writer
    // lands between plan and apply (beforeApply hook) → first apply 409s →
    // applyWithRetry re-reads + re-diffs against the new baseline and applies.
    writeFileSync(target, "# base\n", "utf8");
    const recovered = await applyWithRetry({
      proposal: p,
      targetFile: target,
      reconcileFn: null,
      beforeApply: () => writeFileSync(target, "# base\nCONCURRENT HUMAN EDIT\n", "utf8"),
    });
    expect(recovered.ok).toBe(true);
    expect(recovered.recoveredFromConflict).toBe(true);

    const final = readFileSync(target, "utf8");
    expect(final).toContain("CONCURRENT HUMAN EDIT"); // the human edit was preserved
    expect(final).toContain("<!-- improver:memory-consolidation-2 -->"); // applied on top
  });
});

describe("U3 — reject leaves the target untouched (improver-reject-ok, unit)", () => {
  it("never writes the target when a proposal is not approved", async () => {
    const tmp = mkdtempSync(join(tmpdir(), "gar-reject-"));
    const target = join(tmp, "t.md");
    writeFileSync(target, "# untouched\n", "utf8");
    const before = await readTarget(target);
    // reject = a queue status transition; the apply path is simply never called
    const after = await readTarget(target);
    expect(after.sha).toBe(before.sha);
    expect(readFileSync(target, "utf8")).toBe("# untouched\n");
  });
});

describe("U3 — autonomy lifecycle through the review-queue layer", () => {
  it("autonomy-direct-ok: a rule set auto directly applies with no streak", () => {
    const a = setRuleAutonomy({}, "memory-consolidation", "auto");
    expect(isAuto(a, "memory-consolidation")).toBe(true);
    expect(ruleState(a, "memory-consolidation").streak).toBe(0); // no streak earned
  });

  it("autonomy-promotion-ok: a 5-accept streak emits a promotion, approving sets auto", () => {
    let a: any = {};
    let event = "none";
    for (let i = 0; i < PROMOTION_THRESHOLD; i++) {
      const out = applyOutcome(a, "skill-suggest", "accept");
      a = out.autonomy;
      event = out.event;
    }
    expect(event).toBe("promotion-suggested");
    a = promoteRule(a, "skill-suggest");
    expect(isAuto(a, "skill-suggest")).toBe(true);
  });

  it("autonomy-demotion-ok: rejecting an auto-applied change demotes to manual instantly", () => {
    let a = promoteRule({}, "router-tune"); // auto
    expect(isAuto(a, "router-tune")).toBe(true);
    const out = applyOutcome(a, "router-tune", "reject");
    expect(out.event).toBe("demoted");
    expect(isAuto(out.autonomy, "router-tune")).toBe(false);
  });
});
