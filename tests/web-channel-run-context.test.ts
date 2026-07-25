// Web Channel run context - SERVER side (contract:
// docs/decisions/2026-07-25-web-channel-run-context.md §3, §10, §11, §12).
//
// Three things are pinned here, and the third is why this file drives the REAL
// server over HTTP instead of only unit-testing the helpers:
//   1. the pure wire helpers (buildGatewayChatBody's back-compat shape, the pin
//      merge including an explicit-null clear, frame -> RouteAttribution naming);
//   2. that a whole turn is persisted - the user's pins AND the assistant's
//      attribution - and that the three FAILURE shapes (error frame, upstream >= 400,
//      stream end without a done) persist the ask instead of losing it;
//   3. that the same-origin proxies (/api/route-options, /api/chat/interrupt,
//      /api/threads/:id/routing) behave when their upstreams are down: an options
//      read must degrade a dimension to read-only, never fail the chat surface.
//
// A fake gateway and a fake kanban board stand in for the real fittings; the board is
// discovered exactly as production does it, through ~/.garrison/ui-fittings.

import { describe, it, expect, beforeAll, afterAll } from "vitest";
import fs from "node:fs";
import http from "node:http";
import os from "node:os";
import path from "node:path";

const TMP_HOME = fs.mkdtempSync(path.join(os.tmpdir(), "wc-runctx-"));
process.env.GARRISON_HOME = TMP_HOME;

// server.mjs + threads.mjs freeze their dirs from GARRISON_HOME at module load and
// static imports hoist above the assignment above, so load them dynamically.
// @ts-ignore - pure .mjs server
const server = await import("../fittings/seed/web-channel-default/scripts/server.mjs");
// @ts-ignore - pure .mjs store
const threads = await import("../fittings/seed/web-channel-default/scripts/threads.mjs");

const { buildGatewayChatBody, mergeTurnRouting, attributionFromFrame, startServer } = server as any;
// The shared ambient declaration for threads.mjs (tests/web-channel-mjs.d.ts) predates
// the run-context contract and does not know setThreadRouting, so reach it through a
// narrow local view rather than widening a file this change does not own.
const store = threads as unknown as {
  setThreadRouting(id: string, routing: unknown): Promise<Record<string, unknown> | null>;
};

// ── fake gateway ─────────────────────────────────────────────────────────────
type TurnScript = { status?: number; frames?: string[] };
let turnScript: TurnScript = {};
let lastChatBody: any = null;
let lastInterruptBody: any = null;
let routeOptionsMode: "ok" | "fail" = "ok";
let routeOptionsHits = 0;

const sse = (event: string, data: unknown) => `event: ${event}\ndata: ${JSON.stringify(data)}\n\n`;

const GATEWAY_ROUTE_OPTIONS = {
  targets: [{ id: "sonnet-plan", runtime: "agent-sdk", provider: "anthropic", model: "claude-sonnet-4-5", effort: "high", account: null }],
  duties: [{ id: "build", title: "Build", levels: [{ n: 2, description: "standard" }] }],
  selectedDuties: ["build"],
  efforts: ["low", "medium", "high", "xhigh", "max"],
  accounts: [{ name: "work", platform: "anthropic" }],
  account: { name: "work", source: "process" },
  primaryRuntime: "agent-sdk",
  activeProfile: "balanced",
};

function readBody(req: http.IncomingMessage): Promise<string> {
  return new Promise((resolve) => {
    let raw = "";
    req.on("data", (c) => { raw += c; });
    req.on("end", () => resolve(raw));
  });
}

let gateway: http.Server;
let board: http.Server;
let boardStatusFile = "";
let webPort = 0;
let webServer: http.Server;

