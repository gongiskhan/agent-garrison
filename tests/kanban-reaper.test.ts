import { describe, it, expect } from "vitest";
import { mkdtempSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
// @ts-ignore — pure .mjs
import { createCard, saveCardCAS, loadCard } from "../fittings/seed/kanban-loop/lib/board.mjs";
// @ts-ignore — pure .mjs
import { reapOrphanedRuns, ORPHAN_RUNNING_MS } from "../fittings/seed/kanban-loop/lib/engine.mjs";

const tmp = () => mkdtempSync(join(tmpdir(), "kanban-reap-"));

async function makeRunning(root: string, runningSince: string | null) {
  const card = await createCard(root, { title: "t", list: "implement" });
  const res = await saveCardCAS(root, { ...card, status: "running", runningSince }, card.rev ?? 0);
  return res.card;
}

describe("reapOrphanedRuns", () => {
  it("parks a card whose run is older than the orphan threshold", async () => {
    const root = tmp();
    const now = Date.parse("2026-07-06T12:00:00Z");
    const stale = new Date(now - ORPHAN_RUNNING_MS - 60_000).toISOString();
    const card = await makeRunning(root, stale);

    const reaped = await reapOrphanedRuns(root, { now });
    expect(reaped).toEqual([card.id]);

    const after = await loadCard(root, card.id);
    expect(after.status).toBe("needs-attention");
    expect(after.list).toBe("needs-attention");
    expect(after.parkedFrom).toBe("implement");
    expect(after.runningSince).toBeNull();
    expect(after.attentionReason).toMatch(/orphaned/i);
  });

  it("parks a running card with a missing runningSince", async () => {
    const root = tmp();
    const card = await makeRunning(root, null);
    const reaped = await reapOrphanedRuns(root, { now: Date.parse("2026-07-06T12:00:00Z") });
    expect(reaped).toEqual([card.id]);
    expect((await loadCard(root, card.id)).status).toBe("needs-attention");
  });

  it("leaves a card whose run is still within a plausible window", async () => {
    const root = tmp();
    const now = Date.parse("2026-07-06T12:00:00Z");
    const recent = new Date(now - 5 * 60_000).toISOString(); // 5 min ago
    const card = await makeRunning(root, recent);
    const reaped = await reapOrphanedRuns(root, { now });
    expect(reaped).toEqual([]);
    expect((await loadCard(root, card.id)).status).toBe("running");
  });

  it("ignores non-running cards", async () => {
    const root = tmp();
    await createCard(root, { title: "idle", list: "todo" });
    const reaped = await reapOrphanedRuns(root, { now: Date.now() });
    expect(reaped).toEqual([]);
  });
});
