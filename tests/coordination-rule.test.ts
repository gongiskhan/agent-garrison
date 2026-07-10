// GARRISON-FLOW-V2 S6 (D17) — the Improver's coordination rule: attributed
// interference + ordering decisions + touch-set-prediction misses on the kanban
// cards → reviewable threshold / lease-list / prediction proposals, never
// auto-applied.
import { describe, it, expect } from "vitest";
import { mkdtempSync, mkdirSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import path from "node:path";

// @ts-ignore - pure .mjs
import * as ruleMod from "../fittings/seed/improver/lib/coordination-rule.mjs";

const interference = (files: string[]) => ({
  kind: "interference",
  message: "Interference: Review failed due to card Foo (abc123)'s commits - waiting for its fix (iteration refunded to 0)",
  detail: `broken by card 01FOO (Foo) - commits a1b2c3d4e5, f6a7b8c9d0 touching ${files.join(", ")}`
});
const heavyOverlap = (files: string[]) => ({
  kind: "coordination",
  message: "Plan complete; waiting on Foo (heavy overlap) until terminal",
  detail: `heavy overlap with card 01FOO (Foo) on files [${files.join(", ")}]; waiting until terminal.`
});
const outOfSet = (files: string[]) => ({
  kind: "fence",
  message: `Out-of-touch-set changes present, not fenced, unattributable: ${files.join(", ")}`
});
const card = (id: string, events: unknown[]) => ({ id, events });

describe("coordination rule (S6/D17)", () => {
  it("a file that caused >=2 interference collisions proposes adding it to the exclusive-lease list", () => {
    const cards = [card("c1", [interference(["src/lib/policy-core.mjs"]), interference(["src/lib/policy-core.mjs", "src/x.ts"])])];
    const props = ruleMod.analyzeCoordinationProposals({ cards, current: { exclusiveLeases: [] }, at: "2026-01-01T00:00:00Z" });
    const lease = props.find((p: any) => p.id === `coordination-lease-${short("src/lib/policy-core.mjs")}`);
    expect(lease).toBeTruthy();
    expect(lease.rule).toBe("coordination");
    expect(lease.targetClass).toBe("orchestrator/policy");
    expect(lease.applyVia).toContain("PUT /routing");
    expect(lease.diff).toContain("exclusiveLeases");
    expect(lease.claim).toContain("src/lib/policy-core.mjs");
    expect(lease.evidence.collisions).toBe(2);
  });

  it("recurrent interference (>=3 events) with heavyFiles above the floor proposes a threshold down-step", () => {
    const cards = [
      card("c1", [interference(["a.ts"]), interference(["a.ts"])]),
      card("c2", [interference(["b.ts"])])
    ];
    const props = ruleMod.analyzeCoordinationProposals({ cards, current: { heavyFiles: 3, exclusiveLeases: [] }, at: "t" });
    const th = props.find((p: any) => p.id.startsWith("coordination-threshold-"));
    expect(th).toBeTruthy();
    expect(th.diff).toContain("3 → 2");
    expect(th.evidence.interferenceEvents).toBe(3);
  });

  it("a file modified outside the predicted touch-set >=2 times proposes a prediction improvement", () => {
    const cards = [card("c1", [outOfSet(["src/routes/api.ts"]), outOfSet(["src/routes/api.ts", "README.md …"])])];
    const props = ruleMod.analyzeCoordinationProposals({ cards, current: { exclusiveLeases: [] }, at: "t" });
    const predict = props.find((p: any) => p.id === `coordination-predict-${short("src/routes/api.ts")}`);
    expect(predict).toBeTruthy();
    expect(predict.claim).toContain("outside the predicted touch-set");
    expect(predict.evidence.misses).toBe(2);
    // the truncation-ellipsis token is not a real path and must be dropped
    expect(props.find((p: any) => p.id === `coordination-predict-${short("README.md")}`)).toBeFalsy();
  });

  it("never proposes leasing a path that is ALREADY leased", () => {
    const cards = [card("c1", [interference(["package-lock.json"]), interference(["package-lock.json"])])];
    const props = ruleMod.analyzeCoordinationProposals({ cards, current: { exclusiveLeases: ["package-lock.json"], heavyFiles: 3 }, at: "t" });
    expect(props.find((p: any) => p.id.startsWith("coordination-lease-"))).toBeFalsy();
  });

  it("thresholds at the floor (heavyFiles=2) do NOT propose a further down-step", () => {
    const cards = [card("c1", [interference(["a.ts"]), interference(["a.ts"]), interference(["a.ts"])])];
    const props = ruleMod.analyzeCoordinationProposals({ cards, current: { heavyFiles: 2, exclusiveLeases: [] }, at: "t" });
    expect(props.find((p: any) => p.id.startsWith("coordination-threshold-"))).toBeFalsy();
  });

  it("small samples propose NOTHING (conservative thresholds)", () => {
    const cards = [card("c1", [interference(["a.ts"]), heavyOverlap(["b.ts"]), outOfSet(["c.ts"])])];
    const props = ruleMod.analyzeCoordinationProposals({ cards, current: { exclusiveLeases: [], heavyFiles: 3 }, at: "t" });
    expect(props).toEqual([]);
  });

  it("collectCards reads card.json files from a sandbox kanban dir", () => {
    const dir = mkdtempSync(path.join(tmpdir(), "coord-cards-"));
    for (const id of ["01A", "01B"]) {
      mkdirSync(path.join(dir, id), { recursive: true });
      writeFileSync(path.join(dir, id, "card.json"), JSON.stringify(card(id, [interference(["x.ts"])])));
    }
    const cards = ruleMod.collectCards(dir);
    expect(cards).toHaveLength(2);
    expect(cards.map((c: any) => c.id).sort()).toEqual(["01A", "01B"]);
  });

  it("readPolicyCoordination reads the live knobs (defaults when absent)", () => {
    const dir = mkdtempSync(path.join(tmpdir(), "coord-pol-"));
    const p = path.join(dir, "policy.json");
    writeFileSync(p, JSON.stringify({ coordination: { thresholds: { heavyFiles: 5 }, exclusiveLeases: ["Gemfile.lock"] } }));
    const prev = process.env.GARRISON_POLICY_PATH;
    process.env.GARRISON_POLICY_PATH = p;
    try {
      const c = ruleMod.readPolicyCoordination();
      expect(c.heavyFiles).toBe(5);
      expect(c.exclusiveLeases).toEqual(["Gemfile.lock"]);
      expect(c.heavyRatio).toBe(0.5); // default when the section omits it
    } finally {
      if (prev === undefined) delete process.env.GARRISON_POLICY_PATH;
      else process.env.GARRISON_POLICY_PATH = prev;
    }
  });
});

// Mirror the rule's shortHash (sha256, first 8 hex) so id assertions are exact.
import { createHash } from "node:crypto";
function short(s: string) {
  return createHash("sha256").update(s).digest("hex").slice(0, 8);
}
