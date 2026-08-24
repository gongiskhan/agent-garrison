// Adversarial lifecycle locking: the per-card lock is external to cards/<id>,
// every transition checks existence/rev before running preflight side effects,
// and Delete cannot unlink a held lock then let a late writer resurrect the card.
import { describe, it, expect, beforeAll, afterAll } from "vitest";
import { mkdtempSync, existsSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";

// @ts-ignore — pure .mjs
import {
  createCard,
  deleteCard,
  loadCard,
  saveCardCAS,
  saveCardCASWithHooks
  // @ts-ignore — pure .mjs
} from "../fittings/seed/kanban-loop/lib/board.mjs";

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


const tmp = () => mkdtempSync(join(tmpdir(), "kanban-lifecycle-"));

describe("external per-card lifecycle lock", () => {
  it("restores coordination when a terminal card is reopened", async () => {
    // @ts-ignore — pure .mjs
    const { shouldRecoverCoordinationHold } = await import("../fittings/seed/kanban-loop/scripts/server.mjs");
    const board = {
      lists: [
        { id: "todo", kind: "manual" },
        { id: "implement", kind: "agent" },
        { id: "done", kind: "manual", terminal: true },
        { id: "archived", kind: "manual", terminal: true, archived: true }
      ]
    };

    expect(
      shouldRecoverCoordinationHold(
        board,
        { list: "archived", runDir: "runs/card" },
        { list: "todo", runDir: "runs/card" }
      )
    ).toBe(true);
    expect(
      shouldRecoverCoordinationHold(
        board,
        { list: "done", runDir: "runs/card" },
        { list: "implement", runDir: "runs/card" }
      )
    ).toBe(true);
    expect(
      shouldRecoverCoordinationHold(
        board,
        { list: "done", runDir: "runs/card" },
        { list: "archived", runDir: "runs/card" }
      )
    ).toBe(false);
  });

  it("never runs a recovery preflight for a losing CAS", async () => {
    const root = tmp();
    const created = await createCard(root, { title: "held", list: "needs-attention" });
    const bumped = await saveCardCAS(root, { ...created, title: "newer" }, created.rev ?? 0);
    expect(bumped.ok).toBe(true);

    let preflights = 0;
    let cleanups = 0;
    const stale = await saveCardCASWithHooks(
      root,
      { ...created, list: "implement" },
      created.rev ?? 0,
      "2026-08-03T10:00:00.000Z",
      {
        beforeWrite: () => { preflights += 1; return { ok: true }; },
        afterWrite: () => { cleanups += 1; }
      }
    );

    expect(stale).toMatchObject({ ok: false, conflict: true });
    expect(preflights).toBe(0);
    expect(cleanups).toBe(0);
    expect((await loadCard(root, created.id)).title).toBe("newer");
  });

  it("serializes Delete behind an in-flight save and leaves no resurrected card", async () => {
    const root = tmp();
    const card = await createCard(root, { title: "race", list: "plan" });

    let entered: () => void = () => {};
    const atPreflight = new Promise<void>((resolve) => { entered = resolve; });
    let release: () => void = () => {};
    const held = new Promise<void>((resolve) => { release = resolve; });

    const lateSave = saveCardCASWithHooks(
      root,
      { ...card, title: "saved before delete" },
      card.rev ?? 0,
      "2026-08-03T10:00:00.000Z",
      {
        beforeWrite: async () => {
          entered();
          await held;
          return { ok: true };
        }
      }
    );
    await atPreflight;

    // This starts while save owns the lifecycle lock. With the historical
    // cards/<id>/.lock location, Delete removed the lock and a late save could
    // recreate the card. The external lock forces save-then-delete ordering, and
    // the store's no-resurrection rule is the backstop if it ever did not.
    const deletion = deleteCard(root, card.id);
    release();

    expect((await lateSave).ok).toBe(true);
    expect(await deletion).toBe(true);
    await expect(loadCard(root, card.id)).rejects.toThrow();
    expect(existsSync(join(root, "cards", card.id))).toBe(false);
  });

  it("makes a stale authorized Delete retry instead of deleting a changed card", async () => {
    const root = tmp();
    const card = await createCard(root, { title: "manual", list: "backlog" });
    const changed = await saveCardCAS(root, { ...card, list: "plan" }, card.rev ?? 0);
    expect(changed.ok).toBe(true);

    expect(await deleteCard(root, card.id, card.rev ?? 0)).toBe(false);
    expect((await loadCard(root, card.id)).list).toBe("plan");
  });
});
