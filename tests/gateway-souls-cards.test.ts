// D19 in SOULS MODE — "EVERY task-shaped turn is a card" now holds for the
// orchestrator+souls gateway (gateway.mjs), not just PTY mode (gateway-pty.mjs).
// A web-channel ask must produce a board card: significant → registered in Plan,
// the reply carries the card link and the turn is NOT forwarded to the
// orchestrator; trivial → a quick card in Implement; conversation / engine
// channels / context-bearing turns → no card.
//
// These tests spawn the REAL gateway.mjs in souls mode against a stub board.
// The orchestrator PTY never boots in this environment (spawn fails and is
// caught) — which is exactly the point: the card path must not depend on it.
import { describe, it, expect, beforeAll, afterAll } from "vitest";
import http from "node:http";
import path from "node:path";
import { spawn, type ChildProcess } from "node:child_process";
import { mkdtempSync, writeFileSync, mkdirSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";

const ROOT = path.resolve(__dirname, "..");
const GATEWAY = path.join(ROOT, "fittings/seed/http-gateway/scripts/gateway.mjs");

// A stub board: POST /cards returns an id at rev 0; PATCH moves the card + bumps
// the rev; GET returns the current rev+list. Records every POST body + PATCH move.
function stubBoard() {
  const state = { rev: 0, list: "backlog" };
  const posts: any[] = [];
  const patches: { list: string; engine: boolean }[] = [];
  const server = http.createServer((req, res) => {
    const send = (code: number, body: unknown) => {
      res.writeHead(code, { "content-type": "application/json" });
      res.end(JSON.stringify(body));
    };
    if (req.method === "POST" && req.url === "/cards") {
      let raw = "";
      req.on("data", (c) => (raw += c));
      req.on("end", () => {
        posts.push(JSON.parse(raw || "{}"));
        send(201, { card: { id: "01SOULSCARD000000000000000", rev: state.rev } });
      });
      return;
    }
    if (req.method === "GET" && req.url?.startsWith("/cards/")) {
      return send(200, { card: { id: "01SOULSCARD000000000000000", rev: state.rev, list: state.list } });
    }
    if (req.method === "PATCH" && req.url?.startsWith("/cards/")) {
      let raw = "";
      req.on("data", (c) => (raw += c));
      req.on("end", () => {
        const body = JSON.parse(raw || "{}");
        patches.push({ list: body.list, engine: typeof req.headers["x-garrison-engine"] === "string" });
        state.list = body.list;
        state.rev += 1;
        send(200, { card: { id: "01SOULSCARD000000000000000", rev: state.rev, list: state.list } });
      });
      return;
    }
    send(404, { error: "nope" });
  });
  return { server, posts, patches, state };
}

async function freePort(): Promise<number> {
  return new Promise((resolve) => {
    const s = http.createServer();
    s.listen(0, "127.0.0.1", () => {
      const p = (s.address() as { port: number }).port;
      s.close(() => resolve(p));
    });
  });
}

let home: string;
let compositionDir: string;
let board: ReturnType<typeof stubBoard>;
let gw: ChildProcess | null = null;
let gwPort: number;

async function waitForHealth(port: number, timeoutMs = 15000) {
  const deadline = Date.now() + timeoutMs;
  while (Date.now() < deadline) {
    try {
      const r = await fetch(`http://127.0.0.1:${port}/health`);
      if (r.ok) return;
    } catch { /* not up yet */ }
    await new Promise((r) => setTimeout(r, 200));
  }
  throw new Error("gateway /health never came up");
}

beforeAll(async () => {
  home = mkdtempSync(path.join(tmpdir(), "gh-souls-"));
  compositionDir = mkdtempSync(path.join(tmpdir(), "gcomp-souls-"));
  mkdirSync(path.join(home, "ui-fittings"), { recursive: true });
  board = stubBoard();
  await new Promise<void>((r) => board.server.listen(0, "127.0.0.1", () => r()));
  const bp = (board.server.address() as { port: number }).port;
  writeFileSync(
    path.join(home, "ui-fittings", "kanban-loop.json"),
    JSON.stringify({ fittingId: "kanban-loop", url: `http://127.0.0.1:${bp}`, port: bp })
  );
  gwPort = await freePort();
  gw = spawn(process.execPath, [GATEWAY], {
    env: {
      ...process.env,
      GARRISON_HOME: home,
      GARRISON_COMPOSITION_DIR: compositionDir,
      GARRISON_GATEWAY_PORT: String(gwPort),
      GARRISON_GATEWAY_HOST: "127.0.0.1",
      // Minimal souls config: enough to select orchestrator mode. The
      // orchestrator spawn itself fails in this env and is caught — the card
      // path must work without it.
      GARRISON_SOULS_CONFIG: JSON.stringify({ orchestratorFittingId: "orchestrator", orchestrator: null, souls: {} })
    },
    stdio: ["ignore", "pipe", "pipe"]
  });
  await waitForHealth(gwPort);
}, 30000);

afterAll(async () => {
  try { gw?.kill("SIGTERM"); } catch { /* ignore */ }
  await new Promise((r) => setTimeout(r, 300));
  try { gw?.kill("SIGKILL"); } catch { /* ignore */ }
  board.server.close();
  rmSync(home, { recursive: true, force: true });
  rmSync(compositionDir, { recursive: true, force: true });
});

function chat(body: Record<string, unknown>) {
  return fetch(`http://127.0.0.1:${gwPort}/chat`, {
    method: "POST",
    headers: { "content-type": "application/json" },
    body: JSON.stringify(body)
  });
}

describe("souls-mode D19 carding (web channel → board card)", () => {
  it("registers a significant task-shaped web turn in Plan and replies with the card link (no orchestrator needed)", async () => {
    board.posts.length = 0;
    board.patches.length = 0;
    board.state.list = "backlog";
    const message =
      "Implement a slugify(text) utility in src/slugify.mjs with unit tests covering spaces, punctuation and repeated hyphens, exported as a named export.";
    const res = await chat({ message, channel: "web", sessionId: "thread-sig-1" });
    expect(res.status).toBe(200);
    const out: any = await res.json();
    expect(out.card).toBe("01SOULSCARD000000000000000");
    expect(String(out.reply)).toContain("Registered as a run");
    expect(String(out.reply)).toContain("/#/cards/01SOULSCARD000000000000000");
    expect(board.posts.length).toBe(1);
    expect(board.posts[0].origin).toBe("orchestrator");
    expect(board.posts[0].quick).toBeUndefined();
    expect(board.patches.some((p) => p.list === "plan" && p.engine)).toBe(true);
  });

  it("registers a trivial task-shaped turn as a quick card in Implement", async () => {
    board.posts.length = 0;
    board.patches.length = 0;
    board.state.list = "backlog";
    // Short + no deep keywords → T0-trivial → quick card; the inline forward then
    // fails (no orchestrator in this env) and the card honestly stays in Implement.
    await chat({ message: "fix the login bug now", channel: "web", sessionId: "thread-quick-1" });
    expect(board.posts.length).toBe(1);
    expect(board.posts[0].quick).toBe(true);
    expect(board.patches.some((p) => p.list === "implement" && p.engine)).toBe(true);
    expect(board.patches.some((p) => p.list === "done")).toBe(false);
  });

  it("never cards plain conversation", async () => {
    board.posts.length = 0;
    await chat({ message: "you good?", channel: "web", sessionId: "thread-conv-1" });
    expect(board.posts.length).toBe(0);
  });

  it("never cards engine/system channels or context-bearing turns", async () => {
    board.posts.length = 0;
    await chat({
      message: "Implement the next phase of the run with the full end-to-end pipeline as planned.",
      channel: "kanban",
      sessionId: "engine-1"
    });
    await chat({
      message: "Implement a full end-to-end refactor of the settings page with tests and documentation updates.",
      channel: "web",
      sessionId: "thread-ctx-1",
      context: { kind: "discuss", cardId: "01SOMECARD" }
    });
    expect(board.posts.length).toBe(0);
  });
});
