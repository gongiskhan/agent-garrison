// GARRISON-FLOW-V2 S7 (D19) — the board persists quick cards and never locks
// them. A quick card (the gateway's trivial-plan inline task) carries quick:true,
// is projected by cardSummary, and is EXEMPT from the D16 engine-owned lock even
// while it transiently sits on an agent list (Implement) — the operator can move
// it. A normal card on the same list stays locked. These tests boot the real
// board request handler against a sandboxed root.
import { describe, it, expect, beforeAll, afterAll } from "vitest";
import http from "node:http";
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import path from "node:path";

// Policy-less + sandboxed runs home, set before importing the server module.
process.env.GARRISON_POLICY_PATH = "/nonexistent/garrison-policy.json";
process.env.GARRISON_RUNS_DIR = mkdtempSync(path.join(tmpdir(), "runs-home-"));

// @ts-expect-error — plain ESM .mjs sibling, no .d.ts
import { makeRequestHandler, cardSummary, isEngineOwned } from "../fittings/seed/kanban-loop/scripts/server.mjs";
// @ts-expect-error — plain ESM .mjs sibling
import { seedBoard } from "../fittings/seed/kanban-loop/scripts/kanban.mjs";
// @ts-expect-error — plain ESM .mjs sibling
import { saveBoard } from "../fittings/seed/kanban-loop/lib/board.mjs";

let server: http.Server;
let base: string;
let root: string;

beforeAll(async () => {
  root = mkdtempSync(path.join(tmpdir(), "kanban-quick-root-"));
  await saveBoard(seedBoard(), root);
  const opts = { root, cwd: root, cap: 5, gatewayUrl: "http://127.0.0.1:1", host: "127.0.0.1", port: 0 };
  server = http.createServer(makeRequestHandler(opts, root));
  await new Promise<void>((r) => server.listen(0, "127.0.0.1", () => r()));
  const addr = server.address() as { port: number };
  base = `http://127.0.0.1:${addr.port}`;
});
afterAll(() => {
  server?.close();
  rmSync(root, { recursive: true, force: true });
});

const j = (r: Response) => r.json() as Promise<any>;

describe("cardSummary + isEngineOwned — the quick projection + lock exemption (unit)", () => {
  it("cardSummary projects quick honestly", () => {
    expect(cardSummary({ id: "x", list: "done", quick: true }).quick).toBe(true);
    expect(cardSummary({ id: "x", list: "done" }).quick).toBe(false);
  });
  it("a quick card is never engine-owned, even on an agent list; a normal one is", () => {
    const board = seedBoard();
    expect(isEngineOwned(board, { list: "implement", quick: true })).toBe(false);
    expect(isEngineOwned(board, { list: "implement" })).toBe(true);
    expect(isEngineOwned(board, { list: "done" })).toBe(false); // done is a manual list
  });
});

describe("POST /cards {quick} — the board persists quick:true", () => {
  it("stores and projects quick on the created card", async () => {
    const r = await fetch(`${base}/cards`, {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify({ title: "rename a var", description: "trivial", project: "demo", quick: true }),
    });
    expect(r.status).toBe(201);
    const { card } = await j(r);
    expect(card.quick).toBe(true);
    const got = await j(await fetch(`${base}/cards/${card.id}`));
    expect(got.card.quick).toBe(true);
  });
});

describe("quick cards stay operator-editable on an agent list (D19 lock exemption)", () => {
  it("a manual move of a quick card sitting in Implement is NOT rejected", async () => {
    // create the quick card, move it to Implement with the engine header (as the
    // gateway does), then move it manually — the D16 lock must NOT fire.
    const created = await j(
      await fetch(`${base}/cards`, {
        method: "POST",
        headers: { "content-type": "application/json" },
        body: JSON.stringify({ title: "quick q", description: "q", project: "demo", quick: true }),
      })
    );
    const id = created.card.id;
    const toImpl = await fetch(`${base}/cards/${id}`, {
      method: "PATCH",
      headers: { "content-type": "application/json", "x-garrison-engine": "gateway" },
      body: JSON.stringify({ list: "implement", rev: created.card.rev }),
    });
    expect(toImpl.status).toBe(200);
    const afterImpl = await j(toImpl);
    // manual move (no engine header) → allowed because the card is quick
    const manual = await fetch(`${base}/cards/${id}`, {
      method: "PATCH",
      headers: { "content-type": "application/json" },
      body: JSON.stringify({ list: "done", rev: afterImpl.card.rev }),
    });
    expect(manual.status).toBe(200);
    expect((await j(manual)).card.list).toBe("done");
  });

  it("a NORMAL card on Implement stays engine-owned (manual move → 403)", async () => {
    const created = await j(
      await fetch(`${base}/cards`, {
        method: "POST",
        headers: { "content-type": "application/json" },
        body: JSON.stringify({ title: "normal", description: "n", project: "demo" }),
      })
    );
    const id = created.card.id;
    const afterImpl = await j(
      await fetch(`${base}/cards/${id}`, {
        method: "PATCH",
        headers: { "content-type": "application/json", "x-garrison-engine": "gateway" },
        body: JSON.stringify({ list: "implement", rev: created.card.rev }),
      })
    );
    const manual = await fetch(`${base}/cards/${id}`, {
      method: "PATCH",
      headers: { "content-type": "application/json" },
      body: JSON.stringify({ list: "done", rev: afterImpl.card.rev }),
    });
    expect(manual.status).toBe(403);
    expect((await j(manual)).error).toBe("engine-owned");
  });

  it("an engine Done move persists the quick turn's actual route and effort evidence", async () => {
    const created = await j(
      await fetch(`${base}/cards`, {
        method: "POST",
        headers: { "content-type": "application/json" },
        body: JSON.stringify({ title: "quick routed", project: "demo", quick: true })
      })
    );
    const id = created.card.id;
    const afterImpl = await j(
      await fetch(`${base}/cards/${id}`, {
        method: "PATCH",
        headers: { "content-type": "application/json", "x-garrison-engine": "gateway" },
        body: JSON.stringify({ list: "implement", rev: created.card.rev })
      })
    );
    const completed = await fetch(`${base}/cards/${id}`, {
      method: "PATCH",
      headers: { "content-type": "application/json", "x-garrison-engine": "gateway" },
      body: JSON.stringify({
        list: "done",
        rev: afterImpl.card.rev,
        routeEvidence: {
          targetId: "sdk-haiku",
          runtime: "agent-sdk",
          provider: "anthropic",
          model: "claude-haiku-4-5",
          effort: "low",
          effortApplied: true,
          tier: "T0-trivial",
          phase: "implement",
          reply: "Changed the bounded file."
        }
      })
    });
    expect(completed.status).toBe(200);

    const detail = await j(await fetch(`${base}/cards/${id}`));
    const routed = detail.events.find((event: any) => event.kind === "routed");
    expect(routed).toMatchObject({
      detail: "Changed the bounded file.",
      route: {
        targetId: "sdk-haiku",
        runtime: "agent-sdk",
        model: "claude-haiku-4-5",
        effort: "low",
        effortApplied: true,
        phase: "implement"
      }
    });
    expect(routed.message).toContain("agent-sdk/claude-haiku-4-5 (T0-trivial)");
  });
});
