import { afterEach, describe, expect, it } from "vitest";
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

const roots: string[] = [];

function board() {
  return {
    version: 3,
    lists: [
      { id: "test", title: "Test", order: 0, kind: "agent", trigger: "scheduler-beat", phase: "test", validNext: ["done"] },
      { id: "done", title: "Done", order: 1, kind: "manual", trigger: "manual", terminal: true, validNext: [] },
      { id: "needs-attention", title: "Needs attention", order: 2, kind: "manual", trigger: "manual", validNext: ["test"] }
    ]
  };
}

async function serverFor(root: string) {
  const server = http.createServer(makeRequestHandler({ root, cwd: root, gatewayUrl: null, cap: 10 }, root));
  await new Promise<void>((resolve) => server.listen(0, "127.0.0.1", resolve));
  return { server, base: `http://127.0.0.1:${(server.address() as { port: number }).port}` };
}

afterEach(() => {
  for (const root of roots.splice(0)) rmSync(root, { recursive: true, force: true });
});

async function claimedFinalCard(root: string) {
  await saveBoard(board(), root);
  const created = await createCard(root, {
    title: "remote final gate",
    project: "fixture",
    list: "test",
    sequence: ["test", "done"],
    placement: { target: "studio" }
  });
  const nextRev = created.rev + 1;
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
      claimRevision: nextRev
    }
  }, created.rev);
  if (!saved.ok) throw new Error("failed to seed claim");
  return saved.card;
}

describe("remote terminal phase progression", () => {
  it("reaches Done through the normal transition only when tangible evidence is in runDir/evidence", async () => {
    const root = mkdtempSync(path.join(tmpdir(), "kanban-remote-complete-"));
    roots.push(root);
    const card = await claimedFinalCard(root);
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
        body: JSON.stringify({
          rev: card.rev,
          runId: "run-one",
          routingToken: "route-one",
          phase: "test",
          verdict: "done",
          summary: "fixture passed",
          evidenceManifest: []
        })
      });
      expect(response.status).toBe(200);
      expect(await response.json()).toMatchObject({ ok: true, advanced: "done" });
      expect(await loadCard(root, card.id)).toMatchObject({ list: "done", status: "ok" });
    } finally {
      await new Promise<void>((resolve) => server.close(() => resolve()));
    }
  });
});
