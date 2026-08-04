// Item 2 — the Move sheet's target derivation. The Move button is the MANUAL gate:
// it offers EVERY list except the card's current one (not the list's validNext), so a
// card can be moved anywhere by hand. Agent-kind targets are flagged (moving there
// auto-dispatches a run), never hidden. Pure module, so this needs no board/React.
import { describe, it, expect } from "vitest";
import { deriveMoveTargets } from "../fittings/seed/kanban-loop/ui/move-targets";

const board = {
  lists: [
    { id: "backlog", title: "Backlog", kind: "manual" },
    { id: "todo", title: "To Do", kind: "manual" },
    { id: "plan", title: "Plan", kind: "agent" },
    { id: "done", title: "Done", kind: "manual" }
  ]
};

describe("deriveMoveTargets — move offers every list except the current one", () => {
  it("move targets are all lists minus the card's current list, in board order", () => {
    const targets = deriveMoveTargets(board as any, { list: "backlog" });
    expect(targets.map((t) => t.id)).toEqual(["todo", "plan", "done"]);
    // Order is preserved from the board.
    expect(targets.map((t) => t.title)).toEqual(["To Do", "Plan", "Done"]);
  });

  it("move flags agent-kind targets (dropping there auto-dispatches a run)", () => {
    const targets = deriveMoveTargets(board as any, { list: "backlog" });
    const plan = targets.find((t) => t.id === "plan")!;
    const todo = targets.find((t) => t.id === "todo")!;
    expect(plan.isAgent).toBe(true);
    expect(plan.kind).toBe("agent");
    expect(todo.isAgent).toBe(false);
  });

  it("a card on an agent list can still be moved to every other list", () => {
    const targets = deriveMoveTargets(board as any, { list: "plan" });
    expect(targets.map((t) => t.id)).toEqual(["backlog", "todo", "done"]);
  });

  it("falls back to the id when a list has no title, and never offers the current list", () => {
    const b = { lists: [{ id: "backlog", kind: "manual" }, { id: "weird" }] };
    const targets = deriveMoveTargets(b as any, { list: "backlog" });
    expect(targets).toEqual([{ id: "weird", title: "weird", kind: "manual", isAgent: false }]);
  });

  it("returns [] for an empty or malformed board", () => {
    expect(deriveMoveTargets({} as any, { list: "backlog" })).toEqual([]);
    expect(deriveMoveTargets({ lists: [] } as any, { list: "backlog" })).toEqual([]);
  });
});
