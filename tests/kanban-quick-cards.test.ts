// GARRISON-FLOW-V2 S7 (D19) — the board persists quick cards and never locks
// them. A quick card (the gateway's trivial-plan inline task) carries quick:true,
// is projected by cardSummary, and is EXEMPT from the D16 engine-owned lock.
//
// Conversations reshaped the LOCK, not the exemption. The five-state board has
// no `kind: "agent"` list at all (Running is `kind: "system"`, deliberately, so
// no legacy agent-list branch can fire on it), so the D16 lock only has anything
// to bite on where an agent list still exists: a LEGACY board, which is served
// exactly as-is until scripts/migrate-conversations.mjs runs. That is where the
// contrast between a quick card and a normal one is still observable, and it is
// a live case — not a museum piece — for as long as an unmigrated board can be
// loaded. These tests boot the real board request handler against a sandboxed root.
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

// A board as it exists on disk before the Conversations card migration runs:
// duty columns, `kind: "agent"`, the D16 lock live.
const LEGACY_BOARD = {
  version: 9,
  lists: [
    { id: "todo", title: "To do", kind: "manual", trigger: "manual", validNext: ["implement"] },
    { id: "implement", title: "duty: Implement", kind: "agent", phase: "implement", trigger: "immediate", validNext: ["done"] },
    { id: "done", title: "Done", kind: "manual", trigger: "manual", terminal: true, validNext: [] }
  ]
};

describe("cardSummary + isEngineOwned — the quick projection + lock exemption (unit)", () => {
  it("cardSummary projects quick honestly", () => {
    expect(cardSummary({ id: "x", list: "done", quick: true }).quick).toBe(true);
    expect(cardSummary({ id: "x", list: "done" }).quick).toBe(false);
  });
  it("a quick card is never engine-owned, even on an agent list; a normal one is", () => {
    // A legacy (pre-Conversations) board: the only shape that still HAS an
    // engine-owned list to be exempt from.
    expect(isEngineOwned(LEGACY_BOARD, { list: "implement", quick: true })).toBe(false);
    expect(isEngineOwned(LEGACY_BOARD, { list: "implement" })).toBe(true);
    expect(isEngineOwned(LEGACY_BOARD, { list: "done" })).toBe(false); // done is a manual list
  });

  it("the five-state board has no agent list for the lock to bite on", () => {
    // Not an oversight: `kind: "system"` on Running is chosen so that every
    // legacy `kind === "agent"` branch is false for it. A human moving a wedged
    // card OFF Running is a documented rescue exit, not a lock violation.
    const board = seedBoard();
    expect(board.lists.some((l: { kind: string }) => l.kind === "agent")).toBe(false);
    expect(board.lists.find((l: { id: string }) => l.id === "running")?.kind).toBe("system");
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
  // The board layout is ONE shared document (board.layout / global), so the
  // legacy board is swapped in for this block and put back afterwards rather
  // than served by a second handler.
  beforeAll(async () => {
    await saveBoard(LEGACY_BOARD, root);
  });
  afterAll(async () => {
    await saveBoard(seedBoard(), root);
  });

  it("a manual move of a quick card sitting in Implement is NOT rejected", async () => {
    // create the quick card, move it to Implement with the engine header (as the
    // gateway did), then move it manually — the D16 lock must NOT fire.
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

  it("a NORMAL card on Implement keeps manual moves and scope edits engine-owned", async () => {
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

    const scopeEdit = await fetch(`${base}/cards/${id}`, {
      method: "PATCH",
      headers: { "content-type": "application/json" },
      body: JSON.stringify({ scope: "personal", rev: afterImpl.card.rev }),
    });
    expect(scopeEdit.status).toBe(403);
    expect((await j(scopeEdit)).error).toBe("engine-owned");
  });
});

// The gateway still runs a trivial task inline and reports what actually served
// it. On the five-state board that lands as a single engine PATCH to Done —
// there is no Implement hop to pass through any more — and the route evidence
// has to survive that one write, or a quick turn leaves no record of its model.
describe("a quick turn's route + effort evidence survives the engine's Done write", () => {
  it("persists the reported route onto the card's routed event", async () => {
    const created = await j(
      await fetch(`${base}/cards`, {
        method: "POST",
        headers: { "content-type": "application/json" },
        body: JSON.stringify({ title: "quick routed", project: "demo", quick: true })
      })
    );
    const id = created.card.id;
    expect(created.card.list).toBe("todo"); // the default create list
    const completed = await fetch(`${base}/cards/${id}`, {
      method: "PATCH",
      headers: { "content-type": "application/json", "x-garrison-engine": "gateway" },
      body: JSON.stringify({
        list: "done",
        rev: created.card.rev,
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
    expect(detail.card.list).toBe("done");
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