beforeAll(async () => {
  gateway = http.createServer(async (req, res) => {
    const url = req.url || "";
    if (url.startsWith("/chat/stream") && req.method === "POST") {
      lastChatBody = JSON.parse((await readBody(req)) || "{}");
      if (turnScript.status && turnScript.status >= 400) {
        res.statusCode = turnScript.status;
        res.end(JSON.stringify({ error: "gateway said no" }));
        return;
      }
      res.writeHead(200, { "Content-Type": "text/event-stream" });
      for (const frame of turnScript.frames ?? []) res.write(frame);
      res.end();
      return;
    }
    if (url.startsWith("/chat/interrupt") && req.method === "POST") {
      lastInterruptBody = JSON.parse((await readBody(req)) || "{}");
      res.writeHead(200, { "Content-Type": "application/json" });
      res.end(JSON.stringify({ ok: true, lane: "agent-sdk" }));
      return;
    }
    if (url.startsWith("/route/options") && req.method === "GET") {
      routeOptionsHits += 1;
      if (routeOptionsMode === "fail") {
        res.statusCode = 503;
        res.end(JSON.stringify({ error: "no operative" }));
        return;
      }
      res.writeHead(200, { "Content-Type": "application/json" });
      res.end(JSON.stringify(GATEWAY_ROUTE_OPTIONS));
      return;
    }
    res.statusCode = 404;
    res.end("{}");
  });
  await new Promise<void>((r) => gateway.listen(0, "127.0.0.1", r));

  board = http.createServer((req, res) => {
    const url = req.url || "";
    if (url.startsWith("/projects")) {
      res.writeHead(200, { "Content-Type": "application/json" });
      res.end(JSON.stringify({ devRoot: "/home/x/dev", projects: [{ name: "garrison", path: "/home/x/dev/garrison" }, { name: "ekoa", path: "/home/x/dev/ekoa" }] }));
      return;
    }
    if (url.startsWith("/cards")) {
      res.writeHead(200, { "Content-Type": "application/json" });
      res.end(JSON.stringify({ cards: [] }));
      return;
    }
    res.statusCode = 404;
    res.end("{}");
  });
  await new Promise<void>((r) => board.listen(0, "127.0.0.1", r));

  // Board discovery: exactly the production path (a ui-fittings status file), never a
  // hardcoded port.
  fs.mkdirSync(path.join(TMP_HOME, "ui-fittings"), { recursive: true });
  boardStatusFile = path.join(TMP_HOME, "ui-fittings", "kanban-loop.json");
  fs.writeFileSync(boardStatusFile, JSON.stringify({ url: `http://127.0.0.1:${(board.address() as any).port}` }));

  const started = await startServer({
    port: 0,
    host: "127.0.0.1",
    gatewayUrl: `http://127.0.0.1:${(gateway.address() as any).port}`,
  });
  webServer = started.server;
  if (!webServer.listening) await new Promise<void>((r) => webServer.once("listening", () => r()));
  webPort = (webServer.address() as any).port;
});

afterAll(async () => {
  await new Promise<void>((r) => webServer.close(() => r()));
  await new Promise<void>((r) => gateway.close(() => r()));
  await new Promise<void>((r) => board.close(() => r()));
  try { fs.rmSync(TMP_HOME, { recursive: true, force: true }); } catch {}
});

const api = (p: string) => `http://127.0.0.1:${webPort}${p}`;

// Drive one full turn: POST /api/chat and drain the SSE body (the proxy runs the turn
// to done server-side, so draining is enough to know the upstream finished).
async function runTurn(body: Record<string, unknown>) {
  const res = await fetch(api("/api/chat"), {
    method: "POST",
    headers: { "content-type": "application/json", accept: "text/event-stream" },
    body: JSON.stringify(body),
  });
  const text = await res.text();
  return { status: res.status, text };
}

// Persistence is fire-and-forget (the reply must not wait on a disk write), so poll.
async function waitForMessages(id: string, count: number) {
  for (let i = 0; i < 60; i++) {
    const t: any = await threads.getThread(id);
    if (Array.isArray(t?.messages) && t.messages.length >= count) return t;
    await new Promise((r) => setTimeout(r, 25));
  }
  const t: any = await threads.getThread(id);
  throw new Error(`thread ${id} never reached ${count} messages (got ${t?.messages?.length ?? 0})`);
}

