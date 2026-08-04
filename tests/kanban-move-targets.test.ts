// Item 2 — the Move sheet's target derivation. The Move button is the MANUAL gate:
// it offers EVERY list except the card's current one (not the list's validNext), so a
// card can be moved anywhere by hand. Agent-kind targets are flagged (moving there
// auto-dispatches a run), never hidden. Pure module, so this needs no board/React.
import { describe, it, expect } from "vitest";
import { deriveMoveTargets, isManualImportTarget } from "../fittings/seed/kanban-loop/ui/move-targets";

const board = {
  lists: [
    { id: "backlog", title: "Backlog", kind: "manual" },
    { id: "todo", title: "To Do", kind: "manual" },
    { id: "plan", title: "Plan", kind: "agent", trigger: "immediate" },
    { id: "test", title: "Test", kind: "agent", trigger: "scheduler-beat" },
    { id: "discuss", title: "Discuss", kind: "agent-interactive", trigger: "manual", interactive: true },
    { id: "done", title: "Done", kind: "manual" }
  ]
};

describe("deriveMoveTargets — move offers every list except the current one", () => {
  it("move targets are all lists minus the card's current list, in board order", () => {
    const targets = deriveMoveTargets(board as any, { list: "backlog" });
    expect(targets.map((t) => t.id)).toEqual(["todo", "plan", "test", "discuss", "done"]);
    // Order is preserved from the board.
    expect(targets.map((t) => t.title)).toEqual(["To Do", "Plan", "Test", "Discuss", "Done"]);
  });

  it("move flags agent-kind targets (dropping there auto-dispatches a run)", () => {
    const targets = deriveMoveTargets(board as any, { list: "backlog" });
    const plan = targets.find((t) => t.id === "plan")!;
    const todo = targets.find((t) => t.id === "todo")!;
    expect(plan.isAgent).toBe(true);
    expect(plan.startsRun).toBe(true);
    expect(plan.kind).toBe("agent");
    expect(todo.isAgent).toBe(false);
    expect(todo.startsRun).toBe(false);
    expect(targets.find((t) => t.id === "test")?.startsRun).toBe(false);
    expect(targets.find((t) => t.id === "discuss")?.isAgent).toBe(true);
    expect(targets.find((t) => t.id === "discuss")?.startsRun).toBe(false);
  });

  it("warns that clarity-gated Discuss starts its interactive run", () => {
    const targets = deriveMoveTargets(board as any, { list: "backlog", clarity: "needs-discuss" });
    expect(targets.find((t) => t.id === "discuss")).toMatchObject({
      kind: "agent-interactive",
      isAgent: true,
      startsRun: true
    });
  });

  it("a card on an agent list can still be moved to every other list", () => {
    const targets = deriveMoveTargets(board as any, { list: "plan" });
    expect(targets.map((t) => t.id)).toEqual(["backlog", "todo", "test", "discuss", "done"]);
  });

  it("falls back to the id when a list has no title, and never offers the current list", () => {
    const b = { lists: [{ id: "backlog", kind: "manual" }, { id: "weird" }] };
    const targets = deriveMoveTargets(b as any, { list: "backlog" });
    expect(targets).toEqual([{ id: "weird", title: "weird", kind: "manual", isAgent: false, startsRun: false }]);
  });

  it("returns [] for an empty or malformed board", () => {
    expect(deriveMoveTargets({} as any, { list: "backlog" })).toEqual([]);
    expect(deriveMoveTargets({ lists: [] } as any, { list: "backlog" })).toEqual([]);
  });

  it("only allows human-held lists as import destinations", () => {
    expect(board.lists.filter(isManualImportTarget).map((list) => list.id)).toEqual(["backlog", "todo", "done"]);
  });
});
