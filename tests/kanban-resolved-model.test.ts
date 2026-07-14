// S4a — the Kanban board DRIVEN BY the resolved model (GARRISON-UNIFY-V1 D15).
// The board's phase lists derive from the composition's resolved kanbanLists (not
// a hardcoded column set), and a card walks EXACTLY its (duty, level) resolved
// sequence, skipping every list not on it. These tests cross-check the fitting's
// board derivation + card-sequence flow against the Resolver (src/lib/resolver.ts).
import { describe, it, expect } from "vitest";

// Policy-less mode (pure transition mechanics; the gate-evidence path is covered
// elsewhere) + a sandboxed runs home so nothing touches the real ~/.garrison.
process.env.GARRISON_POLICY_PATH = "/nonexistent/garrison-policy.json";
import { mkdtempSync as __mkdtemp } from "node:fs";
import { tmpdir as __tmpdir } from "node:os";
import { join as __join } from "node:path";
process.env.GARRISON_RUNS_DIR = __mkdtemp(__join(__tmpdir(), "runs-home-"));

import { mkdtempSync, readFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { fileURLToPath } from "node:url";

import { deriveKanbanLists, resolveSequence } from "../src/lib/resolver";
import { computeKanbanResolvedModel } from "../src/lib/kanban-model";
import { kanbanProjectionPlan } from "../src/lib/runner";
// @ts-ignore — pure .mjs
import { buildBoard, validNextForCard, nextListForCard, resolveCardSequence, reconcileBoardLists, HUMAN_HEAD, HUMAN_TAIL } from "../fittings/seed/kanban-loop/lib/resolved-model.mjs";
// @ts-ignore — pure .mjs
import { processCard, processBatch, parseBatchVerdicts, effectiveListForCard, getList, triggerFor, isInteractive, isGatedDiscuss, withEvent, phaseForList } from "../fittings/seed/kanban-loop/lib/engine.mjs";
// @ts-ignore — pure .mjs
import { createCard, loadCard, loadAllCards } from "../fittings/seed/kanban-loop/lib/board.mjs";
// @ts-ignore — pure .mjs
import { seedBoard, phaseTemplatesFrom, relocateStrandedCards } from "../fittings/seed/kanban-loop/scripts/kanban.mjs";

const tmp = () => mkdtempSync(join(tmpdir(), "kanban-resolved-"));

// A leaf duty: one level with a skill cell.
const leaf = (id: string) => ({
  id,
  title: id,
  description: "",
  levels: [{ description: "do", cell: { skill: id, target: "cc-sonnet", effort: "low" } }]
});

// The develop COMPOSITE plus its leaf steps + a set of extra leaf duties so the
// union board carries lists a narrow card skips.
const DUTIES: Record<string, any> = {
  develop: {
    id: "develop",
    title: "Develop",
    description: "develop a change end to end",
    levels: [
      // level 1: implement only (a quick change).
      { description: "quick", sequence: [{ duty: "implement", level: 1 }] },
      // level 2: the full inner pipeline.
      {
        description: "full",
        sequence: [
          { duty: "plan", level: 1 },
          { duty: "implement", level: 1 },
          { duty: "review", level: 1 },
          { duty: "test", level: 1 }
        ]
      }
    ]
  },
  plan: leaf("plan"),
  implement: leaf("implement"),
  review: leaf("review"),
  test: leaf("test"),
  "adversarial-review": leaf("adversarial-review"),
  "adversarial-test": leaf("adversarial-test"),
  walkthrough: leaf("walkthrough"),
  validate: leaf("validate")
};

// Build the runner-shaped resolved-model file the board reads: the union
// kanbanLists (from the Resolver) + every duty/level's precomputed leaf sequence.
function makeModel(selected: string[], duties: Record<string, any> = DUTIES) {
  const kanbanLists = deriveKanbanLists(selected, duties as any);
  const sequences: Record<string, Record<string, string[]>> = {};
  for (const [id, duty] of Object.entries(duties)) {
    const per: Record<string, string[]> = {};
    (duty as any).levels.forEach((_l: unknown, i: number) => {
      const level = i + 1;
      try {
        per[String(level)] = resolveSequence(id, level, duties as any).map((s) => s.duty);
      } catch {
        /* invalid combo — skip */
      }
    });
    sequences[id] = per;
  }
  return { version: 1 as const, compositionId: "test", kanbanLists, sequences };
}

const templates = () => phaseTemplatesFrom(seedBoard());

describe("S4a (a) — the board's list set is DERIVED from the resolved kanbanLists", () => {
  it("board = [backlog, todo] + resolver's kanbanLists + [done, needs-attention]", () => {
    const model = makeModel(["develop"]);
    // The union set the Resolver computes for this composition.
    expect(model.kanbanLists).toEqual(deriveKanbanLists(["develop"], DUTIES as any));

    const board = buildBoard(model, { templates: templates() });
    const ids = board.lists.map((l: any) => l.id);
    expect(ids).toEqual([...HUMAN_HEAD, ...model.kanbanLists, ...HUMAN_TAIL]);
    // The fixed human columns are present; no discuss column is invented.
    expect(ids).toContain("backlog");
    expect(ids).toContain("needs-attention");
    expect(ids).not.toContain("discuss");
  });

  it("each phase list carries agent behaviour from the canonical template", () => {
    const board = buildBoard(makeModel(["develop"]), { templates: templates() });
    const implement = board.lists.find((l: any) => l.id === "implement");
    expect(implement.kind).toBe("agent");
    expect(typeof implement.executePrompt).toBe("string");
    expect(implement.executePrompt.length).toBeGreaterThan(0);
  });
});

describe("S4a (c) — adding a duty adds its list; removing removes it", () => {
  it("a list appears/disappears with its duty (lists are derived, not hardcoded)", () => {
    const without = buildBoard(makeModel(["plan", "implement"]), { templates: templates() });
    expect(without.lists.map((l: any) => l.id)).not.toContain("review");

    const withReview = buildBoard(makeModel(["plan", "implement", "review"]), { templates: templates() });
    expect(withReview.lists.map((l: any) => l.id)).toContain("review");

    // Remove it again → gone.
    const removed = buildBoard(makeModel(["plan", "implement"]), { templates: templates() });
    expect(removed.lists.map((l: any) => l.id)).not.toContain("review");
  });
});

describe("S4a (d) — the goal hook / next-phase decider reads the resolved sequence", () => {
  const model = makeModel(["develop", "adversarial-review", "adversarial-test", "walkthrough", "validate"]);
  const seq2 = model.sequences.develop["2"]; // [plan, implement, review, test]

  it("nextListForCard walks the card's sequence and ends at done", () => {
    const card = { sequence: seq2 };
    expect(nextListForCard(card, "plan", model)).toBe("implement");
    expect(nextListForCard(card, "review", model)).toBe("test");
    expect(nextListForCard(card, "test", model)).toBe("done"); // last leaf → done
  });

  it("a card carrying only (duty, level) resolves its sequence from the model", () => {
    expect(resolveCardSequence({ duty: "develop", level: 2 }, model)).toEqual(["plan", "implement", "review", "test"]);
    expect(resolveCardSequence({ duty: "develop", level: 1 }, model)).toEqual(["implement"]);
    expect(nextListForCard({ duty: "develop", level: 1 }, "implement", model)).toBe("done");
  });

  it("validNextForCard adds the implement fail-edge only for gate phases", () => {
    const card = { sequence: seq2 };
    expect(validNextForCard(card, "review", model)).toEqual(["test", "implement"]); // gate
    expect(validNextForCard(card, "implement", model)).toEqual(["review"]); // non-gate
  });

  it("a legacy card (no duty/level/sequence) yields null → caller uses board validNext", () => {
    expect(resolveCardSequence({}, model)).toBeNull();
    expect(nextListForCard({}, "plan", model)).toBeNull();
    expect(validNextForCard({}, "plan", model)).toBeNull();
  });
});

// Drive a card through processCard until it lands on a non-agent list, recording
// every agent list it VISITS. The stub runFn answers with the card's own next
// forward step (per its resolved sequence), exactly what a compliant operative
// would emit — so the ENGINE's transition, not the stub, decides the path.
async function driveCard(root: string, board: any, startCard: any, model: any) {
  const runFn = async ({ card, list }: any) => {
    const phase = list.phase || list.id;
    const vn = validNextForCard(card, phase, model);
    return { reply: vn ? vn[0] : "done" };
  };
  const visited: string[] = [];
  let current = startCard;
  for (let i = 0; i < 20; i++) {
    const list = getList(board, current.list);
    if (!list || list.kind !== "agent") break;
    visited.push(current.list);
    const { card: next, outcome } = await processCard({ root, board, card: current, runFn, cap: 20, model });
    current = next;
    if (outcome.status !== "moved") break;
  }
  return { visited, final: current };
}

describe("S4a (b) — a card visits EXACTLY its resolved sequence and skips the rest", () => {
  const model = makeModel(["develop", "adversarial-review", "adversarial-test", "walkthrough", "validate"]);
  const board = buildBoard(model, { templates: templates() });

  it("the board carries the skippable lists too (they exist, the card just avoids them)", () => {
    const ids = board.lists.map((l: any) => l.id);
    for (const id of ["plan", "implement", "review", "test", "adversarial-review", "adversarial-test", "walkthrough", "validate"]) {
      expect(ids).toContain(id);
    }
  });

  it("level 2 (duty=develop) visits [plan, implement, review, test] and skips the adversarial/walkthrough/validate lists", async () => {
    const root = tmp();
    const seq = model.sequences.develop["2"];
    const card = await createCard(root, {
      title: "wide change",
      project: "demo",
      list: "plan",
      duty: "develop",
      level: 2,
      sequence: seq
    });
    const { visited, final } = await driveCard(root, board, card, model);
    expect(visited).toEqual(["plan", "implement", "review", "test"]);
    expect(final.list).toBe("done");
    for (const skipped of ["adversarial-review", "adversarial-test", "walkthrough", "validate"]) {
      expect(visited).not.toContain(skipped);
    }
  });

  it("level 1 (duty=develop) visits ONLY [implement]", async () => {
    const root = tmp();
    const seq = model.sequences.develop["1"]; // [implement]
    const card = await createCard(root, {
      title: "quick change",
      project: "demo",
      list: "implement",
      duty: "develop",
      level: 1,
      sequence: seq
    });
    const { visited, final } = await driveCard(root, board, card, model);
    expect(visited).toEqual(["implement"]);
    expect(final.list).toBe("done");
  });
});

describe("S4a — no regression: a legacy card flows on the board's static validNext", () => {
  it("a card with no duty/level/sequence advances via the default pipeline", async () => {
    const root = tmp();
    const board = seedBoard(); // the built-in default pipeline (no model present)
    const card = await createCard(root, { title: "legacy", project: "p", list: "plan" });
    const runFn = async () => ({ reply: "implement" }); // the plan list's static forward edge
    const { outcome } = await processCard({ root, board, card, runFn, cap: 10 });
    expect(outcome.status).toBe("moved");
    expect(outcome.to).toBe("implement");
  });
});

// ── S4a codex-fix regression suite — one test per finding (the determinism ratchet).
// The board column order is a LEGACY fallback ONLY; a card carrying a resolved
// (duty, level) sequence advances by ITS SEQUENCE, never by the board's next column.

// The finding's exact model: a Test list whose board-forward is 'adversarial-test'
// (test is NOT the last board column), but a card whose sequence ENDS at 'test'.
const BATCH_MODEL = {
  version: 1 as const,
  compositionId: "test",
  kanbanLists: ["plan", "implement", "review", "test", "adversarial-test"],
  sequences: { develop: { "2": ["plan", "implement", "review", "test"] } }
};

describe("S4a codex finding #1 — the batched Test path advances by the card's sequence, not board column order", () => {
  const board = buildBoard(BATCH_MODEL, { templates: templates() });
  const seqCard = () => ({
    id: "01ARZ3NDEKTSV4RRFFQ69BATCH",
    list: "test",
    duty: "develop",
    level: 2,
    sequence: ["plan", "implement", "review", "test"]
  });

  it("parseBatchVerdicts accepts the card's sequence-end 'done' and REJECTS the board column 'adversarial-test'", () => {
    const c = seqCard();
    // With the resolved model: test is the sequence end → valid-next = [done, implement].
    expect(parseBatchVerdicts(`${c.id} done`, [c], board, BATCH_MODEL)[c.id]).toBe("done");
    expect(parseBatchVerdicts(`${c.id} adversarial-test`, [c], board, BATCH_MODEL)[c.id]).toBeNull();
  });

  it("a LEGACY card (no sequence) still parses against the board's static validNext", () => {
    const legacy = { id: "01ARZ3NDEKTSV4RRFFQ69LEGCY", list: "test" };
    // Board's Test column forward is 'adversarial-test' — the legacy fallback path.
    expect(parseBatchVerdicts(`${legacy.id} adversarial-test`, [legacy], board)[legacy.id]).toBe("adversarial-test");
    expect(parseBatchVerdicts(`${legacy.id} done`, [legacy], board)[legacy.id]).toBeNull();
  });

  it("processBatch MOVES a sequence-ended card to 'done' on its own verdict", async () => {
    const root = tmp();
    await createCard(root, { title: "seq-end", project: "demo", list: "test", duty: "develop", level: 2, sequence: ["plan", "implement", "review", "test"] });
    const all = await loadAllCards(root);
    const batchRunFn = async ({ cards }: { cards: any[] }) => ({ reply: cards.map((c) => `${c.id} done`).join("\n") });
    const { outcomes } = await processBatch({ root, board, listId: "test", cards: all, batchRunFn, cap: 10, model: BATCH_MODEL });
    expect(outcomes).toHaveLength(1);
    expect(outcomes[0].status).toBe("moved");
    expect(outcomes[0].to).toBe("done");
  });

  it("processBatch REFUSES to advance a sequence-ended card to the board's next column ('adversarial-test')", async () => {
    const root = tmp();
    await createCard(root, { title: "seq-end", project: "demo", list: "test", duty: "develop", level: 2, sequence: ["plan", "implement", "review", "test"] });
    const all = await loadAllCards(root);
    // The operative names the board's next column — off this card's sequence.
    const batchRunFn = async ({ cards }: { cards: any[] }) => ({ reply: cards.map((c) => `${c.id} adversarial-test`).join("\n") });
    const { outcomes } = await processBatch({ root, board, listId: "test", cards: all, batchRunFn, cap: 10, model: BATCH_MODEL });
    expect(outcomes[0].status).toBe("needs-attention");
    expect(outcomes[0].to).toBeUndefined();
    const remaining: any[] = await loadAllCards(root);
    const parked = await loadCard(root, remaining[0].id);
    expect(parked.list).toBe("needs-attention"); // NOT advanced to adversarial-test
  });
});

describe("S4a codex finding #2 — effectiveListForCard skips OFF phases along the card's sequence, not board column order", () => {
  // A model whose board column order makes implement→review the static edge, but a
  // level-1 develop card whose sequence is ONLY [implement] (so after implement → done).
  const model = {
    version: 1 as const,
    compositionId: "test",
    kanbanLists: ["implement", "review", "test"],
    sequences: { develop: { "1": ["implement"], "2": ["implement", "review", "test"] } }
  };
  const board = buildBoard(model, { templates: templates() });
  // A rail that turns the card's current phase (implement) OFF and keeps review ON.
  const rail = { workKind: "k", evidence: "none", phases: [{ id: "implement", on: false }, { id: "review", on: true }] };

  it("a card whose sequence ENDS at the OFF phase fast-forwards to 'done' (its sequence), NOT 'review' (board column)", () => {
    const seqCard = { list: "implement", duty: "develop", level: 1, sequence: ["implement"] };
    const { listId, skipped } = effectiveListForCard(board, rail, "implement", seqCard, model);
    expect(skipped).toEqual(["implement"]);
    expect(listId).toBe("done"); // the bug advanced this to 'review'
  });

  it("a LEGACY card (no sequence) still fast-forwards along the board's column order to 'review'", () => {
    const legacy = { list: "implement" };
    const { listId } = effectiveListForCard(board, rail, "implement", legacy, model);
    expect(listId).toBe("review"); // board-column fallback preserved for legacy cards
  });
});

describe("S4a codex finding #3 — an EXISTING board is reconciled to the current resolved model (not only a fresh seed)", () => {
  it("adding a selected duty ADDS its list to the existing board, preserving projects + rev", () => {
    const existing = buildBoard(makeModel(["plan", "implement"]), { templates: templates() });
    existing.projects = { demo: { repoPath: "/x" } };
    existing.rev = 7;
    expect(existing.lists.map((l: any) => l.id)).not.toContain("review");

    const { board, added, removed } = reconcileBoardLists(existing, makeModel(["plan", "implement", "review"]), { templates: templates() });
    expect(board.lists.map((l: any) => l.id)).toContain("review"); // the failing case: the list must appear
    expect(added).toContain("review");
    expect(removed).toEqual([]);
    // Non-structural state is preserved across the reconcile.
    expect(board.projects).toEqual({ demo: { repoPath: "/x" } });
    expect(board.rev).toBe(7);
  });

  it("removing a selected duty REMOVES its list AND relocates any stranded card to needs-attention WITHOUT losing it", async () => {
    const root = tmp();
    const existing = buildBoard(makeModel(["plan", "implement", "review"]), { templates: templates() });
    // A card mid-pipeline on the list that is about to be removed, plus one on a kept list.
    const onReview = await createCard(root, { title: "on review", project: "demo", list: "review", duty: "develop", level: 2, sequence: ["plan", "implement", "review", "test"] });
    const onImplement = await createCard(root, { title: "on implement", project: "demo", list: "implement" });

    const { board, removed } = reconcileBoardLists(existing, makeModel(["plan", "implement"]), { templates: templates() });
    expect(removed).toContain("review");
    expect(board.lists.map((l: any) => l.id)).not.toContain("review");

    const moved = await relocateStrandedCards(root, board, removed);
    expect(moved).toContain(onReview.id);

    const parked = await loadCard(root, onReview.id);
    expect(parked.list).toBe("needs-attention");
    expect(parked.status).toBe("needs-attention");
    expect(parked.parkedFrom).toBe("review");
    // Card state is PRESERVED (never clobbered): the title + duty/sequence survive.
    expect(parked.title).toBe("on review");
    expect(parked.sequence).toEqual(["plan", "implement", "review", "test"]);

    // A card on a still-present list is untouched.
    const kept = await loadCard(root, onImplement.id);
    expect(kept.list).toBe("implement");
  });

  it("a no-op reconcile (identical list set) reports nothing added or removed", () => {
    const existing = buildBoard(makeModel(["plan", "implement"]), { templates: templates() });
    const { added, removed } = reconcileBoardLists(existing, makeModel(["plan", "implement"]), { templates: templates() });
    expect(added).toEqual([]);
    expect(removed).toEqual([]);
  });
});

describe("S4a codex finding #4 — the runner does NOT project an empty resolved model", () => {
  it("a composition with no selected duties yields an empty model → the guard SKIPS the write, no misleading log", () => {
    const empty = computeKanbanResolvedModel({ id: "c", duties: [], selectedDuties: [] }, []);
    expect(empty.kanbanLists).toEqual([]); // the guard's precondition (no resolved duty model)

    const plan = kanbanProjectionPlan(empty);
    expect(plan.write).toBe(false);
    expect(plan.log).not.toMatch(/projected/); // never claims a projection happened
    expect(plan.log).toMatch(/default pipeline/);
  });

  it("a non-empty resolved duty model DOES project, logging the real list count", () => {
    const plan = kanbanProjectionPlan({ version: 2, compositionId: "c", kanbanLists: ["plan", "implement", "review"], sequences: {}, cells: {} });
    expect(plan.write).toBe(true);
    expect(plan.log).toContain("projected 3 phase list(s)");
    expect(plan.log).toContain("plan, implement, review");
  });
});

describe("duty cells projection (the duties->router repoint input)", () => {
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
    { id: "sdk-haiku", runtime: "agent-sdk", model: "claude-haiku-4-5", provider: "anthropic", params: { type: "runtime-target" } },
    { id: "cc-sonnet", runtime: "claude-code", model: "sonnet", provider: "anthropic-plan", params: { type: "runtime-target" } }
  ];

  it("joins each leaf level's cell with its target spec; composite levels have no cell", () => {
    const model = computeKanbanResolvedModel({ id: "c", duties, selectedDuties: ["code", "pipeline"], targets }, []);
    expect(model.version).toBe(2);
    expect(model.cells.code["1"]).toEqual({
      target: "sdk-haiku",
      effort: "low",
      runtime: "agent-sdk",
      model: "claude-haiku-4-5",
      provider: "anthropic",
      type: "runtime-target"
    });
    expect(model.cells.code["2"].model).toBe("sonnet");
    expect(model.cells.code["2"].effort).toBe("medium");
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
      type: null
    });
  });
});