describe("buildGatewayChatBody - routing + turnSeq are additive", () => {
  it("keeps the pinned back-compat shape: no context, no mode, no pins → EXACTLY { message, channel }", () => {
    expect(buildGatewayChatBody({ message: "hi" })).toEqual({ message: "hi", channel: "web" });
    // An EMPTY pin object is the common case for an unpinned conversation; it must not
    // add a key, or every legacy body changes shape.
    expect(buildGatewayChatBody({ message: "hi", routing: {} })).toEqual({ message: "hi", channel: "web" });
    expect(buildGatewayChatBody({ message: "hi", routing: null, turnSeq: null })).toEqual({ message: "hi", channel: "web" });
    expect(buildGatewayChatBody({ message: "hi", routing: [], turnSeq: 1.5 })).toEqual({ message: "hi", channel: "web" });
    expect(buildGatewayChatBody({ message: "hi", turnSeq: -1 })).toEqual({ message: "hi", channel: "web" });
  });

  it("emits routing + turnSeq when present (turnSeq 0 is a real value, not absent)", () => {
    expect(buildGatewayChatBody({ message: "go", routing: { target: "sonnet-plan", effort: "low" }, turnSeq: 0 })).toEqual({
      message: "go",
      channel: "web",
      routing: { target: "sonnet-plan", effort: "low" },
      turnSeq: 0,
    });
    expect(buildGatewayChatBody({ message: "go", sessionId: "T-1", turnSeq: 7 })).toEqual({
      message: "go",
      channel: "web",
      sessionId: "T-1",
      turnSeq: 7,
    });
  });
});

describe("mergeTurnRouting - per-turn over the conversation pin", () => {
  it("lays the per-turn pins over the persisted ones", () => {
    expect(mergeTurnRouting({ target: "sonnet-plan", effort: "high" }, { effort: "low" })).toEqual({
      target: "sonnet-plan",
      effort: "low",
    });
    expect(mergeTurnRouting(null, { duty: "build", level: 3 })).toEqual({ duty: "build", level: 3 });
    expect(mergeTurnRouting({ project: "garrison" }, null)).toEqual({ project: "garrison" });
    expect(mergeTurnRouting(null, null)).toBeNull();
    expect(mergeTurnRouting({}, {})).toBeNull();
  });

  it("an explicit null CLEARS that dimension for this turn only", () => {
    expect(mergeTurnRouting({ target: "sonnet-plan", effort: "high" }, { effort: null })).toEqual({ target: "sonnet-plan" });
    // Clearing the only pinned dimension yields no pins at all, so the body stays the
    // legacy shape rather than carrying an empty routing object.
    expect(mergeTurnRouting({ effort: "high" }, { effort: null })).toBeNull();
    // Clearing something that was never pinned is a no-op, not an error.
    expect(mergeTurnRouting({ effort: "high" }, { project: null })).toEqual({ effort: "high" });
  });

  it("drops non-pinnable and hostile keys from both sides", () => {
    // `runtime`/`via` are RESOLVED fields, never pinnable (contract §2).
    expect(mergeTurnRouting({ runtime: "codex" }, { via: "turn-override" })).toBeNull();
    // Parsed from JSON so `__proto__` is a real own key, the shape an HTTP body has.
    const hostile = JSON.parse('{"effort":"low","__proto__":null,"constructor":null}');
    expect(mergeTurnRouting({ target: "a" }, hostile)).toEqual({ target: "a", effort: "low" });
    expect(({} as any).polluted).toBeUndefined();
  });
});

