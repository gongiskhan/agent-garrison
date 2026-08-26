// A MOVE NEVER DISPATCHES.
//
// This file is what is left of the dispatch suite after the Conversations cut.
// Everything it used to cover — shouldAutoDispatch, processChain, the batched
// Watch stream, gatewayRunFn's transport classification, parseNextList's badge
// tolerance — went with the duty-list engine. One invariant outlived all of it,
// and it is the one worth a test: dropping a card on a column is a statement
// about WHERE THE CARD IS, never an instruction to spend money on a model turn.
//
// It matters more now than it did before, not less. The board is drag-and-drop,
// the Running column is a real column, and the reflex a user brings from every
// other kanban is "drag it to start it". If a PATCH could dispatch, a stray drag
// (or a UI that re-sends a list on an unrelated edit) would silently open a
// runtime turn. Work starts through exactly one door: POST /cards/:id/start →
// the gateway's conversation launcher.
import { describe, it, expect, beforeAll, afterAll } from "vitest";
import http from "node:http";
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import path from "node:path";

process.env.GARRISON_POLICY_PATH = "/nonexistent/garrison-policy.json";
process.env.GARRISON_RUNS_DIR = mkdtempSync(path.join(tmpdir(), "kanban-dispatch-runs-"));

// @ts-expect-error — plain ESM .mjs sibling, no .d.ts
import { makeRequestHandler, isEngineRequest, requestsAutoDispatch } from "../fittings/seed/kanban-loop/scripts/server.mjs";
// @ts-expect-error — plain ESM .mjs sibling
import { seedBoard } from "../fittings/seed/kanban-loop/scripts/kanban.mjs";
// @ts-expect-error — plain ESM .mjs sibling
import { saveBoard, loadCard } from "../fittings/seed/kanban-loop/lib/board.mjs";

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


let gateway: http.Server;
let gatewayHits: string[] = [];
let server: http.Server;
let base = "";
let root = "";

const j = (r: Response) => r.json() as Promise<any>;

async function listen(s: http.Server): Promise<number> {
  await new Promise<void>((resolve) => s.listen(0, "127.0.0.1", resolve));
  return (s.address() as { port: number }).port;
}

beforeAll(async () => {
  root = mkdtempSync(path.join(tmpdir(), "kanban-dispatch-root-"));
  await saveBoard(seedBoard(), root);
  // A gateway that answers EVERYTHING, and records every request it is asked
  // for. The point of the fixture is that a move leaves it untouched: a stub
  // that refused would let a real dispatch pass as a harmless error.
  gateway = http.createServer((req, res) => {
    gatewayHits.push(`${req.method} ${req.url}`);
    if (req.method === "POST" && String(req.url).startsWith("/conversation/")) {
      res.writeHead(202, { "content-type": "application/json" });
      return res.end(JSON.stringify({ ok: true }));
    }
    if (req.method === "POST") {
      res.writeHead(200, { "content-type": "text/event-stream" });
      res.write(`event: done\ndata: ${JSON.stringify({ reply: "done" })}\n\n`);
      return res.end();
    }
    res.writeHead(200);
    res.end("ok");
  });
  const gatewayUrl = `http://127.0.0.1:${await listen(gateway)}`;
  server = http.createServer(makeRequestHandler({ root, cwd: root, gatewayUrl, cap: 10 }, root));
  base = `http://127.0.0.1:${await listen(server)}`;
});

afterAll(async () => {
  await new Promise<void>((resolve) => server.close(() => resolve()));
  await new Promise<void>((resolve) => gateway.close(() => resolve()));
  rmSync(root, { recursive: true, force: true });
});

async function newCard(title: string, extra: Record<string, unknown> = {}) {
  const r = await fetch(`${base}/cards`, {
    method: "POST",
    headers: { "content-type": "application/json" },
    body: JSON.stringify({ title, description: "d", project: "demo", ...extra })
  });
  expect(r.status).toBe(201);
  return (await j(r)).card;
}

// Every list a human can drop a card on. `running` is excluded deliberately —
// it is not a move target (you cannot start a stretch by dragging) and the
// board refuses it; `scheduled` is owned by the Schedule controls. What is left
// is the full set of drops a user can actually perform, and none of them may
// reach the gateway.
const HUMAN_MOVE_TARGETS = ["done", "needs-attention", "todo"];

