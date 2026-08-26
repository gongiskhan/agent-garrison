// Panic — the ONE stop verb, after the Conversations cut.
//
// The engine-side half of this file (processCard / processBatch refusing to let
// a partial verdict from an interrupted turn advance a card) went out with the
// duty-list engine: there are no verdicts and no batch turns anymore. What
// survives is the endpoint: POST /cards/:id/panic sends an exact card-bound
// interrupt through interruptCardTurn and NEVER writes the card itself, and the
// remote-claim branch still fails closed on an unacknowledged stop.
import { afterEach, describe, expect, it, beforeAll, afterAll, beforeEach } from "vitest";
import http from "node:http";
import { existsSync, mkdtempSync, mkdirSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import path from "node:path";

// @ts-ignore fitting modules are plain ESM
import { loadCard, saveBoard } from "../fittings/seed/kanban-loop/lib/board.mjs";
// @ts-ignore fitting modules are plain ESM
import { seedBoard } from "../fittings/seed/kanban-loop/scripts/kanban.mjs";
// @ts-ignore fitting modules are plain ESM
import { makeRequestHandler } from "../fittings/seed/kanban-loop/scripts/server.mjs";

// The card store is the STATE SERVICE now, not files under GARRISON_KANBAN_DIR.
// Boot one for this file and project its discovery env before anything reads a
// card; side files still live under the kanban root this file already pins.
import { setupKanbanState, seedCard } from "./kanban-state-env";
let __kanbanState: Awaited<ReturnType<typeof setupKanbanState>>;
beforeAll(async () => {
  __kanbanState = await setupKanbanState();
}, 30_000);
afterAll(async () => {
  await __kanbanState?.stop();
});
// Fixed-ULID fixtures are reused across tests in this file; a per-test wipe gives
// each one the fresh board its own tmp root used to give it.
beforeEach(async () => {
  await __kanbanState?.reset();
});


const roots: string[] = [];

function tempRoot() {
  const root = mkdtempSync(path.join(tmpdir(), "kanban-panic-"));
  roots.push(root);
  return root;
}

// The real five-state board — no hand-rolled duty columns to drift from it.
function board() {
  return seedBoard();
}

async function putCard(root: string, id: string, overrides: Record<string, unknown> = {}) {
  const runDir = path.join(root, "runs", id);
  mkdirSync(path.join(root, "cards", id), { recursive: true });
  mkdirSync(runDir, { recursive: true });
  const card = {
    id,
    title: `panic ${id.slice(0, 4)}`,
    description: "stop safely",
    project: "demo",
    // Conversations: `list` IS the state and `status` mirrors it at the write
    // choke point, so a running fixture must sit on the `running` list or the
    // first CAS write coerces it back to "ok".
    list: "todo",
    status: "ok",
    iterations: 0,
    rev: 0,
    runId: `run-${id}`,
    runDir,
    runSeq: 0,
    logIndex: 0,
    sessionIds: [],
    events: [],
    goalMode: false,
    ...overrides
  };
  // The store assigns the revision (a create always lands at 0), so hand back
  // what it actually holds rather than the fixture's wish.
  const stored = await seedCard(card);
  return { ...card, rev: stored.rev, position: stored.position };
}

async function listen(server: http.Server) {
  await new Promise<void>((resolve) => server.listen(0, "127.0.0.1", resolve));
  return (server.address() as { port: number }).port;
}

async function close(server: http.Server) {
  await new Promise<void>((resolve) => server.close(() => resolve()));
}

afterEach(() => {
  for (const root of roots.splice(0)) rmSync(root, { recursive: true, force: true });
});

describe("POST /cards/:id/panic", () => {
  // Seeds a card holding a live remote claim plus one piece of partial evidence.
  async function remoteClaimCard(root: string, id: string) {
    const evidence = path.join(root, "cards", id, "dispatch", "partial.txt");
    mkdirSync(path.dirname(evidence), { recursive: true });
    writeFileSync(evidence, "partial remote proof\n");
    await putCard(root, id, {
      list: "running",
      status: "running",
      placement: { target: "studio" },
      dispatch: {
        machine: "studio",
        workerId: "worker-one",
        runId: "remote-run",
        routingToken: "route-one",
        phase: "implement",
        logIndex: 1,
        claimRevision: 1,
        claimedAt: new Date().toISOString(),
        heartbeatAt: new Date().toISOString(),
        state: "running"
      }
    });
    return evidence;
  }

  it("releases a remote claim once the worker acknowledges, preserving placement and partial evidence", async () => {
    const root = tempRoot();
    await saveBoard(board(), root);
    const id = "R".repeat(26);
    const evidence = await remoteClaimCard(root, id);
    const server = http.createServer(makeRequestHandler({ root, cwd: root, gatewayUrl: null, cap: 10 }, root));
    const base = `http://127.0.0.1:${await listen(server)}`;
    try {
      const panic = fetch(`${base}/cards/${id}/panic`, { method: "POST" });

      // Stand in for the Outpost worker: wait for Panic to publish the
      // `cancelling` request, then acknowledge that the process group stopped.
      // The ack carries the claim identity AND the current rev, so this also
      // exercises the ownership + CAS gates on the acknowledgement route.
      let acked: Response | null = null;
      for (let attempt = 0; attempt < 100 && !acked; attempt += 1) {
        await new Promise((resolve) => setTimeout(resolve, 50));
        const card = await loadCard(root, id);
        if (card.dispatch?.cancellation?.state !== "requested") continue;
        acked = await fetch(`${base}/cards/${id}/dispatch-cancel`, {
          method: "POST",
          headers: { "content-type": "application/json", "x-garrison-engine": "worker" },
          body: JSON.stringify({
            machine: "studio",
            workerId: "worker-one",
            runId: "remote-run",
            routingToken: "route-one",
            stopped: true,
            rev: card.rev ?? 0,
            summary: "remote process group stopped"
          })
        });
      }
      expect(acked?.status).toBe(200);

      const response = await panic;
      expect(response.status).toBe(200);
      expect(await response.json()).toMatchObject({
        ok: true,
        stopped: true,
        acknowledged: true,
        remote: true
      });
      expect(await loadCard(root, id)).toMatchObject({
        list: "needs-attention",
        status: "needs-attention",
        parkedFrom: "implement",
        placement: { target: "studio" },
        dispatch: { machine: "studio", state: "failed", cancellation: { state: "acknowledged" } }
      });
      expect(existsSync(evidence)).toBe(true);
    } finally {
      await close(server);
    }
  });

  // The lease is the only thing stopping a second machine picking this card up
  // while the first may still be executing it, so an unacknowledged stop must
  // NOT release it. Fail closed: report pending and keep the claim locked.
  it("keeps the lease and placement locked when the worker never acknowledges", async () => {
    const root = tempRoot();
    await saveBoard(board(), root);
    const id = "S".repeat(26);
    const evidence = await remoteClaimCard(root, id);
    const server = http.createServer(
      makeRequestHandler({ root, cwd: root, gatewayUrl: null, cap: 10, remoteCancelWaitMs: 400 }, root)
    );
    const base = `http://127.0.0.1:${await listen(server)}`;
    try {
      const response = await fetch(`${base}/cards/${id}/panic`, { method: "POST" });
      expect(response.status).toBe(504);
      expect(await response.json()).toMatchObject({
        ok: false,
        stopped: false,
        acknowledged: false,
        released: false,
        pending: true,
        remote: true,
        code: "remote-cancel-timeout"
      });
      const card = await loadCard(root, id);
      expect(card).toMatchObject({
        status: "running",
        placement: { target: "studio" },
        dispatch: {
          machine: "studio",
          runId: "remote-run",
          state: "cancelling",
          cancellation: { state: "timeout" }
        }
      });
      expect(card.dispatch.releasedAt).toBeUndefined();
      expect(existsSync(evidence)).toBe(true);
    } finally {
      await close(server);
    }
  });

  it("sends an exact card-bound interrupt and leaves the running CAS to the engine", async () => {
    const root = tempRoot();
    const b = board();
    await saveBoard(b, root);
    const card = await putCard(root, "D".repeat(26), { list: "running", status: "running", runSeq: 3, rev: 7 });
    let interruptBody: any = null;
    const gateway = http.createServer((req, res) => {
      if (req.url === "/chat/interrupt" && req.method === "POST") {
        let raw = "";
        req.setEncoding("utf8");
        req.on("data", (chunk) => { raw += chunk; });
        req.on("end", () => {
          interruptBody = JSON.parse(raw);
          res.writeHead(200, { "content-type": "application/json" });
          res.end(JSON.stringify({ ok: true, lane: "agent-sdk", stopped: true, cardIds: [card.id] }));
        });
        return;
      }
      res.writeHead(404).end();
    });
    const gatewayUrl = `http://127.0.0.1:${await listen(gateway)}`;
    const server = http.createServer(makeRequestHandler({ root, cwd: root, gatewayUrl, cap: 10 }, root));
    const base = `http://127.0.0.1:${await listen(server)}`;

    try {
      const response = await fetch(`${base}/cards/${card.id}/panic`, { method: "POST" });
      expect(response.status).toBe(200);
      expect(await response.json()).toMatchObject({
        ok: true,
        stopped: true,
        affectedCardIds: [card.id],
        sharedBatch: false
      });
      expect(interruptBody).toEqual({ cardId: card.id });
      // A separate endpoint write would bump rev and race the launcher's terminal
      // write. Panic only signals; the owning turn parks the card.
      expect(await loadCard(root, card.id)).toMatchObject({ status: "running", list: "running", rev: card.rev, runSeq: 3 });
    } finally {
      await close(server);
      await close(gateway);
    }
  });
});