describe("attributionFromFrame - wire spellings to RouteAttribution", () => {
  it("aliases the snake_case wire fields and drops everything unlisted", () => {
    expect(
      attributionFromFrame({
        reply: "the whole answer text",
        route: "sonnet-plan",
        runtime: "agent-sdk",
        session_id: "sess-123",
        transcript_path: "/home/x/.claude/projects/p/sess-123.jsonl",
        stopped_by_user: true,
        stopped_reason: "cancelled",
      }),
    ).toEqual({
      route: "sonnet-plan",
      runtime: "agent-sdk",
      sessionId: "sess-123",
      transcriptPath: "/home/x/.claude/projects/p/sess-123.jsonl",
      stoppedByUser: true,
      stoppedReason: "cancelled",
    });
  });

  it("prefers an explicit camelCase field over its wire alias, and reports nothing as null", () => {
    expect(attributionFromFrame({ sessionId: "new", session_id: "old" })).toEqual({ sessionId: "new" });
    expect(attributionFromFrame({ reply: "text only" })).toBeNull();
    expect(attributionFromFrame(null)).toBeNull();
    expect(attributionFromFrame("done")).toBeNull();
  });
});

describe("POST /api/chat - pins forwarded, whole turn persisted", () => {
  it("merges the thread pin under the per-turn routing, forwards it, and persists both sides", async () => {
    const id = "chat-forward";
    await threads.ensureThread({ id });
    await store.setThreadRouting(id, { target: "sonnet-plan", effort: "high", account: "work" });
    turnScript = {
      frames: [
        // Pre-turn frame (pending) then the done frame: the merge means a field known
        // only pre-turn survives onto the persisted message.
        sse("route", { route: "sonnet-plan", runtime: "agent-sdk", duty: "build", level: 2, pending: true, turnSeq: 3 }),
        sse("chunk", { text: "working" }),
        sse("done", { reply: "shipped it", model: "claude-sonnet-4-5", effort: "low", effortApplied: true, session_id: "sess-abc", overridesApplied: ["effort"] }),
      ],
    };

    const { status, text } = await runTurn({ message: "ship it", thread: id, routing: { effort: "low", account: null }, turnSeq: 3 });
    expect(status).toBe(200);
    expect(text).toContain("event: done");

    // Forwarded body: per-turn effort wins, the null clears the account pin, the
    // thread's target survives, and the thread id is still the gateway session key.
    expect(lastChatBody.routing).toEqual({ target: "sonnet-plan", effort: "low" });
    expect(lastChatBody.turnSeq).toBe(3);
    expect(lastChatBody.channel).toBe("web");
    expect(lastChatBody.sessionId).toBe(id);

    const t = await waitForMessages(id, 2);
    // The ask carries the INTENT that was in force...
    expect(t.messages[0]).toMatchObject({ role: "user", text: "ship it", overrides: { target: "sonnet-plan", effort: "low" } });
    // ...and the reply carries what actually RAN, pre-turn frame folded in.
    expect(t.messages[1].role).toBe("assistant");
    expect(t.messages[1].text).toBe("shipped it");
    expect(t.messages[1].route).toMatchObject({
      route: "sonnet-plan",
      runtime: "agent-sdk",
      duty: "build",
      level: 2,
      model: "claude-sonnet-4-5",
      effort: "low",
      effortApplied: true,
      sessionId: "sess-abc",
      overridesApplied: ["effort"],
    });
    // Back-compat: the thread-level session id is still written, so
    // /api/session-stream?thread=<id> keeps working without a message id.
    expect(t.claudeSessionId).toBe("sess-abc");
  });

  it("an unpinned turn forwards NO routing/turnSeq keys at all", async () => {
    const id = "chat-unpinned";
    turnScript = { frames: [sse("done", { reply: "plain" })] };
    await runTurn({ message: "hello", thread: id });
    expect(Object.hasOwn(lastChatBody, "routing")).toBe(false);
    expect(Object.hasOwn(lastChatBody, "turnSeq")).toBe(false);
    const t = await waitForMessages(id, 2);
    expect(t.messages[0].overrides).toBeUndefined();
    expect(t.messages[1].route).toBeUndefined(); // nothing to attribute, so no fake badge
  });
});

