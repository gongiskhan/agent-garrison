// GARRISON-FLOW-V2 S1 (Q3) — the stability point. stabilityFields predicate +
// its fold at all three engine seams (processCard / advanceCardPhase /
// processBatch), idempotence, and review->implement NOT emitting.
import { describe, it, expect } from "vitest";

process.env.GARRISON_POLICY_PATH = "/nonexistent/garrison-policy.json";
import { mkdtempSync as __mkdtemp } from "node:fs";
import { tmpdir as __tmpdir } from "node:os";
import { join as __join } from "node:path";
process.env.GARRISON_RUNS_DIR = __mkdtemp(__join(__tmpdir(), "runs-home-"));
process.env.GARRISON_HOME = __mkdtemp(__join(__tmpdir(), "gh-stability-"));

import { mkdtempSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
// @ts-ignore — pure .mjs
import { stabilityFields, resetCoordinationCache } from "../fittings/seed/kanban-loop/lib/coordination.mjs";
// @ts-ignore — pure .mjs
import { processCard, advanceCardPhase, processBatch } from "../fittings/seed/kanban-loop/lib/engine.mjs";
// @ts-ignore — pure .mjs
import { createCard, loadCard, saveCard } from "../fittings/seed/kanban-loop/lib/board.mjs";
// @ts-ignore — pure .mjs
import { seedBoard } from "../fittings/seed/kanban-loop/scripts/kanban.mjs";

const tmp = () => mkdtempSync(join(tmpdir(), "coord-stab-"));
const board = seedBoard();

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

describe("stabilityFields folded at the three seams", () => {
  it("processCard: review -> adversarial-review sets stabilityAt + records the event", async () => {
    const root = tmp();
    resetCoordinationCache();
    let card = await createCard(root, { title: "review seam", project: "p", list: "review" });
    card = await saveCard(root, { ...card, runId: "01RUNREVIEW", runDir: join(root, "run") });
    const runFn = async () => ({ reply: "adversarial-review" });
    const { outcome } = await processCard({ root, board, card, runFn, cap: 10 });
    expect(outcome.status).toBe("moved");
    expect(outcome.to).toBe("adversarial-review");
    const disk = await loadCard(root, card.id);
    expect(typeof disk.stabilityAt).toBe("string");
    expect(disk.events.some((e: any) => e.kind === "stability")).toBe(true);
  });

  it("advanceCardPhase (in-session): review -> adversarial-review sets stabilityAt", async () => {
    const root = tmp();
    resetCoordinationCache();
    let card = await createCard(root, { title: "review in-session", project: "p", list: "review" });
    card = await saveCard(root, { ...card, runId: "01RUNREV2", runDir: join(root, "run") });
    const { outcome } = await advanceCardPhase({ root, board, card, verdict: "adversarial-review" });
    expect(outcome.status).toBe("moved");
    const disk = await loadCard(root, card.id);
    expect(typeof disk.stabilityAt).toBe("string");
  });

  it("processBatch: a batched review list sets stabilityAt on the passing card", async () => {
    const root = tmp();
    resetCoordinationCache();
    // A custom board whose batched list carries the review phase (the seed board
    // batches Test; review is not batched today, so we prove parity with a crafted
    // board — E3's demand).
    const reviewBatchBoard = {
      version: 3,
      lists: [
        { id: "review", title: "Review", kind: "agent", trigger: "scheduler-beat", phase: "review", batched: true, validNext: ["adversarial-review", "implement"] },
        { id: "adversarial-review", title: "Adversarial Review", kind: "agent", trigger: "immediate", phase: "adversarial-review", validNext: ["test"] }
      ],
      projects: {}
    };
    let card = await createCard(root, { title: "batched review", project: "p", list: "review" });
    card = await saveCard(root, { ...card, runId: "01RUNBATCH", runDir: join(root, "run") });
    const batchRunFn = async () => ({ reply: `${card.id} adversarial-review` });
    const { outcomes } = await processBatch({ root, board: reviewBatchBoard, listId: "review", cards: [card], batchRunFn, cap: 10 });
    expect(outcomes[0].status).toBe("moved");
    const disk = await loadCard(root, card.id);
    expect(disk.list).toBe("adversarial-review");
    expect(typeof disk.stabilityAt).toBe("string");
  });
});
