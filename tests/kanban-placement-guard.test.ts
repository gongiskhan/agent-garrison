// Outpost Dispatch: the local engine must NEVER run a card placed on another
// machine.
//
// This is the exact bug the OLDER `card.outpost` affinity has, which Phase 0
// found and this guard exists not to repeat: engine.mjs resolves the outpost and
// then, on success, FALLS THROUGH to the local dispatch path — so a card pinned
// to a connected Mac silently ran on the host while the board claimed otherwise.
//
// The guard also has to sit BEFORE mintRunFields and the CAS acquire, or every
// local tick (default every 2 minutes) would burn an iteration of the card's
// convergence cap and mint a runDir on the wrong machine while the card just
// sits there waiting to be claimed.

import { describe, it, expect } from "vitest";

process.env.GARRISON_POLICY_PATH = "/nonexistent/garrison-policy.json";
import { mkdtempSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
process.env.GARRISON_RUNS_DIR = mkdtempSync(join(tmpdir(), "runs-home-placement-"));

// @ts-ignore — pure .mjs
import { seedBoard } from "../fittings/seed/kanban-loop/scripts/kanban.mjs";
// @ts-ignore — pure .mjs
import { createCard, loadCard, normalisePlacement } from "../fittings/seed/kanban-loop/lib/board.mjs";
// @ts-ignore — pure .mjs
import { processCard } from "../fittings/seed/kanban-loop/lib/engine.mjs";

const board = seedBoard();
const tmp = () => mkdtempSync(join(tmpdir(), "kanban-placement-"));

// A runFn that must never be reached. Returning a plausible value instead of
// throwing would let the guard fail silently and the test still pass.
const forbiddenRunFn = async () => {
  throw new Error("LOCAL RUN ATTEMPTED for a remotely-placed card");
};

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
});

describe("engine placement guard", () => {
  it("refuses to run a card placed on another machine", async () => {
    const root = tmp();
    const card = await createCard(root, {
      title: "remote work",
      list: "implement",
      placement: { target: "goncalos-mac-mini-1" }
    });

    const { card: after, outcome } = await processCard({
      root,
      board,
      card,
      runFn: forbiddenRunFn,
      cwd: root
    });

    expect(outcome.status).toBe("skipped");
    expect(outcome.reason).toContain("goncalos-mac-mini-1");
    // Untouched: same list, no run minted, no iteration consumed. A local tick
    // every 2 minutes must cost the card nothing.
    expect(after.list).toBe("implement");
    expect(after.runId ?? null).toBeNull();
    expect(after.runDir ?? null).toBeNull();
    expect(after.iterations).toBe(0);
    expect(after.status).not.toBe("needs-attention");
  });

  it("reports the holder when the card is already claimed", async () => {
    const root = tmp();
    const created = await createCard(root, {
      title: "claimed work",
      list: "implement",
      placement: { target: "goncalos-mac-mini-1" }
    });
    const card = {
      ...created,
      dispatch: {
        machine: "goncalos-mac-mini-1",
        workerId: "w1",
        claimedAt: new Date().toISOString(),
        heartbeatAt: new Date().toISOString(),
        state: "running"
      }
    };

    const { outcome } = await processCard({ root, board, card, runFn: forbiddenRunFn, cwd: root });
    expect(outcome.status).toBe("skipped");
    expect(outcome.reason).toContain("claimed by goncalos-mac-mini-1");
  });

  it("still runs a host-placed card locally", async () => {
    // The guard must not break the default. Every pre-existing card has no
    // placement at all, so this is the path virtually all cards take.
    const root = tmp();
    const card = await createCard(root, { title: "local work", list: "implement" });
    expect(card.placement).toEqual({ target: "host" });

    let ran = false;
    const runFn = async () => {
      ran = true;
      return { reply: "implement\n" };
    };
    await processCard({ root, board, card, runFn, cwd: root });
    expect(ran).toBe(true);
  });

  it("a card with NO placement field at all is treated as host", async () => {
    // Cards written before this feature have no `placement` key. They must keep
    // running locally, not become undispatchable.
    const root = tmp();
    const created = await createCard(root, { title: "legacy card", list: "implement" });
    const legacy = { ...created };
    delete (legacy as Record<string, unknown>).placement;

    let ran = false;
    const runFn = async () => {
      ran = true;
      return { reply: "implement\n" };
    };
    await processCard({ root, board, card: legacy, runFn, cwd: root });
    expect(ran).toBe(true);
  });
});