describe("POST /api/chat - failure persistence (the ask is never lost)", () => {
  it("persists on an `error` frame, keeping the pre-turn attribution", async () => {
    const id = "chat-fail-error";
    turnScript = {
      frames: [
        sse("route", { route: "codex-fast", runtime: "codex", duty: "build", pending: true }),
        sse("error", { error: "runtime exploded" }),
      ],
    };
    await runTurn({ message: "do the thing", thread: id });
    const t = await waitForMessages(id, 2);
    expect(t.messages[0]).toMatchObject({ role: "user", text: "do the thing" });
    expect(t.messages[1].text).toContain("Turn did not complete");
    expect(t.messages[1].text).toContain("runtime exploded");
    expect(t.messages[1].route).toMatchObject({ runtime: "codex", duty: "build", stoppedReason: "runtime exploded" });
    // The pre-turn `pending` marker must NOT survive onto a settled failure.
    expect(t.messages[1].route.pending).toBeUndefined();
  });

  it("persists when the gateway answers >= 400 (no frames at all)", async () => {
    const id = "chat-fail-400";
    turnScript = { status: 503 };
    const { text } = await runTurn({ message: "upstream is down", thread: id });
    expect(text).toContain("upstream 503");
    const t = await waitForMessages(id, 2);
    expect(t.messages[1].text).toContain("upstream 503");
    // No route frame ever arrived, so there is no attribution to invent - only the
    // reason survives.
    expect(t.messages[1].route).toEqual({ stoppedReason: "upstream 503" });
  });

  it("persists when the stream ends without a done frame", async () => {
    const id = "chat-fail-truncated";
    turnScript = { frames: [sse("chunk", { text: "half an answ" })] };
    await runTurn({ message: "truncated", thread: id });
    const t = await waitForMessages(id, 2);
    expect(t.messages[1].text).toContain("ended without a done event");
  });

  it("a normal done latches the persist, so the stream end does NOT add a failure note", async () => {
    const id = "chat-latch";
    turnScript = { frames: [sse("done", { reply: "all good" })] };
    await runTurn({ message: "fine", thread: id });
    const t = await waitForMessages(id, 2);
    // Wait past any late write, then assert the count is still exactly two.
    await new Promise((r) => setTimeout(r, 120));
    const after: any = await threads.getThread(id);
    expect(after.messages).toHaveLength(2);
    expect(after.messages[1].text).toBe("all good");
    void t;
  });
});

describe("GET /api/route-options - one read, degrades per dimension", () => {
  it("merges the gateway options with the board's project names", async () => {
    const r = await fetch(api("/api/route-options?refresh=1"));
    expect(r.status).toBe(200);
    const j: any = await r.json();
    expect(j.targets).toHaveLength(1);
    expect(j.efforts).toEqual(["low", "medium", "high", "xhigh", "max"]);
    expect(j.duties[0].id).toBe("build");
    expect(j.account).toEqual({ name: "work", source: "process" });
    // Projects come from the BOARD (never re-scanned here) as bare names - a pin is a
    // dev-root child NAME, and an absolute host path is useless on a phone.
    expect(j.projects).toEqual(["garrison", "ekoa"]);
    expect(j.sources).toEqual({ gateway: true, board: true });
  });

  it("caches briefly so opening a menu is not a fan-out", async () => {
    const before = routeOptionsHits;
    await fetch(api("/api/route-options"));
    await fetch(api("/api/route-options"));
    expect(routeOptionsHits).toBe(before); // both served from the cache
    // ...and refresh=1 bypasses it.
    await fetch(api("/api/route-options?refresh=1"));
    expect(routeOptionsHits).toBe(before + 1);
  });

  it("board down → projects: [] and the rest of the options still answer", async () => {
    fs.rmSync(boardStatusFile);
    try {
      const j: any = await (await fetch(api("/api/route-options?refresh=1"))).json();
      expect(j.projects).toEqual([]);
      expect(j.sources).toEqual({ gateway: true, board: false });
      expect(j.targets).toHaveLength(1); // the chat surface is never blocked by this read
    } finally {
      fs.writeFileSync(boardStatusFile, JSON.stringify({ url: `http://127.0.0.1:${(board.address() as any).port}` }));
    }
  });

  it("gateway down → empty (read-only) routing dimensions, projects still listed", async () => {
    routeOptionsMode = "fail";
    try {
      const j: any = await (await fetch(api("/api/route-options?refresh=1"))).json();
      expect(j.targets).toEqual([]);
      expect(j.efforts).toEqual([]);
      expect(j.accounts).toEqual([]);
      expect(j.account).toBeNull();
      expect(j.projects).toEqual(["garrison", "ekoa"]);
      expect(j.sources).toEqual({ gateway: false, board: true });
    } finally {
      routeOptionsMode = "ok";
    }
  });
});

