// Item 4 — export / import a list of cards. Boots the REAL board server
// (makeRequestHandler over an ephemeral port) against a sandboxed board, then:
//   - creates a card with EVERYTHING (routing pin, checklist, a scheduled RUN, and a
//     dispatchCommand — the field that must NEVER travel),
//   - exports its list and asserts the bundle carries the ALLOW-LIST and nothing else,
//   - round-trips it back in onto another list and asserts fresh-ULID cards,
//   - proves preview writes nothing, a target list that is not on the board is
//     refused, and the scheduleAction "run" → "notify" downgrade is applied.
//
// Sandbox mirrors tests/kanban-add-card.test.ts: tmp GARRISON_KANBAN_DIR + a
// nonexistent GARRISON_POLICY_PATH so loadPolicy() is null (hermetic create).
import { describe, it, expect, beforeAll, afterAll } from "vitest";
import { mkdtempSync, mkdirSync } from "node:fs";
import { tmpdir } from "node:os";
import { join, resolve } from "node:path";
import http from "node:http";
import url from "node:url";

const HERE = resolve(url.fileURLToPath(import.meta.url), "..");
const FITTING = resolve(HERE, "..", "fittings", "seed", "kanban-loop");

const KANBAN_DIR = mkdtempSync(join(tmpdir(), "exim-kanban-"));
const GARRISON_HOME = mkdtempSync(join(tmpdir(), "exim-home-"));
const RUNS_DIR = mkdtempSync(join(tmpdir(), "exim-runs-"));
process.env.GARRISON_KANBAN_DIR = KANBAN_DIR;
process.env.GARRISON_HOME = GARRISON_HOME;
process.env.GARRISON_RUNS_DIR = RUNS_DIR;
process.env.GARRISON_POLICY_PATH = "/nonexistent/garrison-policy.json";

// @ts-ignore — pure ESM .mjs, no .d.ts
import { makeRequestHandler } from "../fittings/seed/kanban-loop/scripts/server.mjs";
// @ts-ignore
import { seedBoard } from "../fittings/seed/kanban-loop/scripts/kanban.mjs";
// @ts-ignore
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


let gateway: http.Server;
let server: http.Server;
let base = "";

async function listen(s: http.Server): Promise<number> {
  await new Promise<void>((r) => s.listen(0, "127.0.0.1", r));
  return (s.address() as any).port;
}

