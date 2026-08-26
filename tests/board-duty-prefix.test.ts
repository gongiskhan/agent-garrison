// Board v7: duty-backed lists announce themselves, and the retired `code` list goes.
//
// The board is the surface Gonçalo reads all day. A column called "Review" that is
// actually a routed agent step looks identical to a column he parks things in, and
// that ambiguity is a large part of why the orchestration is hard to hold in your
// head (ORCHESTRATOR_COHERENCE.md §2.4).
//
// Conversations (BOARD_VERSION 10) did NOT retire these migrations — a legacy
// board still has to heal on read so its columns and card refs stay coherent
// until scripts/migrate-conversations.mjs runs. What changed is the STAMP:
// v9→v10 is a guard, not a transform, so migrateBoard heals a legacy board and
// leaves it stamped AT MOST 9. Every case below therefore asserts LEGACY_CEILING,
// and the guard itself is pinned at the bottom of this file: nothing but the
// migration script may stamp a board BOARD_VERSION.

import { describe, expect, it, beforeAll, afterAll } from "vitest";
// @ts-expect-error — plain .mjs fitting module, no types
import { migrateBoard, BOARD_VERSION, dutyListTitle, relocateRetiredListCards } from "../fittings/seed/kanban-loop/lib/board.mjs";

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

// The highest version migrateBoard may stamp. The pre-v9 blocks still run; the
// v10 guard returns the healed board at 9 so a half-migrated board (new columns,
// old cards) can never be served.
const LEGACY_CEILING = 9;

describe("board v7 — duty: prefix + the retired code list", () => {
  it("prefixes every duty-backed list without touching its id", () => {
    const out = migrateBoard(v5Board());
    expect(out.version).toBe(LEGACY_CEILING);
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
    expect(out.version).toBe(LEGACY_CEILING);
    expect(byId(out, "code")).toBeUndefined();
    expect(byId(out, "ux-qa")?.title).toBe("duty: UX QA");
  });
});

// v7→v8: the mis-created `ice-box` list — a human-managed parking column that the
// old "Add list" flow turned into an agent DUTY — becomes what the user intended.
describe("board v8 — ice-box converted to a human-managed manual list", () => {
  const v7WithIceBox = () => ({
    version: 7,
    lists: [
      { id: "scheduled", kind: "scheduled", title: "Scheduled", order: -1, validNext: [] },
      { id: "todo", kind: "manual", title: "To Do", order: 1, validNext: ["implement"] },
      { id: "implement", kind: "agent", phase: "implement", title: "duty: Implement", order: 2, validNext: ["review"] },
      {
        id: "ice-box",
        kind: "agent",
        phase: "ice-box",
        title: "duty: Ice Box",
        order: 3,
        trigger: "immediate",
        executePrompt: "run the ice-box phase",
        routerPrompt: "end with the next list",
        validNext: ["done"]
      },
      { id: "done", kind: "manual", title: "Done", order: 8, validNext: [] },
      { id: "archived", kind: "manual", title: "Archived", order: 9, validNext: [] }
    ]
  });

  it("turns ice-box into a manual, user-created, unprefixed list without touching its id", () => {
    const out = migrateBoard(v7WithIceBox());
    expect(out.version).toBe(LEGACY_CEILING);
    const ib = byId(out, "ice-box");
    expect(ib?.id).toBe("ice-box"); // cards reference it
    expect(ib?.title).toBe("Ice Box"); // no `duty:` prefix
    expect(ib?.kind).toBe("manual");
    expect(ib?.trigger).toBe("manual");
    expect(ib?.userCreated).toBe(true);
    expect(ib?.validNext).toEqual([]);
    // Agent behaviour is stripped so it can never start a run on drop.
    expect(ib?.phase).toBeUndefined();
    expect(ib?.executePrompt).toBeUndefined();
    expect(ib?.routerPrompt).toBeUndefined();
  });

  it("leaves the genuine duty lists agent-managed", () => {
    const out = migrateBoard(v7WithIceBox());
    expect(byId(out, "implement")?.kind).toBe("agent");
    expect(byId(out, "implement")?.title).toBe("duty: Implement");
  });

  it("is idempotent", () => {
    const once = migrateBoard(v7WithIceBox());
    expect(migrateBoard(structuredClone(once))).toEqual(once);
  });
});

// v9→v10 (Conversations) is a GUARD, not a transform. The board becomes five
// state columns and the legacy cards freeze as history — a CARD migration, done
// in one pass by scripts/migrate-conversations.mjs. Read-time migration must
// therefore never stamp BOARD_VERSION: a board stamped 10 with v9 cards still on
// retired lists would strand every one of them through relocateStrandedCards.
describe("board v10 — the Conversations guard (stamp, never transform)", () => {
  it("heals a legacy board but refuses to stamp it BOARD_VERSION", () => {
    for (const legacy of [v5Board(), { ...v5Board(), version: 6 }, { ...v5Board(), version: 7 }]) {
      const out = migrateBoard(legacy);
      expect(out.version).toBe(LEGACY_CEILING);
      expect(out.version).toBeLessThan(BOARD_VERSION);
    }
  });

  it("leaves the layout alone — no five-column rewrite on read", () => {
    const out = migrateBoard(v5Board());
    // The healed board still carries its legacy duty columns; the five-state
    // board arrives with the migration script, not with a page load.
    expect(byId(out, "implement")).toBeDefined();
    expect(byId(out, "running")).toBeUndefined();
    expect(byId(out, "needs-attention")).toBeUndefined();
  });

  it("passes a board already at BOARD_VERSION through untouched (identity, not a copy)", () => {
    const migrated = { version: BOARD_VERSION, lists: [{ id: "todo", title: "To do", kind: "manual" }] };
    expect(migrateBoard(migrated)).toBe(migrated);
  });
});
