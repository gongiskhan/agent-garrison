import { describe, expect, it } from "vitest";
import {
  hiddenListCount,
  isAutonomousList,
  isHiddenList,
  visibleLists,
} from "../fittings/seed/kanban-loop/ui/list-visibility";

// A board shaped like the real one: human surfaces, the two system lists, an
// interactive agent list (Discuss), and a rail of autonomous phases where only
// one is occupied.
const board = [
  { id: "scheduled", kind: "system", system: true, cards: [] },
  { id: "backlog", kind: "manual", cards: [] },
  { id: "todo", kind: "manual", cards: [{ id: "c1" }] },
  { id: "discuss", kind: "agent", interactive: true, cards: [] },
  { id: "plan", kind: "agent", cards: [] },
  { id: "implement", kind: "agent", cards: [{ id: "c2" }] },
  { id: "test", kind: "agent", cards: [] },
  { id: "review", kind: "agent", cards: [] },
  { id: "running", kind: "system", system: true, cards: [] },
  { id: "done", kind: "manual", cards: [] },
];

const ids = (lists: { id: string }[]) => lists.map((l) => l.id);

describe("autonomous-list visibility", () => {
  it("classifies only engine-owned agent lists as autonomous", () => {
    expect(isAutonomousList({ id: "plan", kind: "agent" })).toBe(true);
    // Discuss is a human surface even though its kind is agent.
    expect(isAutonomousList({ id: "discuss", kind: "agent", interactive: true })).toBe(false);
    expect(isAutonomousList({ id: "todo", kind: "manual" })).toBe(false);
    expect(isAutonomousList({ id: "running", kind: "system", system: true })).toBe(false);
  });

  it("hides autonomous phases that hold no cards, and nothing else", () => {
    expect(ids(visibleLists(board))).toEqual([
      "scheduled", "backlog", "todo", "discuss", "implement", "running", "done",
    ]);
    expect(hiddenListCount(board)).toBe(3);
  });

  it("keeps an EMPTY manual or system list — those are where a human puts work", () => {
    // backlog, done, scheduled and running are all empty above and all survive.
    for (const id of ["backlog", "done", "scheduled", "running", "discuss"]) {
      expect(ids(visibleLists(board))).toContain(id);
    }
  });

  it("never hides an autonomous list that holds a card", () => {
    expect(isHiddenList({ id: "implement", kind: "agent", cards: [{ id: "c2" }] })).toBe(false);
  });

  it("reveals every column while a drag is in flight, so no drop target vanishes", () => {
    expect(ids(visibleLists(board, { dragging: true }))).toEqual(ids(board));
    expect(hiddenListCount(board, { dragging: true })).toBe(0);
  });

  it("reveals every column when the human asks for all of them", () => {
    expect(ids(visibleLists(board, { showAll: true }))).toEqual(ids(board));
    expect(hiddenListCount(board, { showAll: true })).toBe(0);
  });

  it("preserves the order it was given", () => {
    const reversed = [...board].reverse();
    const out = ids(visibleLists(reversed));
    expect(out).toEqual(ids(visibleLists(board)).reverse());
  });

  it("treats a missing cards array as empty rather than throwing", () => {
    expect(isHiddenList({ id: "plan", kind: "agent" })).toBe(true);
    expect(isHiddenList({ id: "plan", kind: "agent", cards: null })).toBe(true);
  });
});