beforeAll(async () => {
  mkdirSync(join(KANBAN_DIR, "cards"), { recursive: true });
  await saveBoard(seedBoard(), KANBAN_DIR);
  gateway = http.createServer((req, res) => {
    if (req.method === "POST") {
      res.writeHead(200, { "content-type": "text/event-stream" });
      res.write(`event: done\ndata: ${JSON.stringify({ reply: "" })}\n\n`);
      return res.end();
    }
    res.writeHead(200); res.end("ok");
  });
  const gatewayUrl = `http://127.0.0.1:${await listen(gateway)}`;
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

const FUTURE = "2099-01-01T00:00:00.000Z";

describe("Item 4 — export / import a list of cards", () => {
  let sourceId = "";

  it("creates a fully-loaded source card in Scheduled", async () => {
    const create = await jsend("POST", "/cards", {
      title: "Ship the widget",
      description: "build + wire + test the widget",
      project: "garrison",
      acceptance: "widget renders and the test is green",
      goalMode: true,
      checklist: [{ text: "wire the handler" }, { text: "add a test", done: true }],
      routing: { tier: "T1-standard", model: "sonnet" },
      scheduledFor: FUTURE,
      scheduleAction: "run",
      dispatchCommand: "echo do-not-travel"
    });
    expect(create.status).toBe(201);
    sourceId = create.body.card.id;
    // The source really does carry a dispatchCommand — so proving it doesn't travel is meaningful.
    const detail = await jget(`/cards/${sourceId}`);
    expect(detail.body.card.dispatchCommand).toBe("echo do-not-travel");
    expect(detail.body.card.list).toBe("scheduled");
  });

  it("exports the list as a bundle carrying the ALLOW-LIST and nothing else", async () => {
    const r = await fetch(base + "/cards/export?list=scheduled");
    expect(r.status).toBe(200);
    const bundle = (await r.json()) as any;
    expect(bundle.kind).toBe("garrison.kanban.cards");
    expect(bundle.version).toBe(1);
    expect(Array.isArray(bundle.cards)).toBe(true);
    const exported = bundle.cards.find((c: any) => c.title === "Ship the widget");
    expect(exported).toBeTruthy();

    // Content that MUST travel.
    expect(exported.title).toBe("Ship the widget");
    expect(exported.description).toBe("build + wire + test the widget");
    expect(exported.project).toBe("garrison");
    expect(exported.scope).toBe("project");
    expect(exported.acceptance).toBe("widget renders and the test is green");
    expect(exported.goalMode).toBe(true);
    expect(exported.routing).toMatchObject({ tier: "T1-standard", model: "sonnet" });
    expect(exported.checklist.map((i: any) => i.text)).toEqual(["wire the handler", "add a test"]);
    expect(exported.scheduledFor).toBe(FUTURE);
    expect(exported.schedule).toMatchObject({
      kind: "once",
      action: "run",
      at: FUTURE,
      nextAt: FUTURE,
      targetList: "todo"
    });

    // Identity / lifecycle / evidence / coordination / the dispatchCommand must NOT travel.
    for (const forbidden of [
      "id", "rev", "status", "iterations", "position",
      "runId", "runDir", "sessionIds", "briefPath", "events", "logIndex",
      "coordinationSeq", "waitingOn", "blocking", "fences", "preparedRevert",
      "dispatch", "placement", "outpost", "origin", "origin_id", "continues",
      "duty", "level", "sequence", "dispatchCommand"
    ]) {
      expect(exported).not.toHaveProperty(forbidden);
    }

    // Every key present is either an allow-listed content field or a source marker.
    const allowed = new Set([
      "title", "description", "project", "scope", "acceptance", "goalMode", "checklist",
      "routing", "flow", "tier", "phases", "scheduledFor", "scheduleAction", "schedule",
      "sourceList", "created"
    ]);
    for (const k of Object.keys(exported)) expect(allowed.has(k)).toBe(true);
  });

  it("round-trips the personal label independently of a real project", async () => {
    const create = await jsend("POST", "/cards", {
      title: "Personal repository task",
      description: "Private work that still belongs in Garrison",
      project: "garrison",
      scope: "personal"
    });
    expect(create.status).toBe(201);

    const response = await fetch(base + "/cards/export?list=todo");
    const bundle = await response.json() as any;
    const exported = bundle.cards.find((card: any) => card.title === "Personal repository task");
    expect(exported).toMatchObject({ project: "garrison", scope: "personal" });

    const imported = await jsend("POST", "/cards/import", {
      bundle: { ...bundle, cards: [exported] },
      targetList: "todo"
    });
    expect(imported.status).toBe(201);
    expect(imported.body.cards[0]).toMatchObject({
      project: "garrison",
      scope: "personal",
      list: "todo"
    });
  });

  it("preview reports the count without writing anything", async () => {
    const before = await jget("/board");
    const beforeTodo = before.body.lists.find((l: any) => l.id === "todo").cards.length;

    const exp = await fetch(base + "/cards/export?list=todo");
    const bundle = await exp.json();
    const preview = await jsend("POST", "/cards/import", { bundle, targetList: "todo", preview: true });
    expect(preview.status).toBe(200);
    expect(preview.body.preview).toBe(true);
    expect(preview.body.count).toBeGreaterThanOrEqual(1);

    const after = await jget("/board");
    const afterTodo = after.body.lists.find((l: any) => l.id === "todo").cards.length;
    expect(afterTodo).toBe(beforeTodo); // nothing written
  });

  it("round-trip import creates FRESH-ULID cards on the target list and downgrades run→notify", async () => {
    const exp = await fetch(base + "/cards/export?list=scheduled");
    const bundle = await exp.json();
    const imp = await jsend("POST", "/cards/import", { bundle, targetList: "todo" });
    expect(imp.status).toBe(201);
    expect(imp.body.imported).toBeGreaterThanOrEqual(1);
    // The run→notify downgrade fired (a warning names it).
    expect(imp.body.warnings.some((w: string) => /run.*notify|notify.*run/i.test(w))).toBe(true);

    const board = await jget("/board");
    const scheduled = board.body.lists.find((l: any) => l.id === "scheduled");
    const landed = scheduled.cards.find((c: any) => c.title === "Ship the widget" && c.id !== sourceId);
    expect(landed).toBeTruthy();
    // Fresh identity — NOT the source id.
    expect(landed.id).not.toBe(sourceId);
    expect(landed.rev).toBe(0);
    expect(landed.list).toBe("scheduled");
    // Content survived the round trip.
    expect(landed.project).toBe("garrison");
    expect(landed.scope).toBe("project");
    expect(landed.goalMode).toBe(true);
    expect(landed.routing).toMatchObject({ tier: "T1-standard", model: "sonnet" });
    // The scheduled RUN is downgraded to a reminder — an imported card never auto-runs.
    expect(landed.scheduledFor).toBe(FUTURE);
    expect(landed.scheduleAction).toBe("notify");
    expect(landed.schedule).toMatchObject({
      kind: "once",
      action: "notify",
      at: FUTURE,
      nextAt: FUTURE,
      targetList: "todo"
    });
    // The dispatchCommand never made it across.
    const detail = await jget(`/cards/${landed.id}`);
    expect(detail.body.card.dispatchCommand).toBeNull();
    const sourceDetail = await jget(`/cards/${sourceId}`);
    expect(detail.body.checklist.map((item: any) => item.id))
      .not.toEqual(sourceDetail.body.checklist.map((item: any) => item.id));
  });

  it("refuses a target list that is not on the board", async () => {
    // Conversations: the duty lists this guard used to name ("plan") are gone, so
    // an import can only land on one of the five state columns. A retired list id
    // is refused BEFORE any card is written.
    const exp = await fetch(base + "/cards/export?list=scheduled");
    const bundle = await exp.json();
    const before = await jget("/board");
    const bad = await jsend("POST", "/cards/import", { bundle, targetList: "plan" });
    expect(bad.status).toBe(400);
    expect(String(bad.body.error)).toMatch(/unknown target list: plan/i);
    const after = await jget("/board");
    expect(after.body.lists.map((l: any) => l.cards.length))
      .toEqual(before.body.lists.map((l: any) => l.cards.length));
  });

  // Cards enter Running only through the launcher: handleImportCards calls
  // createCard directly (bypassing the POST /cards door), so it carries its own
  // refusal — without it a plain browser-shaped import minted phantom "running"
  // cards with no conversation behind them (coherentCardState stamped the
  // status from the list).
  it("refuses to import onto the running list without the engine header", async () => {
    const bundle = { kind: "garrison.kanban.cards", version: 1, cards: [{ title: "phantom", description: "no conversation behind it" }] };
    const bad = await jsend("POST", "/cards/import", { bundle, targetList: "running" });
    expect(bad.status).toBe(400);
    const board = await jget("/board");
    expect(board.body.lists.find((l: any) => l.id === "running").cards).toEqual([]);
  });

  it("rejects a non-bundle body", async () => {
    const bad = await jsend("POST", "/cards/import", { bundle: { kind: "nope", version: 1, cards: [] } });
    expect(bad.status).toBe(400);
  });

  it("removes machine-local projects and ClaudeChat attachment markers in both directions", async () => {
    const create = await jsend("POST", "/cards", {
      title: "Machine-bound source",
      description: "Portable body\n\nAttached files:\n- /home/ggomes/private/screenshot.png",
      project: "/home/ggomes/dev/garrison",
      routing: { project: "/home/ggomes/dev/garrison", model: "sonnet" }
    });
    expect(create.status).toBe(201);
    const exportedResponse = await fetch(base + "/cards/export?list=todo");
    const exportedBundle = await exportedResponse.json() as any;
    const exported = exportedBundle.cards.find((card: any) => card.title === "Machine-bound source");
    expect(exported.project).toBeUndefined();
    expect(exported.scope).toBe("unscoped");
    expect(exported.routing).toEqual({ model: "sonnet" });
    expect(exported.description).toBe("Portable body");

    const hostile = {
      kind: "garrison.kanban.cards",
      version: 1,
      sourceLists: [{ id: "elsewhere", title: "Elsewhere" }],
      cards: [{
        title: "Hostile portable card",
        description: "Keep this\n\nAttached file:\n- C:\\Users\\someone\\secret.txt",
        project: "C:\\Users\\someone\\repo",
        routing: { project: "file:///Users/someone/repo", model: "sonnet" }
      }]
    };
    const imp = await jsend("POST", "/cards/import", { bundle: hostile, targetList: "todo" });
    expect(imp.status).toBe(201);
    expect(imp.body.warnings.some((warning: string) => /machine-local project path/i.test(warning))).toBe(true);
    const importedId = imp.body.cards[0].id;
    const detail = await jget(`/cards/${importedId}`);
    expect(detail.body.card.project).toBeNull();
    expect(detail.body.card.routing).toEqual({ model: "sonnet" });
    expect(detail.body.card.description).toBe("Keep this");
  });

  it("normalises nested export fields and rejects every path-shaped project spelling", async () => {
    const create = await jsend("POST", "/cards", {
      title: "Nested portable source",
      description: "Only content should travel",
      project: "../private/repo",
      routing: { project: "\\\\server\\share\\repo", model: "sonnet", extraSecret: "nope" },
      phases: { plan: true, review: false, nested: { secret: true }, "../escape": true },
      checklist: [{ text: "Keep the task", done: false, secret: "do not export", attachmentPath: "/private/file" }]
    });
    expect(create.status).toBe(201);

    const response = await fetch(base + "/cards/export?list=todo");
    const bundle = await response.json() as any;
    const exported = bundle.cards.find((card: any) => card.title === "Nested portable source");
    expect(exported.project).toBeUndefined();
    expect(exported.routing).toEqual({ model: "sonnet" });
    expect(exported.phases).toEqual({ plan: true, review: false });
    expect(exported.checklist).toEqual([{ text: "Keep the task", done: false }]);

    const hostile = {
      kind: "garrison.kanban.cards",
      version: 1,
      cards: [
        { title: "UNC", project: "\\\\server\\share", routing: { project: "foo/bar", model: "sonnet" } },
        { title: "Dot path", project: ".hidden", routing: { project: "../repo" } }
      ]
    };
    const imported = await jsend("POST", "/cards/import", { bundle: hostile, targetList: "todo" });
    expect(imported.status).toBe(201);
    for (const summary of imported.body.cards) {
      const detail = await jget(`/cards/${summary.id}`);
      expect(detail.body.card.project).toBeNull();
      expect(detail.body.card.routing?.project).toBeUndefined();
    }
  });

  const TRELLO = {
    id: "board-1",
    name: "Personal tasks",
    lists: [
      { id: "trello-inbox", name: "Inbox", closed: false, pos: 100 },
      { id: "trello-later", name: "Later", closed: false, pos: 200 },
      { id: "trello-archive", name: "Old", closed: true, pos: 300 }
    ],
    cards: [
      {
        id: "trello-card-1",
        idList: "trello-inbox",
        name: "Trello first",
        desc: "A useful description",
        closed: false,
        pos: 10,
        due: FUTURE,
        dueComplete: false,
        shortUrl: "https://trello.com/c/abc123/trello-first",
        labels: [{ name: "Priority", color: "red" }],
        members: [{ id: "must-not-travel", fullName: "Private Person" }],
        attachments: [{ url: "https://example.invalid/private" }]
      },
      {
        id: "trello-card-2",
        idList: "trello-inbox",
        name: "Unsafe metadata",
        desc: "Keep this paragraph\n\nAttached files:\n- /Users/someone/private.png",
        closed: false,
        pos: 20,
        shortUrl: "javascript:alert(1)",
        labels: []
      },
      { id: "trello-card-3", idList: "trello-later", name: "Archived card", desc: "", closed: true, pos: 10 },
      { id: "trello-card-4", idList: "trello-archive", name: "Card on archived list", desc: "", closed: false, pos: 10 }
    ],
    checklists: [{
      id: "trello-checklist",
      idCard: "trello-card-1",
      name: "Launch",
      checkItems: [
        { id: "trello-item-one", name: "Prepare", state: "complete", pos: 10 },
        { id: "trello-item-two", name: "Ship", state: "incomplete", pos: 20 }
      ]
    }],
    actions: [{ type: "commentCard", data: { text: "must not travel" } }]
  };

  it("previews Trello JSON by source list and excludes archived cards by default", async () => {
    const all = await jsend("POST", "/cards/import", { bundle: TRELLO, targetList: "todo", preview: true });
    expect(all.status).toBe(200);
    expect(all.body.sourceFormat).toBe("trello");
    expect(all.body.sourceName).toBe("Personal tasks");
    expect(all.body.count).toBe(2);
    expect(all.body.excludedArchived).toBe(2);
    expect(all.body.sourceLists.map((list: any) => list.title)).toEqual(["Inbox", "Later", "Old"]);

    const oneList = await jsend("POST", "/cards/import", {
      bundle: TRELLO,
      targetList: "todo",
      sourceList: "trello-later",
      includeArchived: true,
      preview: true
    });
    expect(oneList.status).toBe(200);
    expect(oneList.body.count).toBe(1);
  });

  it("imports Trello titles, descriptions, safe provenance, due dates, and fresh checklist identities", async () => {
    const imp = await jsend("POST", "/cards/import", {
      bundle: TRELLO,
      targetList: "todo",
      sourceList: "trello-inbox"
    });
    expect(imp.status).toBe(201);
    expect(imp.body.imported).toBe(2);

    const first = imp.body.cards.find((card: any) => card.title === "Trello first");
    const firstDetail = await jget(`/cards/${first.id}`);
    expect(firstDetail.body.card.description).toContain("A useful description");
    expect(firstDetail.body.card.description).toContain("https://trello.com/c/abc123/trello-first");
    expect(firstDetail.body.card.description).toContain("Labels: Priority");
    expect(firstDetail.body.card.description).not.toContain("Private Person");
    expect(firstDetail.body.card.description).not.toContain("example.invalid");
    expect(firstDetail.body.card.scheduledFor).toBe(FUTURE);
    expect(firstDetail.body.card.scheduleAction).toBe("notify");
    expect(firstDetail.body.checklist.map((item: any) => item.text)).toEqual(["Launch\n\nPrepare", "Launch\n\nShip"]);
    expect(firstDetail.body.checklist.map((item: any) => item.done)).toEqual([true, false]);
    expect(firstDetail.body.checklist.map((item: any) => item.id)).not.toContain("trello-item-one");

    const unsafe = imp.body.cards.find((card: any) => card.title === "Unsafe metadata");
    const unsafeDetail = await jget(`/cards/${unsafe.id}`);
    expect(unsafeDetail.body.card.description).toContain("Keep this paragraph");
    expect(unsafeDetail.body.card.description).not.toContain("Attached files:");
    expect(unsafeDetail.body.card.description).not.toContain("private.png");
    expect(unsafeDetail.body.card.description).not.toContain("javascript:");

    const todo = (await jget("/board")).body.lists.find((list: any) => list.id === "todo");
    expect(todo.cards.findIndex((card: any) => card.id === first.id))
      .toBeLessThan(todo.cards.findIndex((card: any) => card.id === unsafe.id));
  });
});
