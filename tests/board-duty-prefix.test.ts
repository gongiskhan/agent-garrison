// Board v7: duty-backed lists announce themselves, and the retired `code` list goes.
//
// The board is the surface Gonçalo reads all day. A column called "Review" that is
// actually a routed agent step looks identical to a column he parks things in, and
// that ambiguity is a large part of why the orchestration is hard to hold in your
// head (ORCHESTRATOR_COHERENCE.md §2.4).

import { describe, expect, it } from "vitest";
// @ts-expect-error — plain .mjs fitting module, no types
import { migrateBoard, BOARD_VERSION, dutyListTitle, relocateRetiredListCards } from "../fittings/seed/kanban-loop/lib/board.mjs";

const v5Board = () => ({
  version: 5,
  lists: [
    { id: "scheduled", kind: "scheduled", title: "Scheduled", order: -1, validNext: [] },
    { id: "todo", kind: "manual", title: "To Do", order: 1, validNext: ["code"] },
    { id: "discuss", kind: "agent-interactive", phase: "discuss", title: "Discuss", order: 2 },
    { id: "code", kind: "agent", phase: "code", title: "Code", order: 3, validNext: ["review"] },
    { id: "implement", kind: "agent", phase: "implement", title: "Implement", order: 4, validNext: ["code", "review"] },
    { id: "ux-qa", kind: "agent", phase: "ux-qa", title: "Ux Qa", order: 5, validNext: [] },
    { id: "done", kind: "manual", title: "Done", order: 8, validNext: [] },
    { id: "archived", kind: "manual", title: "Archived", order: 9, validNext: [] }
  ]
});

const byId = (b: { lists: { id: string }[] }, id: string) =>
  b.lists.find((l) => l.id === id) as Record<string, unknown> | undefined;

describe("board v7 — duty: prefix + the retired code list", () => {
  it("prefixes every duty-backed list without touching its id", () => {
    const out = migrateBoard(v5Board());
    expect(out.version).toBe(BOARD_VERSION);
    expect(byId(out, "implement")?.title).toBe("duty: Implement");
    expect(byId(out, "implement")?.id).toBe("implement"); // ids are persisted card refs
  });

  it("fixes ids that title-case badly rather than shipping 'Ux Qa'", () => {
    expect(byId(migrateBoard(v5Board()), "ux-qa")?.title).toBe("duty: UX QA");
    expect(dutyListTitle("adversarial-review")).toBe("duty: Adversarial Review");
    expect(dutyListTitle("codex-checkpoint")).toBe("duty: Codex Checkpoint");
  });

  it("leaves the non-duty lists exactly as they were", () => {
    const out = migrateBoard(v5Board());
    for (const id of ["scheduled", "todo", "done", "archived"]) {
      expect(byId(out, id)?.title, id).toBe(byId(v5Board(), id)?.title);
    }
  });

  it("leaves Discuss unprefixed — it is a destination, not a step", () => {
    // A card sits in Discuss across many turns of conversation; it does not pass
    // THROUGH it the way it passes through Implement or Review.
    expect(byId(migrateBoard(v5Board()), "discuss")?.title).toBe("Discuss");
  });

  it("drops the retired code list and re-points references at implement", () => {
    const out = migrateBoard(v5Board());
    expect(byId(out, "code")).toBeUndefined();
    expect(byId(out, "implement")?.validNext).toEqual(["implement", "review"]);
    expect(byId(out, "todo")?.validNext).toEqual(["implement"]);
  });

  it("relocates a card stranded in the retired list", () => {
    expect(relocateRetiredListCards({ id: "x", list: "code" })).toMatchObject({ list: "implement" });
    expect(relocateRetiredListCards({ id: "x", list: "review" })).toMatchObject({ list: "review" });
  });

  it("keeps the code list when there is no implement list to absorb it", () => {
    // Never strand cards: dropping a list whose successor does not exist would
    // orphan every card in it.
    const board = v5Board();
    board.lists = board.lists.filter((l) => l.id !== "implement");
    const out = migrateBoard(board);
    expect(byId(out, "code")).toBeDefined();
  });

  it("is idempotent, and does not re-prefix a title the user already renamed", () => {
    const once = migrateBoard(v5Board());
    expect(migrateBoard(structuredClone(once))).toEqual(once);
    const renamed = { ...v5Board(), version: 5 };
    (renamed.lists.find((l) => l.id === "implement") as Record<string, unknown>).title = "duty: Build It";
    expect(byId(migrateBoard(renamed), "implement")?.title).toBe("duty: Build It");
  });

  it("heals a board stamped v6 by the mid-edit window", () => {
    // A live kanban process re-read the module after BOARD_VERSION became 6 but
    // before the migration body existed, and stamped both live boards v6 with
    // nothing applied. Gating on <7 is what rescues them.
    const stranded = { ...v5Board(), version: 6 };
    const out = migrateBoard(stranded);
    expect(out.version).toBe(BOARD_VERSION);
    expect(byId(out, "code")).toBeUndefined();
    expect(byId(out, "ux-qa")?.title).toBe("duty: UX QA");
  });
});
