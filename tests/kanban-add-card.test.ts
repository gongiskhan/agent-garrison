// S1a — the SERVER contract behind the Backlog / To Do inline quick-add UI. Boots the REAL
// own-port board server (makeRequestHandler over an ephemeral port) against a
// sandboxed, freshly-seeded board and exercises POST /cards exactly the way the
// board UI's ListAddCard does: { title, description?, project?, targetList? } → a card
// that lands directly in that manual list and shows up on GET /board without a
// create-then-move transition. Also pins
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

describe("POST /cards — the direct manual-list quick-add contract", () => {
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

  it("creates directly at the TOP of To Do without a transient Backlog card", async () => {
    const older = await jsend("POST", "/cards", {
      title: "Older direct To Do card",
      project: "garrison",
      targetList: "todo"
    });
    const newer = await jsend("POST", "/cards", {
      title: "Newer direct To Do card",
      project: "garrison",
      targetList: "todo"
    });
    expect(older.status).toBe(201);
    expect(newer.status).toBe(201);
    expect(older.body.card.list).toBe("todo");
    expect(newer.body.card.list).toBe("todo");

    const board = await jget("/board");
    const backlog = board.body.lists.find((l: any) => l.id === "backlog");
    const todo = board.body.lists.find((l: any) => l.id === "todo");
    expect(backlog.cards.map((c: any) => c.id)).not.toContain(older.body.card.id);
    expect(backlog.cards.map((c: any) => c.id)).not.toContain(newer.body.card.id);
    expect(todo.cards[0].id).toBe(newer.body.card.id);
    expect(todo.cards.findIndex((c: any) => c.id === newer.body.card.id))
      .toBeLessThan(todo.cards.findIndex((c: any) => c.id === older.body.card.id));
    expect(newer.body.card.position).toBeLessThan(older.body.card.position);
    const detail = await jget(`/cards/${newer.body.card.id}`);
    expect(detail.body.events?.some((event: any) => event.kind === "moved")).toBe(false);
  });

  it("refuses unknown, autonomous, interactive, and terminal direct-create targets", async () => {
    for (const targetList of ["missing", "plan", "discuss", "done", "archived"]) {
      const create = await jsend("POST", "/cards", {
        title: `Unsafe target ${targetList}`,
        project: "garrison",
        targetList
      });
      expect(create.status).toBe(400);
    }
  });

  it("renames a human-held card through the revision-checked PATCH used by inline editing", async () => {
    const create = await jsend("POST", "/cards", {
      title: "Title before inline edit",
      project: "garrison",
      targetList: "todo"
    });
    expect(create.status).toBe(201);
    const renamed = await jsend("PATCH", `/cards/${create.body.card.id}`, {
      title: "Title after inline edit",
      rev: create.body.card.rev
    });
    expect(renamed.status).toBe(200);
    expect(renamed.body.card.title).toBe("Title after inline edit");

    const stale = await jsend("PATCH", `/cards/${create.body.card.id}`, {
      title: "Stale title must not win",
      rev: create.body.card.rev
    });
    expect(stale.status).toBe(409);

    const board = await jget("/board");
    const todo = board.body.lists.find((l: any) => l.id === "todo");
    expect(todo.cards.find((c: any) => c.id === create.body.card.id)?.title)
      .toBe("Title after inline edit");
  });

  it("stamps an http(s) videoUrl at create (Drill Evidence) and rejects other schemes", async () => {
    const create = await jsend("POST", "/cards", {
      title: "Drill fix: home",
      description: "Drill batch fix",
      project: "garrison",
      videoUrl: "http://127.0.0.1:27096/api/runs/01TEST/evidence-file/video.webm"
    });
    expect(create.status).toBe(201);
    expect(create.body.card.videoUrl).toBe("http://127.0.0.1:27096/api/runs/01TEST/evidence-file/video.webm");
    const detail = await jget(`/cards/${create.body.card.id}`);
    expect(detail.body.card.videoUrl).toBe("http://127.0.0.1:27096/api/runs/01TEST/evidence-file/video.webm");
    // The links block (a sibling of `card` in the detail response) renders it
    // as the card's video href.
    expect(detail.body.links?.video).toMatchObject({ kind: "href" });

    const bad = await jsend("POST", "/cards", {
      title: "No file links",
      project: "garrison",
      videoUrl: "file:///etc/passwd"
    });
    expect(bad.status).toBe(201);
    expect(bad.body.card.videoUrl).toBeNull();
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

  // Item 1 — a new card lands at the TOP of the list, not the bottom. Create A
  // then B and prove B (the later create) sorts BEFORE A in Backlog, with a
  // strictly-lower effective position. Membership + order come from GET /board,
  // exactly as the UI renders it.
  it("adds a new card to the TOP of Backlog (later card sorts first)", async () => {
    const a = await jsend("POST", "/cards", { title: "Top test A", project: "garrison" });
    const b = await jsend("POST", "/cards", { title: "Top test B", project: "garrison" });
    expect(a.status).toBe(201);
    expect(b.status).toBe(201);

    const board = await jget("/board");
    const backlog = board.body.lists.find((l: any) => l.id === "backlog");
    const ids = backlog.cards.map((c: any) => c.id);
    const iA = ids.indexOf(a.body.card.id);
    const iB = ids.indexOf(b.body.card.id);
    // B was created after A, so B must appear ABOVE A (lower index) — top, not bottom.
    expect(iB).toBeLessThan(iA);
    // And B must be the very first card in Backlog.
    expect(iB).toBe(0);

    // The order is float-position driven: B's effective position is strictly below A's.
    const cardB = backlog.cards[iB];
    const cardA = backlog.cards[iA];
    expect(typeof cardB.position).toBe("number");
    expect(typeof cardA.position).toBe("number");
    expect(cardB.position).toBeLessThan(cardA.position);
  });

  // Item 2 — the Move button is the MANUAL gate: PATCH can move a card to ANY real
  // list, not just its validNext. This pins the server contract the UI's move sheet
  // now leans on (deriveMoveTargets offers every list; there is no validNext gate on
  // PATCH). backlog.validNext is ["todo"], so a move straight to "done" proves it.
  it("move: PATCH can move a card to an arbitrary list outside its validNext", async () => {
    const create = await jsend("POST", "/cards", { title: "Move me anywhere", project: "garrison" });
    expect(create.status).toBe(201);
    const { id, rev } = create.body.card;

    const moved = await jsend("PATCH", `/cards/${id}`, { list: "done", rev });
    expect(moved.status).toBe(200);
    expect(moved.body.card.list).toBe("done");

    const board = await jget("/board");
    const done = board.body.lists.find((l: any) => l.id === "done");
    expect(done.cards.map((c: any) => c.id)).toContain(id);
  });

  it("moves without an explicit drag position land at the TOP of the destination", async () => {
    const older = await jsend("POST", "/cards", { title: "Older destination card", project: "garrison" });
    const olderMove = await jsend("PATCH", `/cards/${older.body.card.id}`, { list: "done", rev: older.body.card.rev });
    expect(olderMove.status).toBe(200);

    const fresh = await jsend("POST", "/cards", { title: "Fresh destination card", project: "garrison" });
    const freshMove = await jsend("PATCH", `/cards/${fresh.body.card.id}`, { list: "done", rev: fresh.body.card.rev });
    expect(freshMove.status).toBe(200);

    const board = await jget("/board");
    const done = board.body.lists.find((l: any) => l.id === "done");
    expect(done.cards.findIndex((c: any) => c.id === fresh.body.card.id))
      .toBeLessThan(done.cards.findIndex((c: any) => c.id === older.body.card.id));
  });

  it("preserves an explicit drag position on a cross-list move", async () => {
    const create = await jsend("POST", "/cards", { title: "Precisely dropped", project: "garrison" });
    const moved = await jsend("PATCH", `/cards/${create.body.card.id}`, {
      list: "todo",
      position: -987_654_321,
      rev: create.body.card.rev
    });
    expect(moved.status).toBe(200);
    expect(moved.body.card.position).toBe(-987_654_321);
  });

  it("serialises concurrent top-position allocation", async () => {
    const created = await Promise.all(Array.from({ length: 8 }, (_, i) =>
      jsend("POST", "/cards", { title: `Concurrent top ${i}`, project: "garrison" })
    ));
    expect(created.every((r) => r.status === 201)).toBe(true);
    const ids = new Set(created.map((r) => r.body.card.id));
    const board = await jget("/board");
    const backlog = board.body.lists.find((l: any) => l.id === "backlog");
    const positions = backlog.cards
      .filter((card: any) => ids.has(card.id))
      .map((card: any) => card.position);
    expect(positions).toHaveLength(8);
    expect(positions.every((position: unknown) => typeof position === "number" && Number.isFinite(position))).toBe(true);
    expect(new Set(positions).size).toBe(8);
  });

  it("serialises concurrent implicit moves into one destination", async () => {
    const created = await Promise.all(Array.from({ length: 6 }, (_, i) =>
      jsend("POST", "/cards", { title: `Concurrent move ${i}`, project: "garrison" })
    ));
    const moved = await Promise.all(created.map((response) =>
      jsend("PATCH", `/cards/${response.body.card.id}`, { list: "archived", rev: response.body.card.rev })
    ));
    expect(moved.every((response) => response.status === 200)).toBe(true);
    const positions = moved.map((response) => response.body.card.position);
    expect(positions.every((position) => typeof position === "number" && Number.isFinite(position))).toBe(true);
    expect(new Set(positions).size).toBe(positions.length);
  });

  it("resolves a concurrent create versus explicit drag-to-top collision", async () => {
    const dragCard = await jsend("POST", "/cards", { title: "Concurrent dragged top", project: "garrison" });
    const before = await jget("/board");
    const backlog = before.body.lists.find((list: any) => list.id === "backlog");
    const oldMin = Math.min(...backlog.cards.map((card: any) => card.position));
    const requestedTop = oldMin - 60_000;

    const [created, moved] = await Promise.all([
      jsend("POST", "/cards", { title: "Concurrent created top", project: "garrison" }),
      jsend("PATCH", `/cards/${dragCard.body.card.id}`, {
        list: "backlog",
        position: requestedTop,
        rev: dragCard.body.card.rev
      })
    ]);
    expect(created.status).toBe(201);
    expect(moved.status).toBe(200);
    expect(created.body.card.position).toBeLessThan(oldMin);
    expect(moved.body.card.position).toBeLessThan(oldMin);
    expect(created.body.card.position).not.toBe(moved.body.card.position);
  });

  it("round-trips edited checklist items with five paragraphs and no 500-char truncation", async () => {
    const original = Array.from(
      { length: 5 },
      (_, i) => `Paragraph ${i + 1}: ${"detail ".repeat(30).trimEnd()}`
    ).join("\n\n");
    expect(original.length).toBeGreaterThan(500);
    const create = await jsend("POST", "/cards", {
      title: "Long checklist",
      project: "garrison",
      checklist: [{ text: original, done: false }]
    });
    expect(create.status).toBe(201);
    const detail = await jget(`/cards/${create.body.card.id}`);
    expect(detail.body.checklist[0].text).toBe(original);

    const edited = `${original}\n\nSixth paragraph added during editing.`;
    const patch = await jsend("PATCH", `/cards/${create.body.card.id}`, {
      rev: detail.body.card.rev,
      checklist: [{ ...detail.body.checklist[0], text: edited }]
    });
    expect(patch.status).toBe(200);
    const after = await jget(`/cards/${create.body.card.id}`);
    expect(after.body.checklist[0].text).toBe(edited);
  });

  it("rejects oversized checklist input instead of silently truncating it", async () => {
    const tooLong = await jsend("POST", "/cards", {
      title: "Too long checklist",
      project: "garrison",
      checklist: [{ text: "x".repeat(64 * 1024 + 1) }]
    });
    expect(tooLong.status).toBe(400);
    expect(String(tooLong.body.error)).toMatch(/checklist item 1 exceeds/i);

    const tooMany = await jsend("POST", "/cards", {
      title: "Too many checklist items",
      project: "garrison",
      checklist: Array.from({ length: 101 }, (_, index) => ({ text: `item ${index}` }))
    });
    expect(tooMany.status).toBe(400);
    expect(String(tooMany.body.error)).toMatch(/maximum is 100/i);
  });
});
