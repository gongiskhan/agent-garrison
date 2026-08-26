// Card PLACEMENT — where a card is meant to run.
//
// The Conversations cut deleted the local dispatch engine (processCard /
// processBatch), so the guard this file was originally written for — "the local
// engine must never run a card placed on another machine" — no longer has a
// subject: there is no local engine run to guard. What survives is the DATA half
// that the mesh claim route still reads (src/app/api/dispatch/claim/route.ts
// selects on card.placement): normalisePlacement's host default, its trimming,
// and its one-way migration of the legacy `outpost` affinity onto placement at
// the createCard door. Those are the contracts kept below; the engine-guard
// tests went with the engine.

import { describe, it, expect, beforeAll, afterAll } from "vitest";

process.env.GARRISON_POLICY_PATH = "/nonexistent/garrison-policy.json";
import { mkdtempSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
process.env.GARRISON_RUNS_DIR = mkdtempSync(join(tmpdir(), "runs-home-placement-"));

// @ts-ignore — pure .mjs
import { createCard, normalisePlacement } from "../fittings/seed/kanban-loop/lib/board.mjs";

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


const tmp = () => mkdtempSync(join(tmpdir(), "kanban-placement-"));

describe("normalisePlacement", () => {
  it("defaults to host for absent/malformed input", () => {
    expect(normalisePlacement(undefined)).toEqual({ target: "host" });
    expect(normalisePlacement(null)).toEqual({ target: "host" });
    expect(normalisePlacement({})).toEqual({ target: "host" });
    expect(normalisePlacement({ target: "   " })).toEqual({ target: "host" });
  });

  it("keeps a named machine and not_before", () => {
    expect(normalisePlacement({ target: " mac-mini ", not_before: " 2026-01-01T00:00:00Z " })).toEqual({
      target: "mac-mini",
      not_before: "2026-01-01T00:00:00Z"
    });
  });

  it("migrates the legacy outpost affinity, and an explicit placement still wins", () => {
    expect(normalisePlacement(null, "goncalos-mac-mini-1")).toEqual({ target: "goncalos-mac-mini-1" });
    expect(normalisePlacement({ target: "host" }, "goncalos-mac-mini-1")).toEqual({ target: "goncalos-mac-mini-1" });
    expect(normalisePlacement({ target: "studio" }, "goncalos-mac-mini-1")).toEqual({ target: "studio" });
  });
});

describe("createCard placement door", () => {
  it("a card with no placement is host-placed", async () => {
    const card = await createCard(tmp(), { title: "local work", list: "todo" });
    expect(card.placement).toEqual({ target: "host" });
    expect(card.outpost ?? null).toBeNull();
  });

  it("migrates legacy outpost input onto placement and drops the field", async () => {
    const card = await createCard(tmp(), { title: "pinned work", list: "todo", outpost: "goncalos-mac-mini-1" });
    expect(card.outpost).toBeNull();
    expect(card.placement.target).toBe("goncalos-mac-mini-1");
  });

  it("keeps an explicit machine placement", async () => {
    const card = await createCard(tmp(), { title: "remote work", list: "todo", placement: { target: "goncalos-mac-mini-1" } });
    expect(card.placement).toEqual({ target: "goncalos-mac-mini-1" });
  });
});
