// The resolved model — what SURVIVES of it after the Conversations cut.
//
// This file used to be the S4a suite: the board's phase lists derived from the
// composition's resolved `kanbanLists`, and a card walking exactly its
// (duty, level) sequence through processCard/processBatch. All of that is gone.
// The board is five fixed state columns (`buildBoard` ignores its model
// argument entirely) and there is no local dispatch engine to walk a sequence.
//
// What remains is the model as a DATA PROJECTION, which is still very much
// live: `up()` computes it, decides whether to write it, and the gateway reads
// the duty cells + ladders out of it to route a stretch. Those are the
// contracts kept here, plus the board-reconcile that keeps an installed board
// converging on the five columns, plus a module-load guard for the whole
// fitting (see the last describe — a stale import line took the fitting down
// once already).
import { describe, it, expect, beforeAll, afterAll } from "vitest";

// Policy-less mode (pure mechanics) + a sandboxed runs home so nothing touches
// the real ~/.garrison.
process.env.GARRISON_POLICY_PATH = "/nonexistent/garrison-policy.json";
import { mkdtempSync as __mkdtemp } from "node:fs";
import { tmpdir as __tmpdir } from "node:os";
import { join as __join } from "node:path";
process.env.GARRISON_RUNS_DIR = __mkdtemp(__join(__tmpdir(), "runs-home-"));

