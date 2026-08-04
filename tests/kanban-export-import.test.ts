// Item 4 — export / import a list of cards. Boots the REAL board server
// (makeRequestHandler over an ephemeral port) against a sandboxed board, then:
//   - creates a card with EVERYTHING (routing pin, checklist, a scheduled RUN, and a
//     dispatchCommand — the field that must NEVER travel),
//   - exports its list and asserts the bundle carries the ALLOW-LIST and nothing else,
//   - round-trips it back in onto another list and asserts fresh-ULID cards,
//   - proves preview writes nothing, an agent-list target is refused, and the
//     scheduleAction "run" → "notify" downgrade is applied.
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

  it("creates a fully-loaded source card in Backlog", async () => {
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
  });

  it("exports the list as a bundle carrying the ALLOW-LIST and nothing else", async () => {
    const r = await fetch(base + "/cards/export?list=backlog");
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
    expect(exported.acceptance).toBe("widget renders and the test is green");
    expect(exported.goalMode).toBe(true);
    expect(exported.routing).toMatchObject({ tier: "T1-standard", model: "sonnet" });
    expect(exported.checklist.map((i: any) => i.text)).toEqual(["wire the handler", "add a test"]);
    expect(exported.scheduledFor).toBe(FUTURE);

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
      "title", "description", "project", "acceptance", "goalMode", "checklist",
      "routing", "workKind", "tier", "phases", "scheduledFor", "scheduleAction",
      "sourceList", "created"
    ]);
    for (const k of Object.keys(exported)) expect(allowed.has(k)).toBe(true);
  });

  it("preview reports the count without writing anything", async () => {
    const before = await jget("/board");
    const beforeTodo = before.body.lists.find((l: any) => l.id === "todo").cards.length;

    const exp = await fetch(base + "/cards/export?list=backlog");
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
    const exp = await fetch(base + "/cards/export?list=backlog");
    const bundle = await exp.json();
    const imp = await jsend("POST", "/cards/import", { bundle, targetList: "todo" });
    expect(imp.status).toBe(201);
    expect(imp.body.imported).toBeGreaterThanOrEqual(1);
    // The run→notify downgrade fired (a warning names it).
    expect(imp.body.warnings.some((w: string) => /run.*notify|notify.*run/i.test(w))).toBe(true);

    const board = await jget("/board");
    const todo = board.body.lists.find((l: any) => l.id === "todo");
    const landed = todo.cards.find((c: any) => c.title === "Ship the widget");
    expect(landed).toBeTruthy();
    // Fresh identity — NOT the source id.
    expect(landed.id).not.toBe(sourceId);
    expect(landed.rev).toBe(0);
    expect(landed.list).toBe("todo");
    // Content survived the round trip.
    expect(landed.project).toBe("garrison");
    expect(landed.goalMode).toBe(true);
    expect(landed.routing).toMatchObject({ tier: "T1-standard", model: "sonnet" });
    // The scheduled RUN is downgraded to a reminder — an imported card never auto-runs.
    expect(landed.scheduledFor).toBe(FUTURE);
    expect(landed.scheduleAction).toBe("notify");
    // The dispatchCommand never made it across.
    const detail = await jget(`/cards/${landed.id}`);
    expect(detail.body.card.dispatchCommand).toBeNull();
  });

  it("refuses to import onto an agent list (would auto-dispatch runs)", async () => {
    const exp = await fetch(base + "/cards/export?list=backlog");
    const bundle = await exp.json();
    const bad = await jsend("POST", "/cards/import", { bundle, targetList: "plan" });
    expect(bad.status).toBe(400);
    expect(String(bad.body.error)).toMatch(/agent list/i);
  });

  it("rejects a non-bundle body", async () => {
    const bad = await jsend("POST", "/cards/import", { bundle: { kind: "nope", version: 1, cards: [] } });
    expect(bad.status).toBe(400);
  });
});
