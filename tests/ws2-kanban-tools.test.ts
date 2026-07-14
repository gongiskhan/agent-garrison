// WS2 — the mcp-gateway kanban tools (fetch_evidence + create_continuation) and the
// board-side fetch-log, against the REAL booted board server. Mirrors the sandbox +
// server-boot pattern of tests/kanban-add-card.test.ts and tests/automations-mcp.test.ts.
import { describe, it, expect, beforeAll, afterAll } from "vitest";
import { mkdtempSync, mkdirSync, writeFileSync, readFileSync, existsSync } from "node:fs";
import { tmpdir } from "node:os";
import { join, resolve } from "node:path";
import http from "node:http";
import url from "node:url";

const HERE = resolve(url.fileURLToPath(import.meta.url), "..");
const FITTING = resolve(HERE, "..", "fittings", "seed", "kanban-loop");

const KANBAN_DIR = mkdtempSync(join(tmpdir(), "ws2tools-kanban-"));
const GARRISON_HOME = mkdtempSync(join(tmpdir(), "ws2tools-home-"));
const RUNS_DIR = mkdtempSync(join(tmpdir(), "ws2tools-runs-"));
process.env.GARRISON_KANBAN_DIR = KANBAN_DIR;
process.env.GARRISON_HOME = GARRISON_HOME;
process.env.GARRISON_RUNS_DIR = RUNS_DIR;
process.env.GARRISON_POLICY_PATH = "/nonexistent/garrison-policy.json";

// @ts-ignore — pure .mjs
import { makeRequestHandler } from "../fittings/seed/kanban-loop/scripts/server.mjs";
// @ts-ignore
import { seedBoard } from "../fittings/seed/kanban-loop/scripts/kanban.mjs";
// @ts-ignore
import { saveBoard, createCard } from "../fittings/seed/kanban-loop/lib/board.mjs";
// @ts-ignore — pure .mjs
import { kanbanAvailable, callFetchEvidence, callCreateContinuation } from "../fittings/seed/mcp-gateway/scripts/lib/tools.mjs";

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
  // Benign stub gateway so any auto-dispatch on a plan move resolves quietly.
  gateway = http.createServer((req, res) => {
    if (req.method === "POST") {
      res.writeHead(200, { "content-type": "text/event-stream" });
      res.write(`event: done\ndata: ${JSON.stringify({ reply: "" })}\n\n`);
      return res.end();
    }
    res.writeHead(200);
    res.end("ok");
  });
  const gatewayUrl = `http://127.0.0.1:${await listen(gateway)}`;
  const opts = { root: KANBAN_DIR, cwd: KANBAN_DIR, gatewayUrl, cap: 10 };
  server = http.createServer(makeRequestHandler(opts, join(FITTING, "dist")));
  base = `http://127.0.0.1:${await listen(server)}`;
  // The tools discover the board from ~/.garrison/ui-fittings/kanban-loop.json.
  mkdirSync(join(GARRISON_HOME, "ui-fittings"), { recursive: true });
  writeFileSync(join(GARRISON_HOME, "ui-fittings", "kanban-loop.json"), JSON.stringify({ url: base }));
});

afterAll(async () => {
  await new Promise<void>((r) => server.close(() => r()));
  await new Promise<void>((r) => gateway.close(() => r()));
});

async function jsend(method: string, path: string, body?: unknown) {
  const r = await fetch(base + path, {
    method,
    headers: { "content-type": "application/json" },
    body: body === undefined ? undefined : JSON.stringify(body)
  });
  return { status: r.status, body: (await r.json().catch(() => ({}))) as any };
}

describe("WS2 — POST /cards accepts continues", () => {
  it("a continuation card carries continues + origin 'continuation'", async () => {
    const parent = await createCard(KANBAN_DIR, { list: "done", title: "Predecessor", project: "garrison" });
    const create = await jsend("POST", "/cards", { title: "Successor", project: "garrison", continues: parent.id });
    expect(create.status).toBe(201);
    const got = await jsend("GET", `/cards/${create.body.card.id}`);
    expect(got.body.card.continues).toBe(parent.id);
    expect(got.body.card.origin).toBe("continuation");
  });
});

describe("WS2 — fetch_evidence tool + fetch-log", () => {
  it("kanbanAvailable() is true when the board status file is present", () => {
    expect(kanbanAvailable()).toBe(true);
  });

  it("pulls a card artifact as raw text and appends the board fetch-log", async () => {
    const card = await createCard(KANBAN_DIR, { list: "done", title: "Has brief", project: "garrison" });
    // A card-owned brief is servable via the "brief" ref without a runDir.
    mkdirSync(join(KANBAN_DIR, "cards", card.id), { recursive: true });
    writeFileSync(join(KANBAN_DIR, "cards", card.id, "brief.md"), "# The brief\n\ndecided approach X\n");

    const out = await callFetchEvidence({ card_id: card.id, artifact_ref: "brief" });
    expect(out.truncated).toBe(false);
    expect(out.content).toContain("decided approach X");

    // The serve appended a fetch-log line (WS5 dependency).
    const logFile = join(KANBAN_DIR, "cards", card.id, "fetch-log.jsonl");
    // give the fire-and-forget append a tick
    await new Promise((r) => setTimeout(r, 50));
    expect(existsSync(logFile)).toBe(true);
    const lines = readFileSync(logFile, "utf8").trim().split("\n").filter(Boolean).map((l) => JSON.parse(l));
    expect(lines.some((e) => e.ref === "brief")).toBe(true);
  });

  it("caps an oversized artifact with a truncation note", async () => {
    const card = await createCard(KANBAN_DIR, { list: "done", title: "Big brief", project: "garrison" });
    mkdirSync(join(KANBAN_DIR, "cards", card.id), { recursive: true });
    writeFileSync(join(KANBAN_DIR, "cards", card.id, "brief.md"), "x".repeat(60 * 1024));
    const out = await callFetchEvidence({ card_id: card.id, artifact_ref: "brief" });
    expect(out.truncated).toBe(true);
    expect(out.content).toContain("truncated at");
  });
});

describe("WS2 — create_continuation tool", () => {
  it("registers a successor card chained to the predecessor", async () => {
    const parent = await createCard(KANBAN_DIR, { list: "done", title: "Parent run", project: "garrison" });
    const res = await callCreateContinuation({ card_id: parent.id, title: "Keep going" });
    expect(res.id).toBeTruthy();
    expect(res.url).toContain(res.id);
    const got = await jsend("GET", `/cards/${res.id}`);
    expect(got.body.card.continues).toBe(parent.id);
    expect(got.body.card.origin).toBe("continuation");
  });
});