describe("POST /api/chat/interrupt - the thread id IS the gateway session key", () => {
  it("forwards the thread id as sessionId", async () => {
    const r = await fetch(api("/api/chat/interrupt"), {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify({ thread: "chat-forward" }),
    });
    expect(r.status).toBe(200);
    expect(await r.json()).toEqual({ ok: true, lane: "agent-sdk" });
    expect(lastInterruptBody).toEqual({ sessionId: "chat-forward" });
  });

  it("an explicit sessionId wins, and a threadless turn falls back to the channel name", async () => {
    await fetch(api("/api/chat/interrupt"), {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify({ sessionId: " sess-explicit ", thread: "ignored" }),
    });
    expect(lastInterruptBody).toEqual({ sessionId: "sess-explicit" });
    await fetch(api("/api/chat/interrupt"), { method: "POST", headers: { "content-type": "application/json" }, body: "{}" });
    expect(lastInterruptBody).toEqual({ sessionId: "web" });
  });
});

describe("GET/PUT /api/threads/:id/routing - autosave pin, no Save button", () => {
  it("round-trips a pin and clears it", async () => {
    const id = "chat-pin-http";
    await threads.ensureThread({ id });
    expect(await (await fetch(api(`/api/threads/${id}/routing`))).json()).toEqual({ routing: null });

    const put = await fetch(api(`/api/threads/${id}/routing`), {
      method: "PUT",
      headers: { "content-type": "application/json" },
      // Non-pinnable fields are dropped by the store, not accepted and ignored later.
      body: JSON.stringify({ routing: { target: "opus-plan", level: "3", runtime: "codex" } }),
    });
    expect(await put.json()).toEqual({ routing: { target: "opus-plan", level: 3 } });
    expect(await (await fetch(api(`/api/threads/${id}/routing`))).json()).toEqual({ routing: { target: "opus-plan", level: 3 } });

    // A bare pin object (no envelope) is accepted rather than read as "clear".
    const bare = await fetch(api(`/api/threads/${id}/routing`), {
      method: "PUT",
      headers: { "content-type": "application/json" },
      body: JSON.stringify({ effort: "max" }),
    });
    expect(await bare.json()).toEqual({ routing: { effort: "max" } });

    const cleared = await fetch(api(`/api/threads/${id}/routing`), {
      method: "PUT",
      headers: { "content-type": "application/json" },
      body: JSON.stringify({ routing: null }),
    });
    expect(await cleared.json()).toEqual({ routing: null });
  });

  it("404s for a thread that does not exist (a pin never conjures one)", async () => {
    expect((await fetch(api("/api/threads/chat-nope/routing"))).status).toBe(404);
    const put = await fetch(api("/api/threads/chat-nope/routing"), {
      method: "PUT",
      headers: { "content-type": "application/json" },
      body: JSON.stringify({ routing: { effort: "max" } }),
    });
    expect(put.status).toBe(404);
    expect(threads.threadExistsSync("chat-nope")).toBe(false);
  });
});