// ── engine facade / CLI import surface (relocated regression guard) ─────────
// scripts/kanban.mjs is the CLI entrypoint the fitting's setup hook runs during
// `up` (`node scripts/kanban.mjs --setup`); it imports its whole board-helper
// surface from engine.mjs. phaseForList is defined in policy.mjs and engine.mjs
// imported it for INTERNAL use only, without re-exporting it — so the CLI's
// top-level import threw "does not provide an export named 'phaseForList'" and
// setup exited 1 the first time a live `up` ran. No vitest loads kanban.mjs's
// module graph, so the marathon's gates (readiness via resolveModel, not a live
// up) never hit it. These guard the exact export set the CLI entrypoint needs.
const GUARDED_ENGINE_EXPORTS: Record<string, unknown> = {
  processCard,
  processBatch,
  getList,
  triggerFor,
  isInteractive,
  isGatedDiscuss,
  withEvent,
  phaseForList
};
function symbolsImportedFromEngine(src: string): string[] {
  const m = src.match(/import\s*\{([^}]*)\}\s*from\s*["'][^"']*lib\/engine\.mjs["']/);
  if (!m) return [];
  return m[1].split(",").map((s) => s.trim()).filter(Boolean);
}

describe("kanban-loop engine facade — scripts/kanban.mjs CLI import surface", () => {
  it("engine.mjs exports every symbol the --setup CLI entrypoint imports from it", () => {
    for (const [name, value] of Object.entries(GUARDED_ENGINE_EXPORTS)) {
      expect(
        typeof value,
        `engine.mjs must export "${name}" — scripts/kanban.mjs imports it, and a missing export makes \`node scripts/kanban.mjs --setup\` exit 1 during \`up\``
      ).toBe("function");
    }
    expect(typeof phaseForList).toBe("function"); // the exact symbol that regressed
  });

  it("the guarded set matches the CLI's actual engine import line (auto-tracks new imports)", () => {
    const cliUrl = new URL("../fittings/seed/kanban-loop/scripts/kanban.mjs", import.meta.url);
    const cliNames = symbolsImportedFromEngine(readFileSync(fileURLToPath(cliUrl), "utf8")).sort();
    expect(cliNames.length).toBeGreaterThan(0);
    expect(cliNames).toEqual(Object.keys(GUARDED_ENGINE_EXPORTS).sort());
  });
});
