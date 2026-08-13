// Unit tests for the Discuss inactivity auto-archive sweep — kanban.mjs.
// A Discuss card is a resumable conversation and the engine never dispatches it, so
// without this sweep a discussion nobody came back to sits on the board forever.
// Covers: a quiet card is archived with a discuss-inactivity event and a bumped rev
// (the CAS path); a fresh one is left alone; a HELD card archives on the same terms
// (a question nobody answered for a week IS inactivity); only Discuss-list cards are
// touched; a live run is skipped; the window is env-configurable and 0 disables it;
// and activity is read from the card's OWN timestamps, never a channel thread file.
// Hermetic: a per-test tmpdir, no gateway, no socket.

import { describe, it, expect } from "vitest";
import { mkdtempSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
// @ts-ignore — pure .mjs
import { seedBoard, sweepIdleDiscussCards, discussIdleWindowMs, lastCardActivityAt } from "../fittings/seed/kanban-loop/scripts/kanban.mjs";
// @ts-ignore — pure .mjs
import { createCard, loadCard, saveCardCAS } from "../fittings/seed/kanban-loop/lib/board.mjs";

const DAY = 24 * 60 * 60 * 1000;
const tmp = () => mkdtempSync(join(tmpdir(), "kanban-discuss-archive-"));
const daysAgo = (n: number) => new Date(Date.now() - n * DAY).toISOString();

describe("kanban discuss — the inactivity window knob", () => {
  it("defaults to 7 days and reads GARRISON_KANBAN_DISCUSS_IDLE_DAYS", () => {
    expect(discussIdleWindowMs({})).toBe(7 * DAY);
    expect(discussIdleWindowMs({ GARRISON_KANBAN_DISCUSS_IDLE_DAYS: "2" })).toBe(2 * DAY);
    expect(discussIdleWindowMs({ GARRISON_KANBAN_DISCUSS_IDLE_DAYS: "0.5" })).toBe(DAY / 2);
  });

  it("an explicit 0 turns the sweep OFF; garbage falls back to the default", () => {
    expect(discussIdleWindowMs({ GARRISON_KANBAN_DISCUSS_IDLE_DAYS: "0" })).toBe(0);
    // A misconfigured value must not silently disable a sweep the operator believes
    // is running — it falls back to the documented default instead.
    expect(discussIdleWindowMs({ GARRISON_KANBAN_DISCUSS_IDLE_DAYS: "soon" })).toBe(7 * DAY);
    expect(discussIdleWindowMs({ GARRISON_KANBAN_DISCUSS_IDLE_DAYS: "-3" })).toBe(7 * DAY);
    expect(discussIdleWindowMs({ GARRISON_KANBAN_DISCUSS_IDLE_DAYS: "  " })).toBe(7 * DAY);
  });
});

describe("kanban discuss — lastCardActivityAt (the card's own freshest stamp)", () => {
  it("takes the newest of created / updated / runningSince / events", () => {
    const recent = daysAgo(1);
    expect(
      lastCardActivityAt({ created: daysAgo(30), updated: daysAgo(30), events: [{ at: daysAgo(20) }, { at: recent }] })
    ).toBe(Date.parse(recent));
    expect(lastCardActivityAt({ created: daysAgo(30), runningSince: recent })).toBe(Date.parse(recent));
  });

  it("is null for a card carrying no parseable timestamp (never archived — unprovable)", () => {
    expect(lastCardActivityAt({})).toBe(null);
    expect(lastCardActivityAt({ created: "whenever", events: [{ at: null }] })).toBe(null);
    expect(lastCardActivityAt(null)).toBe(null);
  });
});

describe("kanban discuss — sweepIdleDiscussCards", () => {
  it("archives a Discuss card nobody has touched past the window, naming the reason", async () => {
    const root = tmp();
    const board = seedBoard();
    const card = await createCard(root, { title: "Quiet conversation", list: "discuss", at: daysAgo(9) });

    expect(await sweepIdleDiscussCards(root, board)).toEqual([card.id]);

    const disk = await loadCard(root, card.id);
    expect(disk.list).toBe("archived");
    expect(disk.status).toBe("ok");
    // CAS discipline: the move went through the same compare-and-swap write path every
    // other tick mutation uses, so the revision advanced by exactly one.
    expect(disk.rev).toBe((card.rev ?? 0) + 1);
    // The card carries WHY it left, in the timeline the user reads.
    const ev = disk.events[disk.events.length - 1];
    expect(ev.kind).toBe("archived");
    expect(ev.message).toContain("discuss-inactivity");
    expect(ev.detail).toContain("GARRISON_KANBAN_DISCUSS_IDLE_DAYS");
    // Nothing is destroyed: the conversation is retrievable by moving it back.
    expect(ev.detail).toContain("move the card back");
    expect(disk.title).toBe("Quiet conversation");
  });

  it("leaves a Discuss card alone while the conversation is still live", async () => {
    const root = tmp();
    const board = seedBoard();
    const card = await createCard(root, { title: "Still talking", list: "discuss", at: daysAgo(2) });
    expect(await sweepIdleDiscussCards(root, board)).toEqual([]);
    expect((await loadCard(root, card.id)).list).toBe("discuss");
  });

  it("a HELD card still archives — a question nobody answered for a week IS inactivity", async () => {
    const root = tmp();
    const board = seedBoard();
    const old = daysAgo(30);
    const card = await createCard(root, { title: "Held on a question", list: "discuss", at: old });
    // saveCardCAS with an explicit `at` sets discussHeld without re-stamping `updated`
    // (which would itself count as activity).
    await saveCardCAS(root, { ...card, discussHeld: true }, card.rev ?? 0, old);

    expect(await sweepIdleDiscussCards(root, board)).toEqual([card.id]);
    const disk = await loadCard(root, card.id);
    expect(disk.list).toBe("archived");
    expect(disk.discussHeld).toBe(true); // the hold record survives the move
  });

  it("a later event un-idles the card, even when created/updated are ancient", async () => {
    const root = tmp();
    const board = seedBoard();
    const old = daysAgo(30);
    const card = await createCard(root, { title: "Answered late", list: "discuss", at: old });
    await saveCardCAS(
      root,
      { ...card, events: [...card.events, { at: daysAgo(1), kind: "generic", message: "reply" }] },
      card.rev ?? 0,
      old
    );
    expect(await sweepIdleDiscussCards(root, board)).toEqual([]);
  });

  it("touches ONLY Discuss-list cards, however old the others are", async () => {
    const root = tmp();
    const board = seedBoard();
    const todo = await createCard(root, { title: "Old todo", list: "todo", at: daysAgo(90) });
    const done = await createCard(root, { title: "Old done", list: "done", at: daysAgo(90) });
    const talk = await createCard(root, { title: "Old discuss", list: "discuss", at: daysAgo(90) });

    expect(await sweepIdleDiscussCards(root, board)).toEqual([talk.id]);
    expect((await loadCard(root, todo.id)).list).toBe("todo");
    expect((await loadCard(root, done.id)).list).toBe("done");
  });

  it("skips a card with a live run (the orphan sweep owns a dead one)", async () => {
    const root = tmp();
    const board = seedBoard();
    const old = daysAgo(30);
    const card = await createCard(root, { title: "Running", list: "discuss", at: old });
    await saveCardCAS(root, { ...card, status: "running" }, card.rev ?? 0, old);
    expect(await sweepIdleDiscussCards(root, board)).toEqual([]);
    expect((await loadCard(root, card.id)).list).toBe("discuss");
  });

  it("honours an explicit window, and archives nothing when the window is 0", async () => {
    const root = tmp();
    const board = seedBoard();
    const card = await createCard(root, { title: "Three days quiet", list: "discuss", at: daysAgo(3) });

    expect(await sweepIdleDiscussCards(root, board, { windowMs: 0 })).toEqual([]);
    expect(await sweepIdleDiscussCards(root, board, { windowMs: 7 * DAY })).toEqual([]);
    expect(await sweepIdleDiscussCards(root, board, { windowMs: 2 * DAY })).toEqual([card.id]);
    expect((await loadCard(root, card.id)).list).toBe("archived");
  });

  it("is idempotent: a second sweep has nothing left to archive", async () => {
    const root = tmp();
    const board = seedBoard();
    const card = await createCard(root, { title: "Quiet", list: "discuss", at: daysAgo(9) });
    expect(await sweepIdleDiscussCards(root, board)).toEqual([card.id]);
    expect(await sweepIdleDiscussCards(root, board)).toEqual([]);
    expect((await loadCard(root, card.id)).rev).toBe((card.rev ?? 0) + 1); // no second write
  });

  it("is a no-op on a board with no Discuss list or no Archived column", async () => {
    const root = tmp();
    await createCard(root, { title: "Quiet", list: "discuss", at: daysAgo(30) });
    const board = seedBoard();
    const noArchive = { ...board, lists: board.lists.filter((l: { id: string }) => l.id !== "archived") };
    const noDiscuss = { ...board, lists: board.lists.filter((l: { id: string }) => l.id !== "discuss") };
    expect(await sweepIdleDiscussCards(root, noArchive)).toEqual([]);
    expect(await sweepIdleDiscussCards(root, noDiscuss)).toEqual([]);
    expect(await sweepIdleDiscussCards(root, null)).toEqual([]);
  });
});
