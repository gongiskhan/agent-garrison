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
const server = await import("../packages/talk/src/server.mjs");
// @ts-ignore - pure .mjs store
const threads = await import("../packages/talk/src/threads.mjs");

const { buildGatewayChatBody, agentSdkResumeFromThread, mergeTurnRouting, attributionFromFrame, startServer } = server as any;
// The shared ambient declaration for threads.mjs (tests/web-channel-mjs.d.ts) predates
// the run-context contract and does not know setThreadRouting, so reach it through a
// narrow local view rather than widening a file this change does not own.
const store = threads as unknown as {
  setThreadRouting(id: string, routing: unknown): Promise<Record<string, unknown> | null>;
  setThreadRouteSession(id: string, routeSession: unknown): Promise<Record<string, unknown> | null>;
};

// ── fake gateway ─────────────────────────────────────────────────────────────
type TurnScript = { status?: number; frames?: string[]; responseBody?: Record<string, unknown> };
let turnScript: TurnScript = {};
let lastChatBody: any = null;
let lastInterruptBody: any = null;
let lastPermissionBody: any = null;
let gatewayGenerationSeq = 0;
let permissionStatus = 200;
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

const SIGNED_SONNET_ASSEMBLY = {
  version: 2,
  target: "sonnet-plan",
  runtime: "agent-sdk",
  provider: "anthropic",
  model: "claude-sonnet-4-5",
  account: null,
  accountSource: null,
  projectPath: null,
  assembly: `a1:${"a".repeat(64)}`,
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
        res.end(JSON.stringify(turnScript.responseBody ?? { error: "gateway said no" }));
        return;
      }
      res.writeHead(200, { "Content-Type": "text/event-stream" });
      res.write(sse("open", { generationId: `generation-${++gatewayGenerationSeq}`, ts: Date.now() }));
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
    if (url.startsWith("/chat/permission") && req.method === "POST") {
      lastPermissionBody = JSON.parse((await readBody(req)) || "{}");
      res.writeHead(permissionStatus, { "Content-Type": "application/json" });
      res.end(JSON.stringify(permissionStatus === 200 ? { ok: true, decision: lastPermissionBody.decision } : { error: "permission request unavailable" }));
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
  // Every admitted durable Web path owns the same M7 boundary: the gateway sees
  // the exact admitted message and no context.
  expect(lastChatBody?.message).toBe(body.message);
  expect(Object.hasOwn(lastChatBody ?? {}, "context")).toBe(false);
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

  it("ignores context without normalizing the admitted message", () => {
    const message = "  exact admitted message\nwith a second line  ";
    expect(buildGatewayChatBody({
      message,
      context: "assistant: stale history\nfetch_evidence(card_id, ref)",
    })).toEqual({ message, channel: "web" });
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

  it("forwards the server-owned effort-free logical route session", () => {
    const routeSession = {
      epoch: 3,
      signature: {
        target: "opus-plan",
        runtime: "agent-sdk",
        provider: "anthropic",
        model: "claude-opus-5",
        account: null,
        accountSource: null,
        projectPath: "/srv/garrison",
      },
    };
    expect(buildGatewayChatBody({ message: "continue", routeSession })).toEqual({
      message: "continue",
      channel: "web",
      routeSession,
    });
  });

  it("derives SDK resume only from the latest session's complete persisted attribution", () => {
    const spawnSignature = {
      version: 2,
      target: "sonnet-plan",
      runtime: "agent-sdk",
      provider: "anthropic",
      model: "claude-sonnet-4-5",
      account: "work",
      accountSource: "override",
      projectPath: "/home/u/dev/project",
      assembly: `a1:${"b".repeat(64)}`,
    };
    const route = {
      route: "sonnet-plan",
      runtime: "agent-sdk",
      provider: "anthropic",
      model: "claude-sonnet-4-5",
      effort: "high",
      account: "work",
      accountSource: "override",
      projectPath: "/home/u/dev/project",
      sessionId: "sdk-session-latest",
      spawnSignature,
    };
    const thread = {
      claudeSessionId: "sdk-session-latest",
      messages: [
        { role: "assistant", text: "older", route: { ...route, sessionId: "sdk-session-old" } },
        { role: "assistant", text: "external notice" },
        { role: "assistant", text: "latest", route },
        { role: "assistant", text: "restart note", route: { stoppedReason: "restart" } },
      ],
    };
    const candidate = agentSdkResumeFromThread(thread);
    expect(candidate).toEqual({
      sessionId: "sdk-session-latest",
      route: "sonnet-plan",
      runtime: "agent-sdk",
      provider: "anthropic",
      model: "claude-sonnet-4-5",
      effort: "high",
      account: "work",
      accountSource: "override",
      projectPath: "/home/u/dev/project",
      spawnSignature,
    });
    expect(buildGatewayChatBody({ message: "continue", agentSdkResume: candidate })).toEqual({
      message: "continue",
      channel: "web",
      agentSdkResume: candidate,
    });
    expect(agentSdkResumeFromThread({ ...thread, claudeSessionId: "unmatched" })).toBeNull();
    expect(agentSdkResumeFromThread({
      claudeSessionId: "sdk-session-latest",
      messages: [{ role: "assistant", route: { runtime: "agent-sdk", sessionId: "sdk-session-latest" } }],
    })).toBeNull();
    expect(agentSdkResumeFromThread({
      claudeSessionId: "sdk-session-latest",
      messages: [{
        role: "assistant",
        route: {
          ...route,
          spawnSignature: Object.fromEntries(
            Object.entries(spawnSignature).filter(([key]) => !["version", "assembly"].includes(key)),
          ),
        },
      }],
    })).toBeNull();

    const longProjectPath = `/${"project".repeat(350)}`;
    const fallbackRoute = {
      ...route,
      model: "claude-fallback-actual",
      projectPath: longProjectPath,
      spawnSignature: {
        version: 2,
        target: "sonnet-plan",
        runtime: "agent-sdk",
        provider: "anthropic",
        model: "claude-sonnet-requested",
        account: "work",
        accountSource: "override",
        projectPath: longProjectPath,
        assembly: `a1:${"c".repeat(64)}`,
      },
    };
    expect(agentSdkResumeFromThread({
      claudeSessionId: "sdk-session-latest",
      messages: [{ role: "assistant", route: fallbackRoute }],
    })).toEqual({
      sessionId: "sdk-session-latest",
      route: "sonnet-plan",
      runtime: "agent-sdk",
      provider: "anthropic",
      // Actual fallback remains visible on the message, while resume compares
      // the Query's requested spawn model and exact project path.
      model: "claude-sonnet-requested",
      effort: "high",
      account: "work",
      accountSource: "override",
      projectPath: longProjectPath,
      spawnSignature: fallbackRoute.spawnSignature,
    });

    // The thread's newest boundary can advance after this completed session was
    // persisted (for example, a B-assembly turn failed before completion). The
    // resume nomination remains bound to the completed assistant's A signature;
    // the gateway compares it to B rather than silently borrowing thread state.
    expect(agentSdkResumeFromThread({
      ...thread,
      routeSession: {
        epoch: 2,
        signature: { ...spawnSignature, assembly: `a1:${"d".repeat(64)}` },
      },
    })).toMatchObject({
      sessionId: "sdk-session-latest",
      spawnSignature,
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
        flow: "full-feature",
        phasesOff: "review",
        classifierSkipped: true,
        sessionBoundaryReason: null,
        session_id: "sess-123",
        transcript_path: "/home/x/.claude/projects/p/sess-123.jsonl",
        stopped_by_user: true,
        stopped_reason: "cancelled",
      }),
    ).toEqual({
      route: "sonnet-plan",
      runtime: "agent-sdk",
      flow: "full-feature",
      phasesOff: "review",
      classifierSkipped: true,
      sessionBoundaryReason: null,
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

  it("preserves an exact long absolute project path in route attribution", () => {
    const projectPath = `/${"workspace".repeat(300)}`;
    expect(attributionFromFrame({ route: "sonnet-plan", projectPath })).toEqual({
      route: "sonnet-plan",
      projectPath,
    });
    expect(attributionFromFrame({ route: "sonnet-plan", projectPath: "relative/workspace" })).toEqual({
      route: "sonnet-plan",
    });
  });
});

describe("POST /api/chat - pins forwarded, whole turn persisted", () => {
  it("merges the thread pin under the per-turn routing, forwards it, and persists both sides", async () => {
    const id = "chat-forward";
    const uiContext = { briefPath: "/visible/brief.md", seed: "must stay out of chat" };
    await threads.ensureThread({ id, context: uiContext });
    await store.setThreadRouting(id, { target: "sonnet-plan", effort: "high", account: "work" });
    turnScript = {
      frames: [
        // Pre-turn frame (pending) then the done frame: the merge means a field known
        // only pre-turn survives onto the persisted message.
        sse("route", {
          route: "sonnet-plan",
          runtime: "agent-sdk",
          provider: "anthropic",
          duty: "build",
          level: 2,
          pending: true,
          turnSeq: 3,
          sessionDisposition: "new",
          sessionBoundaryReason: "initial",
          sessionEpoch: 1,
          spawnSignature: SIGNED_SONNET_ASSEMBLY,
        }),
        sse("chunk", { text: "working" }),
        sse("done", { reply: "shipped it", model: "claude-sonnet-4-5", effort: "low", effortApplied: true, session_id: "sess-abc", overridesApplied: ["effort"] }),
      ],
    };

    const { status, text } = await runTurn({
      message: "ship it",
      thread: id,
      context: { attemptedPrefix: "must also stay out of chat" },
      routing: { effort: "low", account: null },
      turnSeq: 3,
    });
    expect(status).toBe(200);
    expect(text).toContain("event: done");

    // Forwarded body: per-turn effort wins, the null clears the account pin, the
    // thread's target survives, and the thread id is still the gateway session key.
    expect(lastChatBody.routing).toEqual({ target: "sonnet-plan", effort: "low" });
    expect(lastChatBody.turnSeq).toBe(3);
    expect(lastChatBody.channel).toBe("web");
    expect(lastChatBody.sessionId).toBe(id);

    const t = await waitForMessages(id, 2);
    expect(t.context).toEqual(uiContext);
    // The ask carries the INTENT that was in force...
    expect(t.messages[0]).toMatchObject({ role: "user", text: "ship it", overrides: { target: "sonnet-plan", effort: "low" } });
    expect(t.messages[0].turnId).toEqual(expect.any(String));
    // ...and the reply carries what actually RAN, pre-turn frame folded in.
    expect(t.messages[1].role).toBe("assistant");
    expect(t.messages[1].text).toBe("shipped it");
    expect(t.messages[1].turnId).toBe(t.messages[0].turnId);
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

    turnScript = {
      frames: [sse("done", {
        reply: "continued",
        route: "sonnet-plan",
        runtime: "agent-sdk",
        provider: "anthropic",
        model: "claude-sonnet-4-5",
        effort: "low",
        session_id: "sess-abc",
      })],
    };
    expect((await runTurn({ message: "continue", thread: id, turnSeq: 4 })).status).toBe(200);
    expect(lastChatBody.agentSdkResume).toEqual({
      sessionId: "sess-abc",
      route: "sonnet-plan",
      runtime: "agent-sdk",
      provider: "anthropic",
      model: "claude-sonnet-4-5",
      effort: "low",
      account: null,
      accountSource: null,
      projectPath: null,
      spawnSignature: SIGNED_SONNET_ASSEMBLY,
    });
  });

  it("tees canonical session_event frames unchanged and persists revisions for thread GET reload", async () => {
    const id = "chat-session-events";
    const imageData = Buffer.from("server-persisted-image").toString("base64");
    const draft = {
      id: "assistant-1",
      role: "assistant",
      ts: 1_786_880_000_000,
      turnId: "turn-events",
      sessionId: "sess-events",
      order: 0,
      revision: 0,
      blocks: [{ type: "text", text: "draft" }],
    };
    const result = {
      id: "result-1",
      role: "user",
      ts: 1_786_880_000_001,
      turnId: "turn-events",
      sessionId: "sess-events",
      order: 1,
      revision: 0,
      toolResultsOnly: true,
      blocks: [{
        type: "tool_result",
        toolUseId: "tool-1",
        isError: false,
        text: "read complete",
        images: [{ mediaType: "image/png", data: imageData }],
      }],
    };
    const settled = {
      ...draft,
      revision: 1,
      blocks: [{ type: "text", text: "canonical answer" }],
    };
    turnScript = {
      frames: [
        sse("session_event", draft),
        sse("session_event", result),
        sse("session_event", settled),
        sse("done", { reply: "canonical answer", runtime: "agent-sdk", session_id: "sess-events" }),
      ],
    };

    const turn = await runTurn({ message: "show the durable journal", thread: id });
    expect(turn.status).toBe(200);
    // The persistence seam retains the canonical payload while stamping the exact
    // Web input/gateway generation coordinates used for concurrency-safe routing.
    expect(turn.text).toContain('event: session_event');
    expect(turn.text).toContain('"id":"assistant-1"');
    expect(turn.text).toContain('"inputId":');
    expect(turn.text).toContain('"generationId":');
    const stored = await waitForMessages(id, 2);
    expect(stored.sessionEvents.map((entry: any) => entry.id)).toEqual([
      "assistant-1",
      "result-1",
      expect.stringMatching(/^terminal:/),
    ]);
    expect(stored.sessionEvents[0]).toMatchObject({ revision: 1, blocks: [{ type: "text", text: "canonical answer" }] });
    expect(stored.sessionEvents[1]).toMatchObject({ role: "user", toolResultsOnly: true });
    expect(stored.sessionEvents[1].blocks[0].images).toEqual([{ mediaType: "image/png", data: imageData }]);
    expect(stored.sessionIds).toEqual(["sess-events"]);
    expect(stored.claudeSessionId).toBe("sess-events");

    const reload: any = await (await fetch(api(`/api/threads/${id}`))).json();
    expect(reload.thread.sessionEvents).toEqual(stored.sessionEvents);
    expect(reload.thread.sessionIds).toEqual(["sess-events"]);
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

  it("rejects threadless generated Web execution before the gateway", async () => {
    const before = lastChatBody;
    const response = await fetch(api("/api/chat"), {
      method: "POST",
      headers: { "content-type": "application/json", accept: "application/json" },
      body: JSON.stringify({
        message: "legacy request",
        context: { recent: ["user: old", "assistant: old"], card: "hidden" },
      }),
    });
    expect(response.status).toBe(400);
    expect(await response.json()).toMatchObject({
      failure: {
        source: "web",
        kind: "invalid_request",
        code: "web_thread_required",
        retryable: false,
        httpStatus: 400,
      },
    });
    expect(lastChatBody).toBe(before);
  });
});

describe("POST /api/chat - failure persistence (the ask is never lost)", () => {
  it("settles a provider error result from its canonical terminal without duplicate Markdown", async () => {
    const id = "chat-provider-terminal-error";
    const generationId = `generation-${gatewayGenerationSeq + 1}`;
    const failure = {
      source: "result",
      kind: "limit",
      code: "error_max_budget_usd",
      text: "The request reached its configured budget limit.",
      retryable: false,
    };
    turnScript = {
      frames: [
        sse("session_event", {
          id: `terminal:${JSON.stringify([generationId])}`,
          role: "assistant",
          ts: Date.now(),
          generationId,
          order: 4,
          revision: 1,
          blocks: [
            { type: "error", ...failure },
            {
              type: "turn_end",
              status: "error",
              subtype: "error_max_budget_usd",
              reason: "budget_exceeded",
              stopReason: "max_budget",
              terminalReason: "blocking_limit",
            },
          ],
        }),
        // The canonical terminal is authoritative even if a malformed lifecycle
        // projection tries to substitute different failure details.
        sse("done", {
          reply: "",
          terminalStatus: "error",
          failure: { ...failure, code: "contradictory_failure", text: "wrong failure" },
          runtime: "agent-sdk",
        }),
      ],
    };
    await runTurn({ message: "bounded work", thread: id });
    const t = await waitForMessages(id, 2);
    expect(t.messages[1]).toMatchObject({ role: "assistant", text: "" });
    expect(t.sessionEvents.filter((event: any) => event.blocks.some((block: any) => block.type === "turn_end"))).toHaveLength(1);
    expect(t.inputReceipts.at(-1)).toMatchObject({
      state: "failed",
      failure,
    });
  });

  it("accepts the matching compatibility error after a canonical error terminal", async () => {
    const id = "chat-canonical-error-projection";
    const generationId = `generation-${gatewayGenerationSeq + 1}`;
    const failure = {
      source: "runtime",
      kind: "runtime",
      code: "iterator_failed",
      text: "The provider iterator failed.",
      retryable: false,
    };
    turnScript = { frames: [
      sse("session_event", {
        id: `terminal:${JSON.stringify([generationId])}`,
        role: "assistant",
        ts: Date.now(),
        generationId,
        order: 2,
        revision: 1,
        blocks: [
          { type: "error", ...failure },
          { type: "turn_end", status: "error", subtype: "iterator_failed", reason: "iterator_failed", stopReason: null, terminalReason: "runtime" },
        ],
      }),
      sse("error", { error: failure.text, failure, ...failure }),
    ] };
    const { text } = await runTurn({ message: "preserve the canonical error", thread: id });
    const t = await waitForMessages(id, 2);
    expect(text).not.toContain("gateway_stream_protocol_error");
    expect(t.messages[1].text).toBe("");
    expect(t.inputReceipts.at(-1)).toMatchObject({ state: "failed", failure });
    expect(t.sessionEvents).toHaveLength(1);
    expect(t.sessionEvents[0]).toMatchObject({ revision: 1, blocks: [
      { type: "error", ...failure },
      { type: "turn_end", status: "error" },
    ] });
  });

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
    expect(t.messages[1].text).toBe("");
    expect(t.messages[1].route).toMatchObject({ runtime: "codex", duty: "build", stoppedReason: "runtime exploded" });
    // The pre-turn `pending` marker must NOT survive onto a settled failure.
    expect(t.messages[1].route.pending).toBeUndefined();
    expect(t.sessionEvents.at(-1)).toMatchObject({
      blocks: [
        { type: "error", text: "runtime exploded" },
        { type: "turn_end", status: "error" },
      ],
    });
    expect(t.inputReceipts.at(-1)).toMatchObject({
      state: "failed",
      failure: { text: "runtime exploded" },
    });
  });

  it("fails closed when a gateway declares an invalid terminal status", async () => {
    const id = "chat-invalid-terminal-status";
    turnScript = {
      frames: [sse("done", { reply: "must not settle", terminalStatus: "finished" })],
    };
    await runTurn({ message: "validate the terminal contract", thread: id });
    const t = await waitForMessages(id, 2);
    expect(t.messages[1].text).toBe("");
    expect(t.inputReceipts.at(-1)).toMatchObject({
      state: "failed",
      failure: { code: "terminal_contract_invalid", kind: "protocol" },
    });
    expect(t.sessionEvents.at(-1)).toMatchObject({
      blocks: [
        { type: "error", code: "terminal_contract_invalid" },
        { type: "turn_end", status: "error", subtype: "terminal_contract_invalid" },
      ],
    });
  });

  it.each([
    ["same-epoch signature conflict", 1, 1, "model-b"],
    ["lower epoch", 2, 1, "model-a"],
  ])("fails a %s route session instead of wedging durable settlement", async (_label, priorEpoch, frameEpoch, frameModel) => {
    const id = `chat-route-session-conflict-${gatewayGenerationSeq + 1}`;
    const signature = (model: string) => ({
      target: "sdk-target",
      runtime: "agent-sdk",
      provider: "anthropic",
      model,
      account: null,
      accountSource: null,
      projectPath: null,
    });
    await threads.ensureThread({ id });
    await store.setThreadRouteSession(id, { epoch: priorEpoch, signature: signature("model-a") });
    const generationId = `generation-${gatewayGenerationSeq + 1}`;
    turnScript = {
      frames: [
        sse("route", {
          route: "sdk-target",
          runtime: "agent-sdk",
          model: frameModel,
          sessionDisposition: "warm",
          sessionBoundaryReason: null,
          sessionEpoch: frameEpoch,
          spawnSignature: signature(frameModel),
        }),
        sse("session_event", {
          id: `terminal:${JSON.stringify([generationId])}`,
          role: "assistant",
          ts: Date.now(),
          generationId,
          order: 2,
          revision: 1,
          blocks: [{
            type: "turn_end",
            status: "completed",
            subtype: "success",
            reason: null,
            stopReason: null,
            terminalReason: "completed",
          }],
        }),
        sse("done", { reply: "must not settle", terminalStatus: "completed" }),
      ],
    };
    await runTurn({ message: "keep route identity exact", thread: id });
    const t = await waitForMessages(id, 2);
    expect(t.messages[1].text).toBe("");
    expect(t.routeSession).toEqual({ epoch: priorEpoch, signature: signature("model-a") });
    expect(t.inputReceipts.at(-1)).toMatchObject({
      state: "failed",
      failure: { code: "gateway_stream_protocol_error", kind: "protocol" },
    });
  });

  it.each([
    ["malformed revision", (generationId: string) => ({
      id: `terminal:${JSON.stringify([generationId])}`,
      revision: "bad",
    })],
    ["noncanonical id", (_generationId: string) => ({
      id: "provider-picked-terminal-id",
      revision: 1,
    })],
  ])("fails closed on a %s terminal event before settlement", async (_label, identity) => {
    const id = `chat-invalid-terminal-event-${gatewayGenerationSeq + 1}`;
    const generationId = `generation-${gatewayGenerationSeq + 1}`;
    turnScript = {
      frames: [
        sse("session_event", {
          ...identity(generationId),
          role: "assistant",
          ts: Date.now(),
          generationId,
          order: 1,
          blocks: [{
            type: "turn_end",
            status: "completed",
            subtype: "success",
            reason: null,
            stopReason: null,
            terminalReason: "completed",
          }],
        }),
        sse("done", { reply: "must not settle", terminalStatus: "completed" }),
      ],
    };
    await runTurn({ message: "validate canonical ownership", thread: id });
    const t = await waitForMessages(id, 2);
    expect(t.messages[1].text).toBe("");
    expect(t.inputReceipts.at(-1)).toMatchObject({
      state: "failed",
      generationId,
      failure: { code: "gateway_stream_protocol_error", kind: "protocol" },
    });
    expect(t.sessionEvents).toHaveLength(1);
    expect(t.sessionEvents[0]).toMatchObject({
      id: `terminal:${JSON.stringify([generationId])}`,
      generationId,
      blocks: [
        { type: "error", code: "gateway_stream_protocol_error" },
        { type: "turn_end", status: "error" },
      ],
    });
  });

  it.each([
    ["completed terminal containing an error", "completed", [{
      type: "error", source: "runtime", kind: "runtime", code: "boom", text: "boom", retryable: false,
    }]],
    ["error terminal without a FailureInfo block", "error", []],
    ["error terminal with an untyped failure block", "error", [{
      type: "error", kind: "made_up", text: "boom",
    }]],
  ])("fails closed on a %s", async (_label, status, extraBlocks) => {
    const id = `chat-incoherent-terminal-${gatewayGenerationSeq + 1}`;
    const generationId = `generation-${gatewayGenerationSeq + 1}`;
    turnScript = { frames: [
      sse("session_event", {
        id: `terminal:${JSON.stringify([generationId])}`,
        role: "assistant",
        ts: Date.now(),
        generationId,
        order: 1,
        revision: 1,
        blocks: [
          ...extraBlocks,
          {
            type: "turn_end",
            status,
            subtype: status === "completed" ? "success" : "error_during_execution",
            reason: null,
            stopReason: null,
            terminalReason: status === "completed" ? "completed" : "execution_failed",
          },
        ],
      }),
      sse("done", { reply: "must not settle", terminalStatus: status }),
    ] };
    await runTurn({ message: "validate terminal semantics", thread: id });
    const t = await waitForMessages(id, 2);
    expect(t.messages[1].text).toBe("");
    expect(t.inputReceipts.at(-1)).toMatchObject({
      state: "failed",
      failure: { code: "gateway_stream_protocol_error", kind: "protocol" },
    });
    expect(t.sessionEvents.at(-1)).toMatchObject({
      id: `terminal:${JSON.stringify([generationId])}`,
      blocks: [
        { type: "error", code: "gateway_stream_protocol_error" },
        { type: "turn_end", status: "error" },
      ],
    });
  });

  it.each([
    ["reuse", (terminalId: string) => sse("session_event", {
      id: terminalId,
      role: "assistant",
      ts: Date.now() + 1,
      order: 2,
      revision: 2,
      blocks: [{ type: "status", status: "running", text: "not terminal" }],
    })],
    ["retraction", (terminalId: string) => sse("session_event", {
      id: "later-provider-notice",
      role: "assistant",
      ts: Date.now() + 1,
      order: 2,
      revision: 1,
      retracts: [terminalId],
      blocks: [{ type: "status", status: "running", text: "not terminal" }],
    })],
  ])("does not allow a later nonterminal event to %s the canonical terminal", async (_label, laterFrame) => {
    const id = `chat-terminal-tombstone-${gatewayGenerationSeq + 1}`;
    const generationId = `generation-${gatewayGenerationSeq + 1}`;
    const terminalId = `terminal:${JSON.stringify([generationId])}`;
    turnScript = { frames: [
      sse("session_event", {
        id: terminalId,
        role: "assistant",
        ts: Date.now(),
        generationId,
        order: 1,
        revision: 1,
        blocks: [{
          type: "turn_end",
          status: "completed",
          subtype: "success",
          reason: null,
          stopReason: null,
          terminalReason: "completed",
        }],
      }),
      laterFrame(terminalId),
      sse("done", { reply: "must not settle", terminalStatus: "completed" }),
    ] };
    await runTurn({ message: "keep terminal authority", thread: id });
    const t = await waitForMessages(id, 2);
    expect(t.inputReceipts.at(-1)).toMatchObject({ state: "failed" });
    expect(t.sessionEvents).toHaveLength(1);
    expect(t.sessionEvents[0]).toMatchObject({ id: terminalId, blocks: [
      { type: "error" },
      { type: "turn_end", status: "error" },
    ] });
  });

  it.each(["not-json", ""])("fails a malformed done payload (%s) as protocol, never legacy success", async (data) => {
    const id = `chat-malformed-done-${gatewayGenerationSeq + 1}`;
    turnScript = { frames: [`event: done\ndata: ${data}\n\n`] };
    await runTurn({ message: "reject malformed done", thread: id });
    const t = await waitForMessages(id, 2);
    expect(t.messages[1].text).toBe("");
    expect(t.inputReceipts.at(-1)).toMatchObject({
      state: "failed",
      failure: { code: "gateway_stream_protocol_error", kind: "protocol" },
    });
  });

  it("never settles from a stale terminal revision that the durable journal refused", async () => {
    const id = `chat-stale-terminal-${gatewayGenerationSeq + 1}`;
    const generationId = `generation-${gatewayGenerationSeq + 1}`;
    const terminalId = `terminal:${JSON.stringify([generationId])}`;
    await threads.ensureThread({ id });
    await (threads as any).appendSessionEvent(id, {
      id: terminalId,
      role: "assistant",
      ts: Date.now() - 1,
      generationId,
      order: 1,
      revision: 2,
      blocks: [
        { type: "error", source: "runtime", kind: "runtime", code: "older_failure", text: "Earlier failure.", retryable: false },
        { type: "turn_end", status: "error", subtype: "older_failure", reason: "older_failure", stopReason: null, terminalReason: null },
      ],
    });
    turnScript = { frames: [
      sse("session_event", {
        id: terminalId,
        role: "assistant",
        ts: Date.now(),
        generationId,
        order: 1,
        revision: 1,
        blocks: [{ type: "turn_end", status: "completed", subtype: "success", reason: null, stopReason: null, terminalReason: "completed" }],
      }),
      sse("done", { reply: "must not settle", terminalStatus: "completed" }),
    ] };
    await runTurn({ message: "reject stale authority", thread: id });
    const t = await waitForMessages(id, 2);
    expect(t.messages[1].text).toBe("");
    expect(t.inputReceipts.at(-1)).toMatchObject({ state: "failed" });
    expect(t.sessionEvents.find((event: any) => event.id === terminalId)).toMatchObject({
      revision: 3,
      turnId: t.messages[0].turnId,
      blocks: [{ type: "error", code: "gateway_stream_protocol_error" }, { type: "turn_end", status: "error" }],
    });
  });

  it.each([
    ["activity after the canonical boundary", (terminal: string) => [
      sse("chunk", { text: "late draft" }),
      sse("done", { reply: terminal, terminalStatus: "completed" }),
    ], "gateway_stream_protocol_error"],
    ["a lifecycle reply that contradicts terminal.result", (_terminal: string) => [
      sse("done", { reply: "different lifecycle reply", terminalStatus: "completed" }),
    ], "terminal_contract_invalid"],
  ])("fails closed on %s", async (_label, trailingFrames, expectedCode) => {
    const id = `chat-post-terminal-${gatewayGenerationSeq + 1}`;
    const generationId = `generation-${gatewayGenerationSeq + 1}`;
    const result = "authoritative terminal result";
    turnScript = { frames: [
      sse("session_event", {
        id: `terminal:${JSON.stringify([generationId])}`,
        role: "assistant",
        ts: Date.now(),
        generationId,
        order: 1,
        revision: 1,
        blocks: [{
          type: "turn_end",
          status: "completed",
          subtype: "success",
          reason: null,
          stopReason: null,
          terminalReason: "completed",
          result,
        }],
      }),
      ...trailingFrames(result),
    ] };
    await runTurn({ message: "enforce terminal ordering", thread: id });
    const t = await waitForMessages(id, 2);
    expect(t.messages[1].text).toBe("");
    expect(t.inputReceipts.at(-1)).toMatchObject({
      state: "failed",
      failure: { code: expectedCode, kind: "protocol" },
    });
    expect(t.sessionEvents.at(-1)).toMatchObject({
      revision: 2,
      blocks: [{ type: "error", code: expectedCode }, { type: "turn_end", status: "error" }],
    });
  });

  it("persists when the gateway answers >= 400 (no frames at all)", async () => {
    const id = "chat-fail-400";
    turnScript = {
      status: 503,
      responseBody: {
        error: "gateway said no",
        code: "gateway_route_unavailable",
        kind: "routing",
        source: "gateway",
        text: "gateway said no",
        retryable: true,
        requestId: "gateway-request-503",
        httpStatus: 503,
        retryAt: 1_787_000_000,
      },
    };
    const { text } = await runTurn({ message: "upstream is down", thread: id });
    expect(text).toContain('"httpStatus":503');
    expect(text).toContain("gateway said no");
    const t = await waitForMessages(id, 2);
    expect(t.messages[1].text).toBe("");
    // No route frame ever arrived, so there is no attribution to invent - only the
    // reason survives.
    expect(t.messages[1].route).toEqual({ stoppedReason: "gateway said no" });
    expect(t.inputReceipts.at(-1)).toMatchObject({
      failure: {
        code: "gateway_route_unavailable",
        kind: "routing",
        requestId: "gateway-request-503",
        httpStatus: 503,
        retryAt: 1_787_000_000,
      },
    });
  });

  it("persists when the stream ends without a done frame", async () => {
    const id = "chat-fail-truncated";
    turnScript = { frames: [sse("chunk", { text: "half an answ" })] };
    const { text } = await runTurn({ message: "truncated", thread: id });
    expect(text).toContain("event: error");
    expect(text).toContain("The gateway stream ended without a terminal frame.");
    const t = await waitForMessages(id, 2);
    expect(t.messages[1].text).toBe("");
    expect(t.inputReceipts.at(-1)).toMatchObject({
      failure: { code: "gateway_stream_ended", kind: "protocol", retryable: true },
    });
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

  it("persists the live transport's explicit fallback when done has an empty reply", async () => {
    const id = "chat-empty-done";
    turnScript = { frames: [sse("done", { reply: "", runtime: "agent-sdk" })] };
    await runTurn({ message: "return nothing", thread: id });
    const t = await waitForMessages(id, 2);
    expect(t.messages[1]).toMatchObject({ role: "assistant" });
    expect(t.messages[1].text).toBe("");
    expect(t.messages[1].route).toMatchObject({ runtime: "agent-sdk" });
    expect(t.sessionEvents.at(-1)).toMatchObject({
      blocks: [{ type: "turn_end", status: "completed" }],
    });
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

describe("POST /api/threads/:id/permissions/:requestId - exact live resolver proxy", () => {
  it("verifies the thread and forwards only the exact generation-bound tuple", async () => {
    const id = "chat-permission-proxy";
    const requestId = "request / one";
    await threads.ensureThread({ id });
    const response = await fetch(api(`/api/threads/${encodeURIComponent(id)}/permissions/${encodeURIComponent(requestId)}`), {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify({ generationId: "generation-1", decision: "allow_once" }),
    });
    expect(response.status).toBe(200);
    expect(lastPermissionBody).toEqual({
      threadId: id,
      generationId: "generation-1",
      requestId,
      decision: "allow_once",
    });
  });

  it("rejects unknown threads, extra coordinates, and open-ended decisions before proxying", async () => {
    const before = lastPermissionBody;
    const unknown = await fetch(api("/api/threads/missing/permissions/request-1"), {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify({ generationId: "generation-1", decision: "deny" }),
    });
    expect(unknown.status).toBe(404);

    const id = "chat-permission-validation";
    await threads.ensureThread({ id });
    const extra = await fetch(api(`/api/threads/${id}/permissions/request-1`), {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify({ generationId: "generation-1", decision: "deny", threadId: id }),
    });
    expect(extra.status).toBe(400);
    const invalid = await fetch(api(`/api/threads/${id}/permissions/request-1`), {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify({ generationId: "generation-1", decision: "allow" }),
    });
    expect(invalid.status).toBe(400);
    expect(lastPermissionBody).toBe(before);
  });

  it("preserves a gateway 409 for a durable prompt whose live resolver is gone", async () => {
    const id = "chat-permission-restart";
    await threads.ensureThread({ id });
    permissionStatus = 409;
    try {
      const response = await fetch(api(`/api/threads/${id}/permissions/request-stale`), {
        method: "POST",
        headers: { "content-type": "application/json" },
        body: JSON.stringify({ generationId: "generation-before-restart", decision: "deny" }),
      });
      expect(response.status).toBe(409);
      expect(await response.json()).toEqual({ error: "permission request unavailable" });
    } finally {
      permissionStatus = 200;
    }
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
