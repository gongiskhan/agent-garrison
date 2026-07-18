// S1a — the SERVER contract behind the Backlog inline quick-add UI. Boots the REAL
// own-port board server (makeRequestHandler over an ephemeral port) against a
// sandboxed, freshly-seeded board and exercises POST /cards exactly the way the
// board UI's BacklogAddCard does: { title, description?, project? } → a card that
// lands in Backlog and shows up on GET /board without any other action. Also pins
// the two contract edges the UI leans on: title inference from the description, and
// the empty-input rejection.
//
// Sandboxed like tests/coordination-server.test.ts: tmp GARRISON_KANBAN_DIR board,
// tmp GARRISON_HOME / GARRISON_RUNS_DIR, and a nonexistent GARRISON_POLICY_PATH so
// loadPolicy() is null (coordination + policy branches stay off — a hermetic create).
import { describe, it, expect, beforeAll, afterAll } from "vitest";
import { mkdtempSync, mkdirSync } from "node:fs";
import { tmpdir } from "node:os";
import { join, resolve } from "node:path";
import http from "node:http";
import url from "node:url";

const HERE = resolve(url.fileURLToPath(import.meta.url), "..");
const FITTING = resolve(HERE, "..", "fittings", "seed", "kanban-loop");

// ── env sandbox (set BEFORE importing the server / board modules) ──
const KANBAN_DIR = mkdtempSync(join(tmpdir(), "addcard-kanban-"));
const GARRISON_HOME = mkdtempSync(join(tmpdir(), "addcard-home-"));
const RUNS_DIR = mkdtempSync(join(tmpdir(), "addcard-runs-"));
process.env.GARRISON_KANBAN_DIR = KANBAN_DIR;
process.env.GARRISON_HOME = GARRISON_HOME;
process.env.GARRISON_RUNS_DIR = RUNS_DIR;
// Policy-less: loadPolicy() → null, so the create path skips the coordination /
// work-kind branches and is a pure Backlog insert.
process.env.GARRISON_POLICY_PATH = "/nonexistent/garrison-policy.json";

// @ts-ignore — pure ESM .mjs, no .d.ts
import { makeRequestHandler } from "../fittings/seed/kanban-loop/scripts/server.mjs";
// @ts-ignore
import { seedBoard } from "../fittings/seed/kanban-loop/scripts/kanban.mjs";
// @ts-ignore
import { saveBoard } from "../fittings/seed/kanban-loop/lib/board.mjs";

let gateway: http.Server;
let gatewayUrl = "";
let server: http.Server;
let base = "";

async function listen(s: http.Server): Promise<number> {
  await new Promise<void>((r) => s.listen(0, "127.0.0.1", r));
  return (s.address() as any).port;
}

beforeAll(async () => {
  mkdirSync(join(KANBAN_DIR, "cards"), { recursive: true });
  await saveBoard(seedBoard(), KANBAN_DIR);

  // A benign stub gateway so any fire-and-forget project inference (a no-project
  // card) resolves quietly. The UI-parity cases below all pass a project, so this
  // is only defence in depth.
  gateway = http.createServer((req, res) => {
    if (req.method === "POST") {
      res.writeHead(200, { "content-type": "text/event-stream" });
      res.write(`event: done\ndata: ${JSON.stringify({ reply: "" })}\n\n`);
      return res.end();
    }
    res.writeHead(200); res.end("ok");
  });
  gatewayUrl = `http://127.0.0.1:${await listen(gateway)}`;

  const opts = { root: KANBAN_DIR, cwd: KANBAN_DIR, gatewayUrl, cap: 10 };
  server = http.createServer(makeRequestHandler(opts, join(FITTING, "dist")));
  base = `http://127.0.0.1:${await listen(server)}`;
});

afterAll(async () => {
  await new Promise<void>((r) => server.close(() => r()));
  await new Promise<void>((r) => gateway.close(() => r()));
});

async function jget(path: string) {
  const r = await fetch(base + path);
  return { status: r.status, body: (await r.json()) as any };
}
async function jsend(method: string, path: string, body?: unknown) {
  const r = await fetch(base + path, {
    method,
    headers: { "content-type": "application/json" },
    body: body === undefined ? undefined : JSON.stringify(body)
  });
  return { status: r.status, body: (await r.json()) as any };
}

describe("POST /cards — the Backlog quick-add contract", () => {
  it("creates a card in Backlog from title + description + project, and it shows on the board", async () => {
    const create = await jsend("POST", "/cards", {
      title: "Wire the export button",
      description: "the toolbar export needs a real handler",
      project: "garrison"
    });
    expect(create.status).toBe(201);
    const card = create.body.card;
    expect(card.title).toBe("Wire the export button");
    expect(card.description).toBe("the toolbar export needs a real handler");
    expect(card.project).toBe("garrison");
    expect(card.list).toBe("backlog");

    // The UI refreshes via GET /board — the new card must be nested under Backlog
    // there (membership is derived from the card, never stored).
    const board = await jget("/board");
    expect(board.status).toBe(200);
    const backlog = board.body.lists.find((l: any) => l.id === "backlog");
    expect(backlog.cards.map((c: any) => c.id)).toContain(card.id);
    const onBoard = backlog.cards.find((c: any) => c.id === card.id);
    expect(onBoard.title).toBe("Wire the export button");
    expect(onBoard.project).toBe("garrison");
  });

  it("accepts a title-only card (description optional) into Backlog", async () => {
    const create = await jsend("POST", "/cards", { title: "Just a title", project: "garrison" });
    expect(create.status).toBe(201);
    expect(create.body.card.title).toBe("Just a title");
    expect(create.body.card.list).toBe("backlog");
  });

  it("synchronously scopes an auto-project card to its explicit absolute workspace", async () => {
    const create = await jsend("POST", "/cards", {
      title: "Build an isolated cache",
      description: "Implement the package in /tmp/kanban-explicit-workspace-proof. Run its tests."
    });
    expect(create.status).toBe(201);
    expect(create.body.card.project).toBe("/tmp/kanban-explicit-workspace-proof");
    expect(create.body.card.inferState).toBe("done");
    const detail = await jget(`/cards/${create.body.card.id}`);
    expect(detail.body.events).toEqual(expect.arrayContaining([
      expect.objectContaining({ kind: "inference", message: expect.stringContaining("Detected explicit workspace") })
    ]));
  });

  it("infers the title from the description when title is blank (the sheet path)", async () => {
    const create = await jsend("POST", "/cards", {
      title: "   ",
      description: "First line becomes the title\nsecond line ignored",
      project: "garrison"
    });
    expect(create.status).toBe(201);
    expect(create.body.card.title).toBe("First line becomes the title");
    expect(create.body.card.list).toBe("backlog");
  });

  it("rejects a card with neither a title nor a description (400)", async () => {
    const create = await jsend("POST", "/cards", { project: "garrison" });
    expect(create.status).toBe(400);
    expect(String(create.body.error)).toMatch(/title or a description/i);
  });
});
