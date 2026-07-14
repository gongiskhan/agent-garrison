// S1b — the engine's compact-controller integration: the duty context_hold flows
// composition -> resolved model -> board reader, the dispatch carries the
// contextHold + dutyKey route hints, and a genuine advance fires the gateway's
// duty-boundary check with the card's focus context.
import { describe, it, expect } from "vitest";

// Policy-less transition mechanics + a sandboxed runs home (mirrors the other
// engine tests so nothing touches the real ~/.garrison).
process.env.GARRISON_POLICY_PATH = "/nonexistent/garrison-policy.json";
import { mkdtempSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
process.env.GARRISON_RUNS_DIR = mkdtempSync(join(tmpdir(), "runs-home-compact-"));

import { computeKanbanResolvedModel } from "../src/lib/kanban-model";
// @ts-ignore — pure .mjs
import { contextHoldFor, buildBoard } from "../fittings/seed/kanban-loop/lib/resolved-model.mjs";
// @ts-ignore — pure .mjs
import { processCard, focusContextForCard } from "../fittings/seed/kanban-loop/lib/engine.mjs";
// @ts-ignore — pure .mjs
import { createCard } from "../fittings/seed/kanban-loop/lib/board.mjs";
// @ts-ignore — pure .mjs
import { seedBoard, phaseTemplatesFrom } from "../fittings/seed/kanban-loop/scripts/kanban.mjs";

const tmp = () => mkdtempSync(join(tmpdir(), "compact-engine-"));
const templates = () => phaseTemplatesFrom(seedBoard());

// A duty spec with an optional context_hold.
const duty = (id: string, hold = false): any => ({
  id,
  title: id,
  description: id,
  levels: [{ description: "do", cell: { skill: id, target: "cc-sonnet", effort: "low" } }],
  ...(hold ? { context_hold: true } : {})
});

describe("S1b — context_hold projection (composition -> model -> board reader)", () => {
  it("computeKanbanResolvedModel projects only the truthy holds", () => {
    const model = computeKanbanResolvedModel(
      { id: "c", duties: [duty("implement", true), duty("review", false)], selectedDuties: ["implement", "review"], targets: [] },
      []
    );
    expect(model.holds).toEqual({ implement: true });
  });

  it("contextHoldFor reads holds[dutyId], false for absent/unknown", () => {
    const model = { holds: { implement: true } };
    expect(contextHoldFor(model, "implement")).toBe(true);
    expect(contextHoldFor(model, "review")).toBe(false);
    expect(contextHoldFor({}, "implement")).toBe(false);
    expect(contextHoldFor(null, "implement")).toBe(false);
  });
});

describe("S1b — focusContextForCard", () => {
  it("builds the placeholder context off the card (empty fields allowed)", () => {
    const ctx = focusContextForCard({ id: "C1", title: "Add login", duty: "develop", level: 2, briefPath: "briefs/x.md", fences: [{ sha: "abcdef1234567" }] }, "implement");
    expect(ctx.card_id).toBe("C1");
    expect(ctx.card_title).toBe("Add login");
    expect(ctx.duty).toBe("develop");
    expect(ctx.level).toBe("2");
    expect(ctx.decisions).toContain("briefs/x.md");
    expect(ctx.files_touched).toBe("abcdef1234");
    expect(ctx.open_items).toBe("");
  });
});

describe("S1b — engine dispatch hints + duty-boundary firing", () => {
  // A minimal resolved model: a develop-level-2 card walks [implement, review];
  // implement holds.
  const model: any = {
    version: 2,
    compositionId: "t",
    kanbanLists: ["implement", "review"],
    sequences: { develop: { "2": ["implement", "review"] } },
    cells: {},
    holds: { implement: true }
  };
  const board = buildBoard(model, { templates: templates() });

  it("passes contextHold + dutyKey to runFn and fires onDutyBoundary on a genuine advance", async () => {
    const root = tmp();
    const card = await createCard(root, {
      title: "wide change",
      project: "demo",
      list: "implement",
      duty: "develop",
      level: 2,
      sequence: ["implement", "review"]
    });

    let runArgs: any = null;
    const runFn = async (args: any) => {
      runArgs = args;
      return { reply: "review" }; // the valid forward step
    };
    const boundaryCalls: any[] = [];
    const onDutyBoundary = async (payload: any) => {
      boundaryCalls.push(payload);
    };

    const { outcome } = await processCard({ root, board, card, runFn, cap: 20, model, onDutyBoundary });

    expect(outcome.status).toBe("moved");
    expect(outcome.to).toBe("review");
    // Dispatch hints reflect the implement-duty hold.
    expect(runArgs.contextHold).toBe(true);
    expect(runArgs.dutyKey).toBe(`${card.id}:implement`);
    // The duty boundary fired with the NEXT list's dutyKey + the card focus context.
    expect(boundaryCalls).toHaveLength(1);
    expect(boundaryCalls[0].cardId).toBe(card.id);
    expect(boundaryCalls[0].dutyKey).toBe(`${card.id}:review`);
    expect(boundaryCalls[0].focusContext.card_id).toBe(card.id);
    expect(boundaryCalls[0].focusContext.card_title).toBe("wide change");
  });

  it("does NOT fire onDutyBoundary when the card does not advance (no valid next step)", async () => {
    const root = tmp();
    const card = await createCard(root, {
      title: "stuck",
      project: "demo",
      list: "implement",
      duty: "develop",
      level: 2,
      sequence: ["implement", "review"]
    });
    const runFn = async () => ({ reply: "this reply chooses nothing valid" });
    const boundaryCalls: any[] = [];
    const onDutyBoundary = async (p: any) => boundaryCalls.push(p);

    const { outcome } = await processCard({ root, board, card, runFn, cap: 20, model, onDutyBoundary });
    expect(outcome.status).not.toBe("moved");
    expect(boundaryCalls).toHaveLength(0);
  });
});
