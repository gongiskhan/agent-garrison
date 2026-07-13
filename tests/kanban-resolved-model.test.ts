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

import { mkdtempSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";

import { deriveKanbanLists, resolveSequence } from "../src/lib/resolver";
// @ts-ignore — pure .mjs
import { buildBoard, validNextForCard, nextListForCard, resolveCardSequence, HUMAN_HEAD, HUMAN_TAIL } from "../fittings/seed/kanban-loop/lib/resolved-model.mjs";
// @ts-ignore — pure .mjs
import { processCard, getList } from "../fittings/seed/kanban-loop/lib/engine.mjs";
// @ts-ignore — pure .mjs
import { createCard } from "../fittings/seed/kanban-loop/lib/board.mjs";
// @ts-ignore — pure .mjs
import { seedBoard, phaseTemplatesFrom } from "../fittings/seed/kanban-loop/scripts/kanban.mjs";

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
