// The remote dispatch-completion door is RETIRED (Conversations). Outposts are
// gone; work advances through conversation stretches, and the only thing that
// moves a card to Done is the board's own write path with the terminal handoff
// behind it.
//
// This file exists because the door is the dangerous kind of retirement: a
// still-running outpost, a replayed request, or a stale script would otherwise
// hand an unattended POST the power to declare a card Done. The endpoint must
// therefore refuse — with a tombstone status, not a 404 that reads as "wrong
// URL" — and must leave the card exactly as it found it.
import { afterEach, describe, expect, it, beforeAll, afterAll } from "vitest";
import http from "node:http";
import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import path from "node:path";
import { createHash } from "node:crypto";

process.env.GARRISON_POLICY_PATH = "/nonexistent/garrison-policy.json";
// @ts-ignore — fitting modules are plain ESM
import { makeRequestHandler } from "../fittings/seed/kanban-loop/scripts/server.mjs";
// @ts-ignore — fitting modules are plain ESM
import { createCard, loadCard, saveBoard, saveCardCAS } from "../fittings/seed/kanban-loop/lib/board.mjs";
// @ts-ignore — fitting modules are plain ESM
import { buildBoard } from "../fittings/seed/kanban-loop/lib/resolved-model.mjs";

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


const roots: string[] = [];

async function serverFor(root: string) {
  const server = http.createServer(makeRequestHandler({ root, cwd: root, gatewayUrl: null, cap: 10 }, root));
  await new Promise<void>((resolve) => server.listen(0, "127.0.0.1", resolve));
  return { server, base: `http://127.0.0.1:${(server.address() as { port: number }).port}` };
}

afterEach(() => {
  for (const root of roots.splice(0)) rmSync(root, { recursive: true, force: true });
});

// A card in exactly the state a remote worker used to complete: running, on the
// Running list, carrying a live claim it can quote back at the endpoint.
async function claimedRunningCard(root: string) {
  await saveBoard(buildBoard(), root);
  const created = await createCard(root, {
    title: "remote final gate",
    project: "fixture",
    list: "running",
    placement: { target: "studio" }
  });
  const saved = await saveCardCAS(root, {
    ...created,
    status: "running",
    dispatch: {
      machine: "studio",
      workerId: "worker-one",
      runId: "run-one",
      routingToken: "route-one",
      phase: "test",
      state: "running",
      claimedAt: new Date().toISOString(),
      heartbeatAt: new Date().toISOString(),
      logIndex: 1,
      claimRevision: created.rev + 1
    }
  }, created.rev);
  if (!saved.ok) throw new Error("failed to seed claim");
  return saved.card;
}

// The completion payload a worker sent, evidence and all. It was the strongest
// possible request: correct identity, a passing gate record, real evidence.
// Nothing about it may still work.
function completionBody(card: { rev: number }) {
  return {
    rev: card.rev,
    runId: "run-one",
    routingToken: "route-one",
    phase: "test",
    verdict: "done",
    summary: "fixture passed",
    evidenceManifest: []
  };
}

describe("remote dispatch completion is retired (410, and the card never moves)", () => {
  it("refuses an engine-authenticated completion carrying real gate evidence", async () => {
    const root = mkdtempSync(path.join(tmpdir(), "kanban-remote-complete-"));
    roots.push(root);
    const card = await claimedRunningCard(root);
    // Everything the old door demanded before it would advance a card: a fresh
    // per-run gate record naming `done`, plus tangible evidence beside it.
    const runKey = createHash("sha256").update("run-one").digest("hex").slice(0, 32);
    const dispatchDir = path.join(root, "cards", card.id, "dispatch", "runs", runKey);
    mkdirSync(path.join(dispatchDir, "evidence"), { recursive: true });
    writeFileSync(path.join(dispatchDir, "gate-status.test.json"), JSON.stringify({ status: "passed", next_phase: "done" }));
    writeFileSync(path.join(dispatchDir, "evidence", "evidence.md"), "Verified the disposable fixture on the Outpost.\n");
    const { server, base } = await serverFor(root);
    try {
      const response = await fetch(`${base}/cards/${card.id}/dispatch-complete`, {
        method: "POST",
        headers: { "content-type": "application/json", "x-garrison-engine": "outpost-dispatch" },
        body: JSON.stringify(completionBody(card))
      });
      // 410 Gone, not 404: the route still resolves, and the caller is told the
      // capability was withdrawn rather than mistyped.
      expect(response.status).toBe(410);
      expect(await response.json()).toMatchObject({ error: expect.stringContaining("retired") });
      // The card is byte-for-byte what it was: not advanced, not re-listed, not
      // even a rev bump from a partial write.
      expect(await loadCard(root, card.id)).toMatchObject({
        list: "running",
        status: "running",
        rev: card.rev
      });
    } finally {
      await new Promise<void>((resolve) => server.close(() => resolve()));
    }
  });

  it("refuses an unauthenticated completion the same way (no 403/404 side door)", async () => {
    const root = mkdtempSync(path.join(tmpdir(), "kanban-remote-complete-anon-"));
    roots.push(root);
    const card = await claimedRunningCard(root);
    const { server, base } = await serverFor(root);
    try {
      const response = await fetch(`${base}/cards/${card.id}/dispatch-complete`, {
        method: "POST",
        headers: { "content-type": "application/json" },
        body: JSON.stringify(completionBody(card))
      });
      expect(response.status).toBe(410);
      expect(await loadCard(root, card.id)).toMatchObject({ list: "running", rev: card.rev });
    } finally {
      await new Promise<void>((resolve) => server.close(() => resolve()));
    }
  });
});