describe("a move never dispatches", () => {
  it("no human move onto any column reaches the gateway or flips the card to running", async () => {
    for (const target of HUMAN_MOVE_TARGETS) {
      const card = await newCard(`move to ${target}`);
      gatewayHits = [];
      const moved = await fetch(`${base}/cards/${card.id}`, {
        method: "PATCH",
        headers: { "content-type": "application/json" },
        body: JSON.stringify({ list: target, rev: card.rev })
      });
      expect(moved.status, `move to ${target}`).toBe(200);
      expect(gatewayHits, `move to ${target} talked to the gateway`).toEqual([]);
      const after = await loadCard(root, card.id);
      expect(after.list).toBe(target);
      // No run was opened: no running status, no minted run identity.
      expect(after.status).not.toBe("running");
      expect(after.runId ?? null).toBeNull();
    }
  });

  it("an ENGINE move does not dispatch either — the header is a privilege, not a trigger", async () => {
    const card = await newCard("engine move");
    gatewayHits = [];
    const moved = await fetch(`${base}/cards/${card.id}`, {
      method: "PATCH",
      headers: { "content-type": "application/json", "x-garrison-engine": "gateway", "x-garrison-dispatch": "auto" },
      body: JSON.stringify({ list: "done", rev: card.rev })
    });
    expect(moved.status).toBe(200);
    // `x-garrison-dispatch: auto` used to hand progression to the board. There
    // is no board-driven progression left to hand it, so it is inert.
    expect(gatewayHits).toEqual([]);
    expect((await loadCard(root, card.id)).status).not.toBe("running");
  });

  // KNOWN FAILING — a real defect in server.mjs, reported rather than papered
  // over. handlePatchCard validates only that the target list EXISTS; it never
  // consults the source list's validNext and has no `running` guard, so a plain
  // human PATCH (the drag the board's own UI performs) lands a card on Running.
  // coherentCardState then stamps status:"running" at the write choke point, and
  // the result is a card the board reports as RUNNING with no conversation, no
  // gateway turn and nothing that will ever finish it. The CREATE door already
  // refuses exactly this (`targetList === "running"` requires the engine header,
  // server.mjs ~1757); the MOVE door needs the same refusal.
  it("a human cannot MOVE a card into Running — that door is the launcher's", async () => {
    const card = await newCard("drag to running");
    gatewayHits = [];
    const moved = await fetch(`${base}/cards/${card.id}`, {
      method: "PATCH",
      headers: { "content-type": "application/json" },
      body: JSON.stringify({ list: "running", rev: card.rev })
    });
    // No model turn was opened either way — the dispatch invariant itself holds.
    expect(gatewayHits).toEqual([]);
    // …but the move is accepted, and that is the bug: Running is a state the
    // launcher owns, and a drag must not be able to claim it.
    expect(moved.status).toBe(400);
    const after = await loadCard(root, card.id);
    expect(after.list).toBe("todo");
    expect(after.status).not.toBe("running");
  });

  it("Start IS the door: POST /cards/:id/start kicks the conversation launcher", async () => {
    const card = await newCard("start me");
    gatewayHits = [];
    const started = await fetch(`${base}/cards/${card.id}/start`, { method: "POST" });
    expect(started.status).toBe(200);
    expect((await j(started)).started).toBe(true);
    // The contrast with every case above: this one, and only this one, talks to
    // the gateway — and it talks to the conversation launcher, not a chat turn.
    expect(gatewayHits.filter((h) => h.startsWith("POST"))).toEqual(["POST /conversation/kick"]);
  });
});

// The two header predicates survive the cut (the engine header still marks a
// privileged mutation). What died is the composed guard they used to feed:
// shouldAutoDispatch is gone from server.mjs, so there is no dispatch decision
// left for a header to influence.
describe("engine-context headers (the predicates, minus the dispatch decision)", () => {
  it("isEngineRequest detects a non-empty x-garrison-engine header", () => {
    expect(isEngineRequest({ headers: { "x-garrison-engine": "garrison-doorway" } })).toBe(true);
    expect(isEngineRequest({ headers: {} })).toBe(false);
    expect(isEngineRequest({ headers: { "x-garrison-engine": "" } })).toBe(false);
  });

  it("requestsAutoDispatch reads the intent header without granting it anything", () => {
    expect(requestsAutoDispatch({ headers: { "x-garrison-dispatch": "auto" } })).toBe(true);
    expect(requestsAutoDispatch({ headers: {} })).toBe(false);
  });

  it("shouldAutoDispatch is gone from the server module", async () => {
    // @ts-expect-error — plain ESM .mjs sibling, no .d.ts
    const mod = await import("../fittings/seed/kanban-loop/scripts/server.mjs");
    expect("shouldAutoDispatch" in mod).toBe(false);
  });
});