import { existsSync, mkdtempSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";

import { clearKanbanResolvedModel, computeKanbanResolvedModel } from "../src/lib/kanban-model";
import { kanbanProjectionPlan } from "../src/lib/runner";
// One line on purpose: `@ts-ignore` suppresses the NEXT line only, and an
// ambient `declare module "*/kanban-loop/lib/resolved-model.mjs"` exists
// (tests/instance-isolation-mjs.d.ts) declaring just one of these — so a
// multi-line import reports an error per member, below the suppression.
// @ts-ignore — pure .mjs
import { BOARD_LISTS, buildBoard, contextHoldFor, dutyGateExplicit, loadResolvedModel, reconcileBoardLists } from "../fittings/seed/kanban-loop/lib/resolved-model.mjs";
// @ts-ignore — pure .mjs
import { relocateStrandedCards } from "../fittings/seed/kanban-loop/scripts/kanban.mjs";
// @ts-ignore — pure .mjs
import { createCard, loadCard } from "../fittings/seed/kanban-loop/lib/board.mjs";

// The card store is the STATE SERVICE now, not files under GARRISON_KANBAN_DIR.
// Boot one for this file and project its discovery env before anything reads a
// card; side files still live under the kanban root this file already pins.
import { setupKanbanState } from "./kanban-state-env";
let __kanbanState: Awaited<ReturnType<typeof setupKanbanState>>;
beforeAll(async () => {
  __kanbanState = await setupKanbanState();
}, 30_000);
afterAll(async () => {
  await __kanbanState?.stop();
});

const tmp = () => mkdtempSync(join(tmpdir(), "kanban-resolved-"));

// A leaf duty: one level with a skill cell.
const leaf = (id: string, extra: Record<string, unknown> = {}) => ({
  id,
  title: id,
  description: "",
  levels: [{ description: "do", cell: { skill: id, target: "cc-sonnet", effort: "low" } }],
  ...extra
});

// ── the projection decision at up() ──────────────────────────────────────────
// kanbanProjectionPlan is the guard between computing a model and writing it to
// the board's model.json. An empty model must not be written: it would stamp an
// empty model.json over a good one and log a projection that did not happen.
describe("kanbanProjectionPlan — up() never writes an empty resolved model", () => {
  it("a composition with no selected duties yields an empty model → the guard SKIPS the write", () => {
    const empty = computeKanbanResolvedModel({ id: "c", duties: [], selectedDuties: [] }, []);
    expect(empty.kanbanLists).toEqual([]); // the guard's precondition

    const plan = kanbanProjectionPlan(empty);
    expect(plan.write).toBe(false);
    expect(plan.log).not.toMatch(/projected/); // never claims a projection happened
    expect(plan.log).toMatch(/default pipeline/);
  });

  it("a non-empty resolved duty model DOES project, logging the real count", () => {
    const plan = kanbanProjectionPlan({
      version: 3,
      compositionId: "c",
      kanbanLists: ["plan", "implement", "review"],
      sequences: {},
      cells: {}
    } as never);
    expect(plan.write).toBe(true);
    expect(plan.log).toContain("projected 3 phase list(s)");
    expect(plan.log).toContain("plan, implement, review");
  });

  it("clears the machine-global projection when the active composition has no model", async () => {
    const file = join(tmp(), "model.json");
    writeFileSync(file, JSON.stringify({ version: 3, compositionId: "c", kanbanLists: ["x"] }), "utf8");
    expect(existsSync(file)).toBe(true);

    await clearKanbanResolvedModel(file);

    expect(existsSync(file)).toBe(false);
  });

  it("rejects another composition's global projection when a gateway names the expected id", () => {
    const root = tmp();
    writeFileSync(
      join(root, "model.json"),
      JSON.stringify({ version: 3, compositionId: "old-composition", kanbanLists: ["code"], sequences: {}, cells: {} }),
      "utf8"
    );

    // model.json is machine-global, so a gateway naming its active composition
    // must not be handed the previous composition's cells.
    expect(loadResolvedModel(root, "new-composition")).toBeNull();
    expect(loadResolvedModel(root, "old-composition")?.compositionId).toBe("old-composition");
    // A board-only caller omits the guard and reads whatever is there.
    expect(loadResolvedModel(root)?.compositionId).toBe("old-composition");
  });

  it("reads a model with an empty kanbanLists as ABSENT, so the write guard and the reader agree", () => {
    const root = tmp();
    writeFileSync(
      join(root, "model.json"),
      JSON.stringify({ version: 3, compositionId: "c", kanbanLists: [], sequences: {}, cells: {} }),
      "utf8"
    );
    expect(loadResolvedModel(root)).toBeNull();
  });

  it("fails closed on a version it does not understand", () => {
    const root = tmp();
    writeFileSync(
      join(root, "model.json"),
      JSON.stringify({ version: 99, compositionId: "c", kanbanLists: ["code"] }),
      "utf8"
    );
    expect(loadResolvedModel(root)).toBeNull();
  });
});

// ── duty cells: the routing input the gateway actually reads ─────────────────
describe("duty cells projection (the duties→router repoint input)", () => {
  const duties: import("../src/lib/types").DutySpec[] = [
    {
      id: "code",
      title: "Code",
      description: "write code",
      levels: [
        { description: "trivial", cell: { target: "sdk-haiku", effort: "low" } },
        { description: "standard", cell: { target: "cc-sonnet", effort: "medium" } }
      ]
    },
    {
      id: "pipeline",
      title: "Pipeline",
      description: "composite",
      levels: [{ description: "seq", sequence: [{ duty: "code", level: 1 }] }]
    }
  ];
  const targets = [
    {
      id: "sdk-haiku",
      runtime: "agent-sdk",
      model: "claude-haiku-4-5",
      provider: "anthropic",
      params: { type: "runtime-target" } as Record<string, string | number | boolean>
    },
    {
      id: "cc-sonnet",
      runtime: "agent-sdk",
      model: "sonnet",
      provider: "anthropic",
      params: { type: "runtime-target", promptMode: "coding", maxTurns: 100 } as Record<string, string | number | boolean>
    }
  ];

  it("joins each leaf level's cell with its target spec; composite levels have no cell", () => {
    const model = computeKanbanResolvedModel({ id: "c", duties, selectedDuties: ["code", "pipeline"], targets }, []);
    expect(model.version).toBe(3);
    expect(model.cells.code["1"]).toEqual({
      target: "sdk-haiku",
      effort: "low",
      runtime: "agent-sdk",
      model: "claude-haiku-4-5",
      provider: "anthropic",
      type: "runtime-target",
      promptMode: null,
      maxTurns: null
    });
    expect(model.cells.code["2"].model).toBe("sonnet");
    expect(model.cells.code["2"].effort).toBe("medium");
    // Agent-SDK harness knobs travel with the cell so the duty repoint keeps the
    // coding profile + turn cap instead of falling back to full/12.
    expect(model.cells.code["2"].promptMode).toBe("coding");
    expect(model.cells.code["2"].maxTurns).toBe(100);
    // The composite duty's only level is a sequence — no cell projected.
    expect(model.cells).not.toHaveProperty("pipeline");
  });

  it("a cell whose target is not in the composition still projects (specs null)", () => {
    const model = computeKanbanResolvedModel({ id: "c", duties: [duties[0]], selectedDuties: ["code"], targets: [] }, []);
    expect(model.cells.code["1"]).toEqual({
      target: "sdk-haiku",
      effort: "low",
      runtime: null,
      model: null,
      provider: null,
      type: null,
      promptMode: null,
      maxTurns: null
    });
  });
});

// ── orphaned duty flags (behaviour pinned, callers gone) ─────────────────────
// context_hold and gate: explicit are still parsed off a duty and still
// projected onto the model, and resolved-model.mjs still exports the two
// readers. Their CALLER was the duty-list dispatch engine, which is gone — so
// the projection→reader pair is currently write-only. Pinned here rather than
// dropped: the flags are live composition schema (a user can still write them
// in apm.yml), and silently projecting a flag nothing reads is a fact worth
// keeping visible. Matches the "orphaned engine helpers" block in
// tests/kanban.test.ts.
describe("orphaned duty flags — context_hold / gate: explicit (projected, no reader)", () => {
  const holdDuty = leaf("implement", { context_hold: true });
  const gateDuty = leaf("discuss", { gate: "explicit" });

  it("computeKanbanResolvedModel projects only the truthy holds and the explicit gates", () => {
    const model = computeKanbanResolvedModel(
      {
        id: "c",
        duties: [holdDuty, leaf("review"), gateDuty] as never,
        selectedDuties: ["implement", "review", "discuss"],
        targets: []
      },
      []
    );
    expect(model.holds).toEqual({ implement: true });
    expect(model.gates).toEqual({ discuss: "explicit" });
  });

  it("contextHoldFor reads holds[dutyId]; false for absent, unknown, and a null model", () => {
    expect(contextHoldFor({ holds: { implement: true } }, "implement")).toBe(true);
    expect(contextHoldFor({ holds: { implement: true } }, "review")).toBe(false);
    expect(contextHoldFor({}, "implement")).toBe(false);
    expect(contextHoldFor(null, "implement")).toBe(false);
  });

  it("dutyGateExplicit reads gates[dutyId] === 'explicit', never a truthy near-miss", () => {
    expect(dutyGateExplicit({ gates: { discuss: "explicit" } }, "discuss")).toBe(true);
    expect(dutyGateExplicit({ gates: { discuss: "implicit" } }, "discuss")).toBe(false);
    expect(dutyGateExplicit({ gates: {} }, "discuss")).toBe(false);
    expect(dutyGateExplicit(null, "discuss")).toBe(false);
  });
});

// ── the board reconcile ──────────────────────────────────────────────────────
// buildBoard no longer reads the model at all; reconcileBoardLists is what
// converges an INSTALLED board (any older shape) onto the five columns without
// losing the board's own non-structural state. scripts/kanban.mjs --setup runs
// it on every `up`, and relocateStrandedCards rescues any card left behind.
describe("reconcileBoardLists — an installed board converges on the fixed columns", () => {
  const legacyBoard = () => ({
    version: 4,
    rev: 17,
    projects: { garrison: { colour: "blue" } },
    lists: [
      { id: "todo", title: "To Do", kind: "manual", trigger: "manual", validNext: ["plan"] },
      { id: "plan", title: "duty: plan", kind: "agent", phase: "plan", trigger: "immediate", validNext: ["implement"] },
      { id: "implement", title: "duty: implement", kind: "agent", phase: "implement", trigger: "immediate", validNext: ["done"] },
      { id: "done", title: "Done", kind: "manual", trigger: "manual", terminal: true, validNext: [] }
    ]
  });

  it("removes every list outside the fixed set and adds the missing state columns", () => {
    const { board, removed, added } = reconcileBoardLists(legacyBoard());
    expect(board.lists.map((l: { id: string }) => l.id)).toEqual(BOARD_LISTS);
    expect(board.version).toBe(buildBoard().version);
    expect(removed.sort()).toEqual(["implement", "plan"]);
    expect(added.sort()).toEqual(["backlog", "needs-attention", "running", "scheduled"]);
  });

  it("preserves the board's projects map and its optimistic-concurrency rev", () => {
    const { board } = reconcileBoardLists(legacyBoard());
    expect(board.projects).toEqual({ garrison: { colour: "blue" } });
    expect(board.rev).toBe(17);
  });

  it("refreshes engine-owned fields on a surviving list and reports it as updated", () => {
    // The legacy `todo` carries a stale title and a validNext pointing at a duty
    // list. Both are engine-owned, so the reconcile rewrites them in place.
    const { board, updated } = reconcileBoardLists(legacyBoard());
    const todo = board.lists.find((l: { id: string }) => l.id === "todo");
    expect(todo.validNext).toEqual(["backlog", "done"]);
    expect(todo.onEnter).toBe("infer-title-and-project");
    expect(updated).toContain("todo");
  });

  it("a board already at the fixed columns reports nothing added or removed", () => {
    const { removed, added } = reconcileBoardLists(buildBoard());
    expect(removed).toEqual([]);
    expect(added).toEqual([]);
  });

  it("carries the conversations migration marker across a reconcile", () => {
    const { board } = reconcileBoardLists({ ...legacyBoard(), conversationsMigrated: "2026-08-26T00:00:00Z" });
    expect(board.conversationsMigrated).toBe("2026-08-26T00:00:00Z");
  });

  it("relocateStrandedCards rescues a card left on a removed list — never loses it", async () => {
    const root = tmp();
    const stranded = await createCard(root, { title: "mid-pipeline", project: "demo", list: "implement" });
    const { board, removed } = reconcileBoardLists(legacyBoard());

    const moved = await relocateStrandedCards(root, board, removed);

    expect(moved).toContain(stranded.id);
    const disk = await loadCard(root, stranded.id);
    expect(disk.list).toBe("needs-attention");
    expect(disk.parkedFrom).toBe("implement");
    expect(disk.attentionReason).toMatch(/removed from the board/i);
    // Every other field survives the rescue.
    expect(disk.title).toBe("mid-pipeline");
    expect(disk.project).toBe("demo");
  });

  it("leaves a card whose list still exists untouched", async () => {
    const root = tmp();
    const safe = await createCard(root, { title: "on a real column", project: "demo", list: "todo" });
    const { board, removed } = reconcileBoardLists(legacyBoard());

    expect(await relocateStrandedCards(root, board, removed)).not.toContain(safe.id);
    expect((await loadCard(root, safe.id)).list).toBe("todo");
  });
});
