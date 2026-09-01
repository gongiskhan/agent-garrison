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
// @ts-ignore - pure .mjs
import { upsertQueue } from "../fittings/seed/improver/lib/improver-core.mjs";
// @ts-ignore — pure .mjs
import { markApplied } from "../fittings/seed/improver/lib/review-queue.mjs";

const interference = (files: string[], at?: string) => ({
  kind: "interference",
  ...(at ? { at } : {}),
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
    // Three DISTINCT interference events (distinct timestamps, as the engine
    // writes them) — the dedup keys on (kind, at, files), so identical-file
    // events must carry distinct `at` to count separately.
    const cards = [
      card("c1", [interference(["a.ts"], "t1"), interference(["a.ts"], "t2")]),
      card("c2", [interference(["b.ts"], "t3")])
    ];
    const props = ruleMod.analyzeCoordinationProposals({ cards, current: { heavyFiles: 3, exclusiveLeases: [] }, at: "t" });
    const th = props.find((p: any) => p.id.startsWith("coordination-threshold-"));
    expect(th).toBeTruthy();
    expect(th.diff).toContain("3 → 2");
    expect(th.evidence.interferenceEvents).toBe(3);
  });

  it("a file modified outside the predicted touch-set >=2 times proposes a batched prediction improvement", () => {
    const cards = [card("c1", [outOfSet(["src/routes/api.ts"]), outOfSet(["src/routes/api.ts", "README.md …"])])];
    const props = ruleMod.analyzeCoordinationProposals({ cards, current: { exclusiveLeases: [] }, at: "t" });
    const predict = props.find((p: any) => p.id === "coordination-predict-batch");
    expect(predict).toBeTruthy();
    expect(predict.claim).toContain("outside the predicted touch-set");
    expect(predict.evidence.files).toEqual(["src/routes/api.ts"]);
    expect(predict.evidence.misses["src/routes/api.ts"]).toBe(2);
    // the truncation-ellipsis token is not a real path and must be dropped
    expect(predict.evidence.files).not.toContain("README.md");
  });

  it("the touch-set-prediction batch id is stable across membership changes (same record, not a fresh one per path)", () => {
    const one = [card("c1", [outOfSet(["a.ts"]), outOfSet(["a.ts"])])];
    const two = [card("c1", [outOfSet(["a.ts"]), outOfSet(["a.ts"]), outOfSet(["b.ts"]), outOfSet(["b.ts"])])];
    const propsOne = ruleMod.analyzeCoordinationProposals({ cards: one, current: { exclusiveLeases: [] }, at: "t" });
    const propsTwo = ruleMod.analyzeCoordinationProposals({ cards: two, current: { exclusiveLeases: [] }, at: "t" });
    const idOne = propsOne.find((p: any) => p.rule === "coordination" && p.evidence?.files)?.id;
    const idTwo = propsTwo.find((p: any) => p.rule === "coordination" && p.evidence?.files)?.id;
    expect(idOne).toBe("coordination-predict-batch");
    expect(idTwo).toBe("coordination-predict-batch");
  });

  // A stable literal id kept a RESOLVED batch truthful, but it also meant that
  // resolution suppressed every later path forever: the frozen record was the
  // only record the id could ever have, so newly qualifying paths never got an
  // Approve/Reject decision at all. Generations fix that — the resolved record
  // is untouched, and the unreviewed delta becomes its own pending decision.
  it("a resolved batch stays frozen while newly-qualifying paths get their OWN pending decision (never absorbed, never suppressed)", () => {
    const oneCard = [card("c1", [outOfSet(["a.ts"]), outOfSet(["a.ts"])])];
    const bothCards = [card("c1", [outOfSet(["a.ts"]), outOfSet(["a.ts"]), outOfSet(["b.ts"]), outOfSet(["b.ts"])])];

    // run 1: a.ts qualifies, lands as the first generation, human rejects it.
    let queue: any[] = [];
    for (const p of ruleMod.analyzeCoordinationProposals({
      cards: oneCard,
      current: { exclusiveLeases: [] },
      at: "t1",
      reviewedPredictPaths: ruleMod.reviewedPredictPathsFromQueue(queue)
    })) {
      queue = upsertQueue(queue, p);
    }
    expect(queue).toHaveLength(1);
    expect(queue[0].id).toBe("coordination-predict-batch");
    queue = queue.map((r) => ({ ...r, status: "rejected", rejectedAt: "t1.5" }));

    // run 2: a.ts still misses AND b.ts now qualifies.
    const gen2 = ruleMod.analyzeCoordinationProposals({
      cards: bothCards,
      current: { exclusiveLeases: [] },
      at: "t2",
      reviewedPredictPaths: ruleMod.reviewedPredictPathsFromQueue(queue)
    });
    for (const p of gen2) queue = upsertQueue(queue, p);

    const batches = queue.filter((p: any) => p.id.startsWith("coordination-predict-batch"));
    expect(batches).toHaveLength(2);
    const old = batches.find((p: any) => p.id === "coordination-predict-batch");
    const fresh = batches.find((p: any) => p.id !== "coordination-predict-batch");
    // the human's decision is untouched, and still describes exactly what was decided
    expect(old.status).toBe("rejected");
    expect(old.evidence.files).toEqual(["a.ts"]);
    expect(old.at).toBe("t1");
    // the delta is a DISTINCT pending record covering only the unreviewed path
    expect(fresh.status).toBe("pending");
    expect(fresh.evidence.files).toEqual(["b.ts"]);
    expect(fresh.claim).toContain("b.ts");
    expect(fresh.claim).not.toContain("a.ts");

    // run 3, nothing new: the pending delta is REFRESHED in place, not re-minted
    const gen3 = ruleMod.analyzeCoordinationProposals({
      cards: bothCards,
      current: { exclusiveLeases: [] },
      at: "t3",
      reviewedPredictPaths: ruleMod.reviewedPredictPathsFromQueue(queue)
    });
    expect(gen3.filter((p: any) => p.id.startsWith("coordination-predict-batch")).map((p: any) => p.id)).toEqual([fresh.id]);
    for (const p of gen3) queue = upsertQueue(queue, p);
    expect(queue.filter((p: any) => p.id.startsWith("coordination-predict-batch"))).toHaveLength(2);
  });

  it("markApplied merges the apply receipt over the proposal's evidence — files survives", () => {
    // Substituting the receipt for the evidence un-reviewed a predict-batch's
    // paths on apply and let the next generation's id collide with the frozen
    // applied record, silently absorbing newly qualifying paths.
    const queue = [
      { id: "coordination-predict-batch", rule: "coordination", status: "pending", evidence: { files: ["a.ts"], misses: { "a.ts": 2 } } }
    ];
    const applied = markApplied(queue, "coordination-predict-batch", { bytes: 42, sha: "beef", targetFile: "policy.md" }, "t1");
    expect(applied[0].status).toBe("applied");
    expect(applied[0].evidence.files).toEqual(["a.ts"]);
    expect(applied[0].evidence.bytes).toBe(42);
    // …and the reviewed-set reader sees the applied paths again.
    expect(ruleMod.reviewedPredictPathsFromQueue(applied)).toEqual(["a.ts"]);
  });

  it("a path already covered by a resolved generation is never re-proposed", () => {
    const cards = [card("c1", [outOfSet(["a.ts"]), outOfSet(["a.ts"])])];
    // The REAL post-apply shape: markApplied merges the apply receipt over the
    // proposal's own evidence, so files survives beside bytes/sha. A fabricated
    // {files} record used to hide that the live shape had lost files entirely.
    const resolvedQueue = [
      {
        id: "coordination-predict-batch", rule: "coordination", status: "applied",
        evidence: { files: ["a.ts"], misses: { "a.ts": 2 }, bytes: 120, sha: "abc123", targetFile: "policy.md" }
      }
    ];
    const props = ruleMod.analyzeCoordinationProposals({
      cards,
      current: { exclusiveLeases: [] },
      at: "t",
      reviewedPredictPaths: ruleMod.reviewedPredictPathsFromQueue(resolvedQueue)
    });
    expect(props.filter((p: any) => p.id.startsWith("coordination-predict-batch"))).toEqual([]);
  });

  it("reviewedPredictPathsFromQueue counts only RESOLVED predict-batch records", () => {
    const paths = ruleMod.reviewedPredictPathsFromQueue([
      { id: "coordination-predict-batch", rule: "coordination", status: "rejected", evidence: { files: ["a.ts"] } },
      { id: "coordination-predict-batch-deadbeef", rule: "coordination", status: "applied", evidence: { files: ["b.ts"] } },
      // pending: still the record the analyzer refreshes, so its members stay candidates
      { id: "coordination-predict-batch-cafe", rule: "coordination", status: "pending", evidence: { files: ["c.ts"] } },
      // a different rule/kind of record must never contribute paths
      { id: "coordination-lease-abc", rule: "coordination", status: "applied", evidence: { file: "d.ts" } },
      { id: "skills-x", rule: "skills", status: "applied", evidence: { files: ["e.ts"] } }
    ]);
    expect(paths).toEqual(["a.ts", "b.ts"]);
  });

  it("reviewedPredictPathsFromQueue also counts resolved pre-refit per-file records", () => {
    // Before the batch refit, each qualifying path got its own proposal:
    // id `coordination-predict-<hash>`, evidence `{file}` singular. Old queues
    // still carry these, and a human already decided them — they must count as
    // reviewed or the path re-asks once under the new batch scheme.
    const paths = ruleMod.reviewedPredictPathsFromQueue([
      { id: "coordination-predict-348e10f7", rule: "coordination", status: "rejected", evidence: { file: "a.ts" } },
      { id: "coordination-predict-3ae7e531", rule: "coordination", status: "applied", evidence: { file: "b.ts" } },
      // a still-pending legacy record must not count, same rule as the batch scheme
      { id: "coordination-predict-c0ffee00", rule: "coordination", status: "pending", evidence: { file: "c.ts" } },
    ]);
    expect(paths).toEqual(["a.ts", "b.ts"]);
  });

  it("the touch-set-prediction batch lists every qualifying path in evidence.files, beyond the 5-path claim preview", () => {
    const files = ["a.ts", "b.ts", "c.ts", "d.ts", "e.ts", "f.ts", "g.ts"];
    const cards = [card("c1", files.flatMap((f) => [outOfSet([f]), outOfSet([f])]))];
    const props = ruleMod.analyzeCoordinationProposals({ cards, current: { exclusiveLeases: [] }, at: "t" });
    const predict = props.find((p: any) => p.id === "coordination-predict-batch");
    expect(predict.evidence.files).toEqual(files);
    // claim previews only 5 and says how many more, but evidence has all 7
    expect(predict.claim).toContain("and 2 more");
    expect(predict.evidence.files).toHaveLength(7);
  });

  it("filters generated/lock/log noise paths out of the touch-set-prediction batch", () => {
    const noisy = [
      "package-lock.json",
      "pnpm-lock.yaml",
      "yarn.lock",
      "Gemfile.lock",
      "composer.lock",
      "Cargo.lock",
      "dist/bundle.js",
      "run.log",
      ".gitignore",
      "compositions/default/.garrison/knowledge-memory.md",
      "a/b/.garrison/state.json",
      "__verify-scratch.json",
      "RUN_LOG.md",
      "web/next-env.d.ts"
    ];
    const cards = [
      card(
        "c1",
        noisy.flatMap((f) => [outOfSet([f]), outOfSet([f])]).concat([outOfSet(["src/real.ts"]), outOfSet(["src/real.ts"])])
      )
    ];
    const props = ruleMod.analyzeCoordinationProposals({ cards, current: { exclusiveLeases: [] }, at: "t" });
    const predict = props.find((p: any) => p.id === "coordination-predict-batch");
    expect(predict.evidence.files).toEqual(["src/real.ts"]);
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

  // The engine writes each interference collision to BOTH the victim and the
  // offender card with an identical (kind, at, files) signature. The analyzer
  // must count that as ONE collision, not two, or every proposal double-counts.
  it("counts a both-sides interference collision ONCE (dedup by kind/at/files)", () => {
    const AT = "2026-07-11T00:00:00Z";
    const file = "package-lock.json";
    // victim copy ("… touching <file>") and offender copy ("<file> - it is waiting …")
    const victimEv = {
      kind: "interference",
      at: AT,
      message: "Interference: Review failed due to card Off (aa11bb)'s commits - waiting for its fix (iteration refunded to 0)",
      detail: `broken by card 01OFF (Off) - commits a1b2c3d4e5, f6a7b8c9d0 touching ${file}`
    };
    const offenderEv = {
      kind: "interference",
      at: AT,
      message: "Your commits broke card 01VIC (Vic) at review",
      detail: `${file} - it is waiting for your next fence (fix).`
    };
    const cards = [card("victim", [victimEv]), card("offender", [offenderEv])];

    // Below the default threshold once deduped (1 < 2) -> NO lease proposal.
    const props = ruleMod.analyzeCoordinationProposals({ cards, current: { exclusiveLeases: [] }, at: AT });
    expect(props.find((p: any) => p.id === `coordination-lease-${short(file)}`)).toBeUndefined();

    // With the threshold lowered to 1, the single proposal reports collisions=1
    // (not 2) — proving the both-sides pair was deduped to one real event.
    const props1 = ruleMod.analyzeCoordinationProposals({ cards, current: { exclusiveLeases: [] }, at: AT, minInterference: 1 });
    const lease = props1.find((p: any) => p.id === `coordination-lease-${short(file)}`);
    expect(lease).toBeTruthy();
    expect(lease.evidence.collisions).toBe(1);
  });
});

// Mirror the rule's shortHash (sha256, first 8 hex) so id assertions are exact.
import { createHash } from "node:crypto";
function short(s: string) {
  return createHash("sha256").update(s).digest("hex").slice(0, 8);
}
