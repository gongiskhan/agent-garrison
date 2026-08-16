// D28 — the chat transports surface the AskUserQuestion `tool` event and route
// the answer to the gateway. Driven with a mocked fetch (no live gateway):
//   - the orchestrator transport (web-channel default path) parses a `tool` SSE
//     frame into a ChatEvent and posts answers to /api/chat/answer;
//   - createHttpTransport (rich /claude/* path) posts answers to /api/claude/answer.
//
// Plus the 2026-07-25 run-context contract's client seam: the request body carries
// the pinned `routing`, the monotonic `turnSeq` and the long-dropped `autonomous`
// marker; the widened `route` frame (pre-turn `pending` + folded into `done`) and the
// new `activity` frame become ChatEvents; and `interrupt()` is a real POST.

import { describe, it, expect, afterEach, vi } from "vitest";
import { readFileSync } from "node:fs";
import { fileURLToPath } from "node:url";
import type { ChatEvent, SessionEvent } from "@garrison/claude-chat";
import { createHttpTransport } from "@garrison/claude-chat";
import { ChatTransportError } from "@garrison/claude-chat/transport";
import { createOrchestratorTransport } from "../fittings/seed/web-channel-default/ui/orchestrator-transport";
// @ts-ignore — dependency-free fitting JavaScript intentionally has no .d.ts.
import { normalizeAgentSdkMessages } from "../fittings/seed/agent-sdk-runtime/lib/session-events.mjs";

const SDK_FIXTURE = JSON.parse(
  readFileSync(fileURLToPath(new URL("./fixtures/agent-sdk-web-parity-events.json", import.meta.url)), "utf8")
);

function canonicalFixtureEvents(turnId: string) {
  let now = 1_786_880_000_000;
  return normalizeAgentSdkMessages(SDK_FIXTURE.messages, { turnId, now: () => now++ });
}

const QUESTIONS = [
  {
    question: "Pick a letter?",
    header: "Pick a letter",
    options: [
      { label: "A", description: "Letter A" },
      { label: "B", description: "Letter B" },
    ],
    multiSelect: false,
  },
];

function sseResponse(frames: string[]): Response {
  const enc = new TextEncoder();
  const body = new ReadableStream<Uint8Array>({
    start(controller) {
      for (const f of frames) controller.enqueue(enc.encode(f));
      controller.close();
    },
  });
  return new Response(body, { status: 200, headers: { "content-type": "text/event-stream" } });
}

const realFetch = globalThis.fetch;
afterEach(() => {
  globalThis.fetch = realFetch;
  delete (globalThis as { window?: unknown }).window;
});

// Recording fetch: SSE for POST /api/chat, JSON for everything else. Returns the
// call log so a test can assert what actually reached the wire - the whole point of
// this seam is that it silently loses any key it does not name.
function recordingFetch(frames: string[], hostMap?: Record<string, string>) {
  const calls: { url: string; method: string; body: any }[] = [];
  globalThis.fetch = vi.fn(async (url: any, init: any) => {
    const u = String(url);
    calls.push({
      url: u,
      method: String(init?.method ?? "GET"),
      body: init?.body ? JSON.parse(init.body) : undefined,
    });
    if (u === "/host-map") {
      return new Response(JSON.stringify({ map: hostMap ?? {} }), {
        status: 200,
        headers: { "content-type": "application/json" },
      });
    }
    if (u.endsWith("/chat")) return sseResponse(frames);
    return new Response("{}", { status: 200, headers: { "content-type": "application/json" } });
  }) as unknown as typeof fetch;
  return calls;
}

const chatBody = (calls: { url: string; body: any }[]) => calls.find((c) => c.url === "/api/chat")?.body;

// A fresh module instance: the serve table is cached at module scope (one fetch per
// page), so a test that needs its own /host-map answer has to re-import.
async function freshTransport() {
  vi.resetModules();
  const mod = await import("../fittings/seed/web-channel-default/ui/orchestrator-transport");
  return mod.createOrchestratorTransport;
}

describe("orchestrator transport: AskUserQuestion", () => {
  it("surfaces a `tool` ChatEvent from a tool SSE frame", async () => {
    globalThis.fetch = vi.fn(async () =>
      sseResponse([
        `event: chunk\ndata: ${JSON.stringify({ type: "chunk", text: "Let me ask." })}\n\n`,
        `event: tool\ndata: ${JSON.stringify({ name: "AskUserQuestion", tool_use_id: "toolu_1", questions: QUESTIONS })}\n\n`,
        `event: done\ndata: ${JSON.stringify({ reply: "Thanks" })}\n\n`,
      ])
    ) as unknown as typeof fetch;

    const t = createOrchestratorTransport("/api", "thread-1");
    const events: ChatEvent[] = [];
    t.connect((ev) => events.push(ev));
    await t.sendMessage("hello");

    const tool = events.find((e) => e.type === "tool");
    expect(tool).toBeDefined();
    expect(tool).toMatchObject({ type: "tool", name: "AskUserQuestion", tool_use_id: "toolu_1" });
    expect((tool as any).questions[0].options).toHaveLength(2);
  });

  it("answerQuestion POSTs the tapped label to /api/chat/answer", async () => {
    const calls: { url: string; body: any }[] = [];
    globalThis.fetch = vi.fn(async (url: any, init: any) => {
      calls.push({ url: String(url), body: JSON.parse(init.body) });
      return new Response("{}", { status: 200 });
    }) as unknown as typeof fetch;

    const t = createOrchestratorTransport("/api", "thread-1");
    await t.answerQuestion!({ toolUseId: "toolu_1", label: "A" });

    expect(calls).toHaveLength(1);
    expect(calls[0].url).toBe("/api/chat/answer");
    expect(calls[0].body).toMatchObject({ session_id: "thread-1", tool_use_id: "toolu_1", label: "A" });
  });

  it("answerQuestion forwards a dismiss", async () => {
    const calls: { url: string; body: any }[] = [];
    globalThis.fetch = vi.fn(async (url: any, init: any) => {
      calls.push({ url: String(url), body: JSON.parse(init.body) });
      return new Response("{}", { status: 200 });
    }) as unknown as typeof fetch;

    const t = createOrchestratorTransport("/api");
    await t.answerQuestion!({ toolUseId: "toolu_9", dismiss: true });
    expect(calls[0].body).toMatchObject({ tool_use_id: "toolu_9", dismiss: true });
  });

  it("answerQuestion surfaces HTTP refusals and network failures", async () => {
    globalThis.fetch = vi.fn(async () => new Response(JSON.stringify({ error: "question is no longer active" }), {
      status: 409,
      headers: { "content-type": "application/json" },
    })) as unknown as typeof fetch;
    const refused = createOrchestratorTransport("/api", "thread-1");
    await expect(refused.answerQuestion!({ toolUseId: "toolu_old", label: "A" }))
      .rejects.toThrow("question is no longer active");

    globalThis.fetch = vi.fn(async () => {
      throw new TypeError("network unavailable");
    }) as unknown as typeof fetch;
    const offline = createOrchestratorTransport("/api", "thread-1");
    await expect(offline.answerQuestion!({ toolUseId: "toolu_live", label: "B" }))
      .rejects.toThrow("network unavailable");
  });
});

describe("orchestrator transport: durable permissions", () => {
  it("posts the encoded thread/request path with only generationId and decision", async () => {
    const calls: { url: string; body: any }[] = [];
    globalThis.fetch = vi.fn(async (url: any, init: any) => {
      calls.push({ url: String(url), body: JSON.parse(init.body) });
      return new Response("{}", { status: 200 });
    }) as unknown as typeof fetch;

    const transport = createOrchestratorTransport("/api", "thread / one");
    await transport.answerPermission!({
      requestId: "request / one",
      generationId: "generation-1",
      decision: "allow_always",
    });

    expect(calls).toEqual([{
      url: "/api/threads/thread%20%2F%20one/permissions/request%20%2F%20one",
      body: { generationId: "generation-1", decision: "allow_always" },
    }]);
  });

  it("throws on an unavailable resolver and when no thread is bound", async () => {
    globalThis.fetch = vi.fn(async () => new Response("{}", { status: 409 })) as unknown as typeof fetch;
    const transport = createOrchestratorTransport("/api", "thread-1");
    await expect(transport.answerPermission!({ requestId: "request-1", generationId: "generation-old", decision: "deny" }))
      .rejects.toThrow("permission 409");

    const threadless = createOrchestratorTransport("/api");
    await expect(threadless.answerPermission!({ requestId: "request-1", generationId: "generation-1", decision: "deny" }))
      .rejects.toThrow("thread is required");
  });
});

describe("orchestrator transport: canonical session events", () => {
  it("forwards the authentic two-tool fixture without selecting or reshaping payload fields", async () => {
    const canonical = canonicalFixtureEvents("fixture-turn");
    globalThis.fetch = vi.fn(async (raw: any) => {
      if (String(raw) === "/host-map") {
        return new Response(JSON.stringify({ map: {} }), { status: 200, headers: { "content-type": "application/json" } });
      }
      return sseResponse([
        ...canonical.map((event: any) => `event: session_event\ndata: ${JSON.stringify(event)}\n\n`),
        `event: done\ndata: ${JSON.stringify({ reply: "WEB_PARITY_FIXTURE" })}\n\n`,
      ]);
    }) as unknown as typeof fetch;

    const create = await freshTransport();
    const transport = create("/api", "thread-events");
    const events: ChatEvent[] = [];
    transport.connect((event) => events.push(event));
    await transport.sendMessage("run fixture");

    const sessionFrames = events.filter((event: any) => event.type === "session_event") as any[];
    expect(sessionFrames.map((frame) => frame.event)).toEqual(canonical);
    expect(sessionFrames.every((frame) => Object.keys(frame).sort().join(",") === "event,type")).toBe(true);
    expect(sessionFrames.map((frame) => frame.event.id)).toEqual(canonical.map((event: any) => event.id));
    expect(sessionFrames.every((frame) => frame.event.turnId === "fixture-turn")).toBe(true);
  });

  it("ignores malformed JSON and malformed session-event shapes", async () => {
    globalThis.fetch = vi.fn(async (raw: any) => {
      if (String(raw) === "/host-map") {
        return new Response(JSON.stringify({ map: {} }), { status: 200, headers: { "content-type": "application/json" } });
      }
      return sseResponse([
        "event: session_event\ndata: {not-json\n\n",
        `event: session_event\ndata: ${JSON.stringify({ id: "missing-blocks", role: "assistant", ts: 1 })}\n\n`,
        `event: done\ndata: ${JSON.stringify({ reply: "safe fallback" })}\n\n`,
      ]);
    }) as unknown as typeof fetch;

    const create = await freshTransport();
    const transport = create("/api", "thread-malformed-events");
    const events: ChatEvent[] = [];
    transport.connect((event) => events.push(event));
    await transport.sendMessage("ignore corrupt activity");

    expect(events.filter((event) => event.type === "session_event")).toEqual([]);
    expect(events.find((event) => event.type === "assistant")).toMatchObject({ text: "safe fallback" });
  });
});

describe("orchestrator transport: runtime attribution", () => {
  it("emits a `route` ChatEvent from a done frame carrying routing fields, before idling the turn", async () => {
    globalThis.fetch = vi.fn(async () =>
      sseResponse([
        `event: chunk\ndata: ${JSON.stringify({ type: "chunk", text: "Done." })}\n\n`,
        `event: done\ndata: ${JSON.stringify({
          reply: "Done.",
          route: "cc-haiku-low",
          runtime: "agent-sdk",
          model: "claude-haiku-4-5",
          effort: "high",
          effortApplied: false,
          taskType: "other",
          tier: "T0-trivial",
          ruleId: "cell:other/T0-trivial",
          profile: "balanced",
          honored: true,
        })}\n\n`,
      ])
    ) as unknown as typeof fetch;

    const t = createOrchestratorTransport("/api", "thread-r");
    const events: ChatEvent[] = [];
    t.connect((ev) => events.push(ev));
    await t.sendMessage("hello");

    const routeIdx = events.findIndex((e) => e.type === "route");
    expect(routeIdx).toBeGreaterThanOrEqual(0);
    expect(events[routeIdx]).toMatchObject({
      type: "route",
      route: "cc-haiku-low",
      runtime: "agent-sdk",
      model: "claude-haiku-4-5",
      effort: "high",
      effortApplied: false,
      tier: "T0-trivial",
      ruleId: "cell:other/T0-trivial",
      profile: "balanced",
      honored: true,
    });
    // The route event precedes the turn-idle event so the UI can attach it to the
    // just-finished turn.
    const idleIdx = events.findIndex((e) => e.type === "turn" && (e as any).active === false);
    expect(routeIdx).toBeLessThan(idleIdx);
  });

  it("emits effort-only attribution without inventing application truth", async () => {
    globalThis.fetch = vi.fn(async () =>
      sseResponse([`event: done\ndata: ${JSON.stringify({ reply: "Done.", effort: "medium" })}\n\n`])
    ) as unknown as typeof fetch;

    const t = createOrchestratorTransport("/api", "thread-effort");
    const events: ChatEvent[] = [];
    t.connect((ev) => events.push(ev));
    await t.sendMessage("hello");

    expect(events.find((e) => e.type === "route")).toMatchObject({
      type: "route",
      effort: "medium",
      effortApplied: null,
    });
  });

  it("does not emit a `route` event when the done frame carries no routing fields", async () => {
    globalThis.fetch = vi.fn(async () =>
      sseResponse([`event: done\ndata: ${JSON.stringify({ reply: "Plain." })}\n\n`])
    ) as unknown as typeof fetch;

    const t = createOrchestratorTransport("/api", "thread-p");
    const events: ChatEvent[] = [];
    t.connect((ev) => events.push(ev));
    await t.sendMessage("hi");

    expect(events.some((e) => e.type === "route")).toBe(false);
  });
});

describe("orchestrator transport: run-context request body (contract §3)", () => {
  it("forwards the pinned routing, the turn number AND the autonomous marker", async () => {
    const calls = recordingFetch([`event: done\ndata: ${JSON.stringify({ reply: "ok" })}\n\n`]);
    const t = createOrchestratorTransport("/api", "thread-pins");
    const send = t.sendMessage as unknown as (text: string, meta?: unknown) => Promise<void>;
    await send("ship it", {
      routing: { target: "cc-sonnet-med", effort: "high", level: 2 },
      autonomous: true,
    });

    // `autonomous` has been produced by buildSendMeta and dropped right here since
    // D21 - it is pinned next to `routing` precisely because this seam fails silently.
    expect(chatBody(calls)).toEqual({
      message: "ship it",
      thread: "thread-pins",
      autonomous: true,
      routing: { target: "cc-sonnet-med", effort: "high", level: 2 },
      turnSeq: 1,
    });
  });

  it("keeps a plain send minimal - no pins, no autonomous, no context/mode keys", async () => {
    const calls = recordingFetch([`event: done\ndata: ${JSON.stringify({ reply: "ok" })}\n\n`]);
    const t = createOrchestratorTransport("/api", "thread-plain");
    await t.sendMessage("hi");
    expect(chatBody(calls)).toEqual({ message: "hi", thread: "thread-plain", turnSeq: 1 });
  });

  it("drops an all-empty pin object instead of sending routing: {}", async () => {
    const calls = recordingFetch([`event: done\ndata: ${JSON.stringify({ reply: "ok" })}\n\n`]);
    const t = createOrchestratorTransport("/api", "thread-empty-pins");
    const send = t.sendMessage as unknown as (text: string, meta?: unknown) => Promise<void>;
    await send("hi", { routing: {} });
    expect(chatBody(calls)).toEqual({ message: "hi", thread: "thread-empty-pins", turnSeq: 1 });
  });

  it("stamps a monotonic turnSeq per send onto the body AND onto that send's frames", async () => {
    const calls = recordingFetch([
      `event: route\ndata: ${JSON.stringify({ duty: "plan", pending: true })}\n\n`,
      `event: done\ndata: ${JSON.stringify({ reply: "ok", duty: "plan" })}\n\n`,
    ]);
    const t = createOrchestratorTransport("/api", "thread-seq");
    const events: ChatEvent[] = [];
    t.connect((ev) => events.push(ev));
    await t.sendMessage("one");
    await t.sendMessage("two");

    const bodies = calls.filter((c) => c.url === "/api/chat").map((c) => c.body.turnSeq);
    expect(bodies).toEqual([1, 2]);
    // Every frame of a send carries THAT send's number - the consumer drops a frame
    // stamped older than the turn it would land on, so the echo is not trusted.
    const stamps = events.filter((e) => e.type === "route").map((e) => (e as any).turnSeq);
    expect(stamps).toEqual([1, 1, 2, 2]);
  });
});

describe("orchestrator transport: widened route frames (contract §1, §4)", () => {
  it("emits the PRE-TURN frame with pending, then the settled frame without it", async () => {
    const calls = recordingFetch([
      `event: route\ndata: ${JSON.stringify({ route: "cc-sonnet-med", runtime: "agent-sdk", duty: "plan", level: 2, pending: true })}\n\n`,
      `event: done\ndata: ${JSON.stringify({ reply: "Done.", route: "cc-sonnet-med", runtime: "agent-sdk", duty: "plan", level: 2, effortApplied: true, effort: "high" })}\n\n`,
    ]);
    const t = createOrchestratorTransport("/api", "thread-pre");
    const events: ChatEvent[] = [];
    t.connect((ev) => events.push(ev));
    await t.sendMessage("plan this");
    expect(calls.some((c) => c.url === "/api/chat")).toBe(true);

    const routes = events.filter((e) => e.type === "route") as any[];
    expect(routes).toHaveLength(2);
    expect(routes[0]).toMatchObject({ route: "cc-sonnet-med", duty: "plan", level: 2, pending: true });
    // The done frame carries no `pending`, so the key must be ABSENT rather than
    // forwarded as false: the consumer reads it as "describes the latest frame".
    expect("pending" in routes[1]).toBe(false);
    expect(routes[1]).toMatchObject({ effort: "high", effortApplied: true });
  });

  it("forwards every new attribution field, accepting the legacy snake_case spellings", async () => {
    recordingFetch([
      `event: done\ndata: ${JSON.stringify({
        reply: "Done.",
        route: "cc-sonnet-med",
        runtime: "agent-sdk",
        duty: "execute",
        level: 3,
        phase: "review",
        flow: "full-feature",
        phasesOff: "review",
        classifierSkipped: true,
        skill: null,
        via: "turn-override",
        account: "work",
        accountSource: "override",
        project: "garrison",
        projectPath: "/home/ggomes/dev/garrison",
        card: "c-42",
        cardUrl: "https://board.example/card/c-42",
        session_id: "sess-9",
        transcript_path: "/home/ggomes/.claude/projects/x/sess-9.jsonl",
        stopped_by_user: true,
        stopped_reason: "user-interrupt",
        overridesApplied: ["duty", "level"],
        overridesRejected: [{ field: "effort", reason: "provider-has-no-effort-control" }],
      })}\n\n`,
    ]);
    const t = createOrchestratorTransport("/api", "thread-full");
    const events: ChatEvent[] = [];
    t.connect((ev) => events.push(ev));
    await t.sendMessage("go");

    expect(events.find((e) => e.type === "route")).toMatchObject({
      duty: "execute",
      level: 3,
      phase: "review",
      flow: "full-feature",
      phasesOff: "review",
      classifierSkipped: true,
      skill: null,
      via: "turn-override",
      account: "work",
      accountSource: "override",
      project: "garrison",
      projectPath: "/home/ggomes/dev/garrison",
      card: "c-42",
      cardUrl: "https://board.example/card/c-42",
      sessionId: "sess-9",
      transcriptPath: "/home/ggomes/.claude/projects/x/sess-9.jsonl",
      stoppedByUser: true,
      stoppedReason: "user-interrupt",
      overridesApplied: ["duty", "level"],
      overridesRejected: [{ field: "effort", reason: "provider-has-no-effort-control" }],
    });
  });

  it("prefers an explicit camelCase field over its snake_case alias", async () => {
    recordingFetch([
      `event: done\ndata: ${JSON.stringify({ reply: "x", sessionId: "camel", session_id: "snake" })}\n\n`,
    ]);
    const t = createOrchestratorTransport("/api", "thread-alias");
    const events: ChatEvent[] = [];
    t.connect((ev) => events.push(ev));
    await t.sendMessage("go");
    expect((events.find((e) => e.type === "route") as any).sessionId).toBe("camel");
  });

  it("keeps null and ABSENT apart: an explicit null is reported, a missing field is omitted", async () => {
    recordingFetch([
      `event: done\ndata: ${JSON.stringify({ reply: "x", duty: "plan", account: null, skill: null })}\n\n`,
    ]);
    const t = createOrchestratorTransport("/api", "thread-null");
    const events: ChatEvent[] = [];
    t.connect((ev) => events.push(ev));
    await t.sendMessage("go");

    const ev = events.find((e) => e.type === "route") as any;
    // account: null is a FACT ("ran on the machine's own Claude login") and skill:
    // null is the honest limit ("skill: none"); an absent project is "this lane
    // cannot say" and must not be invented as null.
    expect(ev.account).toBeNull();
    expect(ev.skill).toBeNull();
    expect("project" in ev).toBe(false);
    expect("card" in ev).toBe(false);
  });

  it("emits a route frame for an attribution-only done frame (no route/runtime/model)", async () => {
    recordingFetch([`event: done\ndata: ${JSON.stringify({ reply: "x", duty: "plan", level: 1 })}\n\n`]);
    const t = createOrchestratorTransport("/api", "thread-dutyonly");
    const events: ChatEvent[] = [];
    t.connect((ev) => events.push(ev));
    await t.sendMessage("go");
    expect(events.find((e) => e.type === "route")).toMatchObject({ duty: "plan", level: 1 });
  });
});

describe("orchestrator transport: activity frames (contract §12)", () => {
  it("surfaces a tool activity frame for the working hint", async () => {
    recordingFetch([
      `event: activity\ndata: ${JSON.stringify({ kind: "tool", name: "Edit", id: "toolu_5" })}\n\n`,
      `event: done\ndata: ${JSON.stringify({ reply: "done" })}\n\n`,
    ]);
    const t = createOrchestratorTransport("/api", "thread-act");
    const events: ChatEvent[] = [];
    t.connect((ev) => events.push(ev));
    await t.sendMessage("go");

    expect(events.find((e) => e.type === "activity")).toEqual({ type: "activity", kind: "tool", name: "Edit", id: "toolu_5" });
  });

  it("ignores a nameless activity frame rather than rendering an empty hint", async () => {
    recordingFetch([
      `event: activity\ndata: ${JSON.stringify({ kind: "tool" })}\n\n`,
      `event: done\ndata: ${JSON.stringify({ reply: "done" })}\n\n`,
    ]);
    const t = createOrchestratorTransport("/api", "thread-act2");
    const events: ChatEvent[] = [];
    t.connect((ev) => events.push(ev));
    await t.sendMessage("go");
    expect(events.some((e) => e.type === "activity")).toBe(false);
  });
});

describe("orchestrator transport: terminal EOF", () => {
  it("surfaces and settles an SSE body that closes without done or error", async () => {
    recordingFetch([]);
    const t = createOrchestratorTransport("/api", "thread-truncated");
    const events: ChatEvent[] = [];
    t.connect((event) => events.push(event));

    await t.sendMessage("go");

    expect(events.filter((event) => event.type === "error")).toEqual([
      {
        type: "error",
        message: "The response stream ended without a completion event.",
        failure: {
          source: "transport",
          kind: "protocol",
          code: "stream_ended_without_terminal",
          text: "The response stream ended without a completion event.",
          retryable: true,
        },
      },
    ]);
    expect(events.filter((event) => event.type === "turn")).toEqual([
      { type: "turn", active: false },
    ]);
  });

  it("does not add a second EOF failure after the server's terminal error frame", async () => {
    recordingFetch([
      `event: error\ndata: ${JSON.stringify({ error: "the gateway stream ended without a done event" })}\n\n`,
    ]);
    const t = createOrchestratorTransport("/api", "thread-server-eof");
    const events: ChatEvent[] = [];
    t.connect((event) => events.push(event));

    await t.sendMessage("go");

    expect(events.filter((event) => event.type === "error")).toEqual([
      {
        type: "error",
        message: "the gateway stream ended without a done event",
        failure: {
          source: "transport",
          kind: "transport",
          code: "stream_error",
          text: "the gateway stream ended without a done event",
          retryable: false,
        },
      },
    ]);
    expect(events.filter((event) => event.type === "turn")).toEqual([
      { type: "turn", active: false },
    ]);
  });
});

describe("orchestrator transport: card links are made reachable for THIS client", () => {
  const cardFrames = (cardUrl: string) => [
    `event: done\ndata: ${JSON.stringify({ reply: "carded", card: "c-7", cardUrl })}\n\n`,
  ];
  const routeOf = (events: ChatEvent[]) => events.find((e) => e.type === "route") as any;

  it("rebinds a loopback board url onto its tailnet serve mapping", async () => {
    (globalThis as any).window = { location: { hostname: "dev-madrid.tail31efa.ts.net", protocol: "https:" } };
    recordingFetch(cardFrames("http://127.0.0.1:8081/card/c-7"), { "8081": "https://dev-madrid.tail31efa.ts.net:8443" });
    const create = await freshTransport();
    const t = create("/api", "thread-card");
    const events: ChatEvent[] = [];
    t.connect((ev) => events.push(ev));
    await t.sendMessage("go");
    expect(routeOf(events).cardUrl).toBe("https://dev-madrid.tail31efa.ts.net:8443/card/c-7");
  });

  it("blanks a loopback url with no serve mapping on an HTTPS page (mixed content)", async () => {
    (globalThis as any).window = { location: { hostname: "dev-madrid.tail31efa.ts.net", protocol: "https:" } };
    recordingFetch(cardFrames("http://127.0.0.1:8081/card/c-7"), {});
    const create = await freshTransport();
    const t = create("/api", "thread-card2");
    const events: ChatEvent[] = [];
    t.connect((ev) => events.push(ev));
    await t.sendMessage("go");
    // "" means "no href" to the badge model: the card is still reported, it just is
    // not offered as a link the browser would refuse to open.
    expect(routeOf(events).cardUrl).toBe("");
  });

  it("leaves a url that is already reachable untouched", async () => {
    (globalThis as any).window = { location: { hostname: "dev-madrid.tail31efa.ts.net", protocol: "https:" } };
    recordingFetch(cardFrames("https://dev-madrid.tail31efa.ts.net:8443/card/c-7"), {});
    const create = await freshTransport();
    const t = create("/api", "thread-card3");
    const events: ChatEvent[] = [];
    t.connect((ev) => events.push(ev));
    await t.sendMessage("go");
    expect(routeOf(events).cardUrl).toBe("https://dev-madrid.tail31efa.ts.net:8443/card/c-7");
  });
});

describe("orchestrator transport: replay/follow a running thread", () => {
  it("resumes exact pending inputs, preserves replace, and keeps generated coordinates", async () => {
    const inputId = "input-resume";
    const generationId = "generation-resume";
    const replayEvent = canonicalFixtureEvents("77").find((event: any) =>
      event.blocks.some((block: any) => block.type === "tool_use" && block.name === "Write")
    );
    const stamp = (value: Record<string, unknown>) => ({ ...value, inputId, generationId });
    const frames = [
      `id: 1\nevent: input\ndata: ${JSON.stringify({ clientRequestId: "client-resume", inputId, generationId, state: "running" })}\n\n`,
      `id: 2\nevent: route\ndata: ${JSON.stringify(stamp({ runtime: "agent-sdk", session_id: "sess-live", turnSeq: 77, pending: true }))}\n\n`,
      `id: 3\nevent: session_event\ndata: ${JSON.stringify(stamp({ ...replayEvent, turnId: inputId }))}\n\n`,
      `id: 4\nevent: chunk\ndata: ${JSON.stringify(stamp({ text: "draft " }))}\n\n`,
      `id: 5\nevent: chunk\ndata: ${JSON.stringify(stamp({ text: "clean", replace: true }))}\n\n`,
      `id: 6\nevent: chunk\ndata: ${JSON.stringify(stamp({ text: " answer" }))}\n\n`,
      `id: 7\nevent: done\ndata: ${JSON.stringify(stamp({ reply: "clean answer", runtime: "agent-sdk", session_id: "sess-live", turnSeq: 77 }))}\n\n`,
      `id: 8\nevent: input\ndata: ${JSON.stringify({ clientRequestId: "client-resume", inputId, generationId, state: "settled" })}\n\n`,
    ];
    const calls: string[] = [];
    globalThis.fetch = vi.fn(async (raw: any) => {
      const u = String(raw);
      calls.push(u);
      if (u === "/host-map") {
        return new Response(JSON.stringify({ map: {} }), { status: 200, headers: { "content-type": "application/json" } });
      }
      if (u === "/api/threads/thread-resume/inputs") {
        return new Response(JSON.stringify({ inputs: [{ clientRequestId: "client-resume", inputId, generationId, state: "running" }] }), {
          status: 200,
          headers: { "content-type": "application/json" },
        });
      }
      if (u === `/api/threads/thread-resume/inputs/${inputId}/live`) return sseResponse(frames);
      return new Response("{}", { status: 404 });
    }) as unknown as typeof fetch;
    const create = await freshTransport();
    const events: ChatEvent[] = [];
    const states: boolean[] = [];
    const settlements: Array<{ recovery: boolean }> = [];
    let settled!: () => void;
    const finished = new Promise<void>((resolve) => { settled = resolve; });
    const transport = create("/api", "thread-resume", {
      resumeOnConnect: true,
      onResumeState: (active: boolean) => states.push(active),
      onResumeSettled: (result) => {
        settlements.push(result);
        settled();
      },
    });
    transport.connect((event) => events.push(event));
    await finished;

    expect(calls).toContain("/api/threads/thread-resume/inputs");
    expect(calls).toContain(`/api/threads/thread-resume/inputs/${inputId}/live`);
    expect(states).toEqual([true, false]);
    // No canonical turn_end was painted (the replay contained only a tool row),
    // so the host must remount from the durable server snapshot after legacy done.
    expect(settlements).toEqual([{ recovery: true }]);
    expect(events.filter((event) => event.type === "turn")).toEqual([]);
    expect(events.filter((event) => event.type === "assistant").map((event: any) => event.text)).toEqual([
      "draft ",
      "clean",
      "clean answer",
      "clean answer",
    ]);
    // The old turnSeq remains diagnostic only; generated identity is exact.
    expect(events.filter((event) => event.type === "route").map((event: any) => event.turnSeq)).toEqual([0, 0]);
    expect(events.filter((event) => event.type === "route").every((event: any) => event.inputId === inputId && event.generationId === generationId)).toBe(true);
    const restored = events.find((event: any) => event.type === "session_event") as any;
    expect(restored.event).toEqual({ ...replayEvent, turnId: inputId, inputId, generationId });
    expect(restored.event.blocks).toEqual(replayEvent.blocks);
  });

  it("does not remount after a generated follower paints its canonical terminal", async () => {
    const input = {
      clientRequestId: "client-canonical-terminal",
      inputId: "input-canonical-terminal",
      generationId: "generation-canonical-terminal",
      state: "running" as const,
    };
    const terminal = {
      id: `terminal:${JSON.stringify([input.generationId])}`,
      role: "assistant",
      ts: Date.now(),
      turnId: input.inputId,
      generationId: input.generationId,
      order: 2,
      revision: 1,
      blocks: [{
        type: "turn_end",
        status: "completed",
        subtype: "success",
        reason: null,
        stopReason: null,
        terminalReason: "completed",
        result: "done",
      }],
    };
    globalThis.fetch = vi.fn(async (raw: any) => {
      const requestUrl = String(raw);
      if (requestUrl === "/host-map") return new Response(JSON.stringify({ map: {} }), { status: 200 });
      if (requestUrl.endsWith("/inputs")) {
        return new Response(JSON.stringify({ inputs: [input] }), { status: 200 });
      }
      return sseResponse([
        `event: session_event\ndata: ${JSON.stringify(terminal)}\n\n`,
        `event: done\ndata: ${JSON.stringify({ ...input, reply: "done", terminalStatus: "completed" })}\n\n`,
        `event: input\ndata: ${JSON.stringify({ ...input, state: "settled" })}\n\n`,
      ]);
    }) as unknown as typeof fetch;
    const create = await freshTransport();
    const settlements: Array<{ recovery: boolean }> = [];
    const transport = create("/api", "thread-canonical-terminal", {
      resumeOnConnect: true,
      onResumeSettled: (result) => { settlements.push(result); },
    });
    transport.connect(() => {});
    await vi.waitFor(() => expect(settlements).toEqual([{ recovery: false }]));
  });

  it("keeps recovery sticky when a FIFO handoff happened before resume even if the returned input paints a terminal", async () => {
    const input = {
      clientRequestId: "client-handoff-b",
      inputId: "input-handoff-b",
      generationId: "generation-handoff-b",
      state: "running" as const,
    };
    const terminal = {
      id: `terminal:${JSON.stringify([input.generationId])}`,
      role: "assistant",
      ts: Date.now(),
      turnId: input.inputId,
      generationId: input.generationId,
      order: 2,
      revision: 1,
      blocks: [{
        type: "turn_end",
        status: "completed",
        subtype: "success",
        reason: null,
        stopReason: null,
        terminalReason: "completed",
        result: "B completed",
      }],
    };
    globalThis.fetch = vi.fn(async (raw: any) => {
      const requestUrl = String(raw);
      if (requestUrl === "/host-map") return new Response(JSON.stringify({ map: {} }), { status: 200 });
      if (requestUrl.endsWith("/inputs")) {
        // A settled and B was claimed after the parent snapshot (revision 10)
        // but before this list request, so only B remains at revision 12.
        return new Response(JSON.stringify({ inputs: [input], inputRevision: 12 }), { status: 200 });
      }
      return sseResponse([
        `event: session_event\ndata: ${JSON.stringify(terminal)}\n\n`,
        `event: done\ndata: ${JSON.stringify({ ...input, reply: "B completed", terminalStatus: "completed" })}\n\n`,
        `event: input\ndata: ${JSON.stringify({ ...input, state: "settled" })}\n\n`,
      ]);
    }) as unknown as typeof fetch;
    const create = await freshTransport();
    const settlements: Array<{ recovery: boolean }> = [];
    const states: boolean[] = [];
    const transport = create("/api", "thread-handoff", {
      resumeOnConnect: true,
      initialInputRevision: 10,
      initialInputIds: ["input-handoff-a", input.inputId],
      onResumeState: (active: boolean) => { states.push(active); },
      onResumeSettled: (result) => { settlements.push(result); },
    });
    transport.connect(() => {});
    await vi.waitFor(() => expect(settlements).toEqual([{ recovery: true }]));
    expect(states).toEqual([true, false]);
  });

  it("refreshes immediately when the input settles between thread hydration and resume", async () => {
    globalThis.fetch = vi.fn(async (raw: any) => {
      if (String(raw) === "/host-map") {
        return new Response(JSON.stringify({ map: {} }), { status: 200 });
      }
      return new Response(JSON.stringify({ inputs: [], inputRevision: 2 }), {
        status: 200,
        headers: { "content-type": "application/json" },
      });
    }) as unknown as typeof fetch;
    const create = await freshTransport();
    const states: boolean[] = [];
    const settlements: Array<{ recovery: boolean }> = [];
    const transport = create("/api", "thread-settled-race", {
      resumeOnConnect: true,
      onResumeState: (active: boolean) => states.push(active),
      onResumeSettled: (result) => { settlements.push(result); },
    });
    transport.connect(() => {});
    await vi.waitFor(() => expect(settlements).toEqual([{ recovery: true }]));
    expect(states).toEqual([true, false]);
  });

  it("retries a non-OK resume response while connected and recovers on 500 to 200", async () => {
    let inputAttempts = 0;
    const settlements: Array<{ recovery: boolean }> = [];
    globalThis.fetch = vi.fn(async (raw: any) => {
      const requestUrl = String(raw);
      if (requestUrl === "/host-map") return new Response(JSON.stringify({ map: {} }), { status: 200 });
      inputAttempts += 1;
      if (inputAttempts === 1) {
        return new Response(JSON.stringify({ error: "temporarily unavailable" }), {
          status: 500,
          headers: { "content-type": "application/json" },
        });
      }
      return new Response(JSON.stringify({ inputs: [], inputRevision: 4 }), {
        status: 200,
        headers: { "content-type": "application/json" },
      });
    }) as unknown as typeof fetch;
    const create = await freshTransport();
    const transport = create("/api", "thread-resume-retry", {
      resumeOnConnect: true,
      onResumeSettled: (result) => { settlements.push(result); },
    });
    transport.connect(() => {});

    await vi.waitFor(() => expect(inputAttempts).toBe(2), { timeout: 2_000 });
    await vi.waitFor(() => expect(settlements).toHaveLength(2));
    expect(settlements).toEqual([{ recovery: true }, { recovery: true }]);
  });

  it("retries a malformed resume payload instead of permanently latching resume", async () => {
    let inputAttempts = 0;
    globalThis.fetch = vi.fn(async (raw: any) => {
      const requestUrl = String(raw);
      if (requestUrl === "/host-map") return new Response(JSON.stringify({ map: {} }), { status: 200 });
      inputAttempts += 1;
      return new Response(JSON.stringify(inputAttempts === 1
        ? { inputs: "not-an-array" }
        : { inputs: [], inputRevision: 5 }), {
        status: 200,
        headers: { "content-type": "application/json" },
      });
    }) as unknown as typeof fetch;
    const create = await freshTransport();
    const transport = create("/api", "thread-malformed-resume", { resumeOnConnect: true });
    transport.connect(() => {});

    await vi.waitFor(() => expect(inputAttempts).toBe(2), { timeout: 2_000 });
  });

  it("cancels a scheduled resume retry when that connection disconnects", async () => {
    let inputAttempts = 0;
    globalThis.fetch = vi.fn(async (raw: any) => {
      const requestUrl = String(raw);
      if (requestUrl === "/host-map") return new Response(JSON.stringify({ map: {} }), { status: 200 });
      inputAttempts += 1;
      return new Response(JSON.stringify({ error: "temporarily unavailable" }), {
        status: 500,
        headers: { "content-type": "application/json" },
      });
    }) as unknown as typeof fetch;
    const create = await freshTransport();
    const transport = create("/api", "thread-disconnect-resume", { resumeOnConnect: true });
    const disconnect = transport.connect(() => {});
    await vi.waitFor(() => expect(inputAttempts).toBe(1));
    disconnect();
    await new Promise((resolve) => setTimeout(resolve, 350));
    expect(inputAttempts).toBe(1);
  });

  it("reconnects after a transient reader failure and deduplicates replayed SSE ids", async () => {
    const enc = new TextEncoder();
    let liveAttempts = 0;
    const input = { clientRequestId: "client-network", inputId: "input-network", state: "running" as const };
    globalThis.fetch = vi.fn(async (raw: any) => {
      const requestUrl = String(raw);
      if (requestUrl === "/host-map") return new Response(JSON.stringify({ map: {} }), { status: 200 });
      if (requestUrl.endsWith("/inputs")) return new Response(JSON.stringify({ inputs: [input] }), { status: 200 });
      liveAttempts += 1;
      if (liveAttempts === 1) {
        return new Response(new ReadableStream<Uint8Array>({
          start(controller) {
            controller.enqueue(enc.encode('id: 1\nevent: chunk\ndata: {"text":"hello"}\n\n'));
            controller.error(new Error("mobile network changed"));
          },
        }), { status: 200, headers: { "content-type": "text/event-stream" } });
      }
      return sseResponse([
        'id: 1\nevent: chunk\ndata: {"text":"hello"}\n\n',
        'id: 2\nevent: chunk\ndata: {"text":" world"}\n\n',
        'id: 3\nevent: done\ndata: {"reply":"hello world"}\n\n',
        `id: 4\nevent: input\ndata: ${JSON.stringify({ ...input, state: "settled" })}\n\n`,
      ]);
    }) as unknown as typeof fetch;
    const create = await freshTransport();
    const events: ChatEvent[] = [];
    const settlements: Array<{ recovery: boolean }> = [];
    const transport = create("/api", "thread-network", {
      resumeOnConnect: true,
      onResumeSettled: (result) => { settlements.push(result); },
    });
    transport.connect((event) => events.push(event));
    await vi.waitFor(() => expect(settlements).toEqual([{ recovery: true }]), { timeout: 3_000 });
    expect(liveAttempts).toBe(2);
    expect(events.filter((event) => event.type === "assistant").map((event: any) => event.text)).toEqual([
      "hello",
      "hello world",
      "hello world",
    ]);
  });
});

describe("orchestrator transport: durable input admission", () => {
  it("returns the host receipt and follows only that exact input stream", async () => {
    const calls: { url: string; body: any }[] = [];
    const receipt = {
      clientRequestId: "client-admit",
      inputId: "input-admit",
      state: "queued" as const,
      position: 1,
    };
    const live = [
      `id: 1\nevent: input\ndata: ${JSON.stringify(receipt)}\n\n`,
      `id: 2\nevent: input\ndata: ${JSON.stringify({ ...receipt, state: "running", generationId: "generation-admit" })}\n\n`,
      `id: 3\nevent: chunk\ndata: ${JSON.stringify({ text: "exact answer", inputId: receipt.inputId, generationId: "generation-admit" })}\n\n`,
      `id: 4\nevent: done\ndata: ${JSON.stringify({ reply: "exact answer", inputId: receipt.inputId, generationId: "generation-admit" })}\n\n`,
      `id: 5\nevent: input\ndata: ${JSON.stringify({ ...receipt, state: "settled", generationId: "generation-admit" })}\n\n`,
    ];
    globalThis.fetch = vi.fn(async (raw: any, init: any) => {
      const url = String(raw);
      calls.push({ url, body: init?.body ? JSON.parse(init.body) : undefined });
      if (url === "/host-map") return new Response(JSON.stringify({ map: {} }), { status: 200 });
      if (url === "/api/threads/thread-admit/inputs" && init?.method === "POST") {
        return new Response(JSON.stringify({ input: receipt, duplicate: false }), { status: 202 });
      }
      if (url === "/api/threads/thread-admit/inputs/input-admit/live") return sseResponse(live);
      return new Response("{}", { status: 404 });
    }) as unknown as typeof fetch;

    const transport = createOrchestratorTransport("/api", "thread-admit");
    const events: ChatEvent[] = [];
    transport.connect((event) => events.push(event));
    const admitted = await transport.sendMessage("queue this", {
      clientRequestId: receipt.clientRequestId,
      context: { must: "not cross the admission contract" },
      autonomous: true,
      routing: { target: "sonnet-plan" },
    });
    expect(admitted).toEqual(receipt);
    await vi.waitFor(() => {
      expect(events.some((event: any) => event.type === "input" && event.state === "settled")).toBe(true);
    });
    const admission = calls.find((call) => call.url === "/api/threads/thread-admit/inputs")!;
    expect(admission.body).toMatchObject({
      message: "queue this",
      clientRequestId: "client-admit",
      autonomous: true,
      routing: { target: "sonnet-plan" },
      turnSeq: 1,
    });
    expect(admission.body).not.toHaveProperty("context");
    expect(calls.some((call) => call.url === "/api/chat")).toBe(false);
    expect(events.find((event: any) => event.type === "assistant")).toMatchObject({
      text: "exact answer",
      inputId: "input-admit",
      generationId: "generation-admit",
    });
  });

  it("retries a commit-then-drop with the same clientRequestId and follows one logical admission", async () => {
    const receipt = {
      clientRequestId: "client-commit-drop",
      inputId: "input-commit-drop",
      state: "running" as const,
      generationId: "generation-commit-drop",
    };
    const admissionBodies: Array<Record<string, unknown>> = [];
    const committed = new Map<string, typeof receipt>();
    let liveAttempts = 0;
    globalThis.fetch = vi.fn(async (raw: any, init: any) => {
      const requestUrl = String(raw);
      if (requestUrl === "/host-map") return new Response(JSON.stringify({ map: {} }), { status: 200 });
      if (requestUrl === "/api/threads/thread-commit-drop/inputs" && init?.method === "POST") {
        const body = JSON.parse(init.body) as Record<string, unknown>;
        admissionBodies.push(body);
        const clientRequestId = String(body.clientRequestId);
        if (!committed.has(clientRequestId)) {
          committed.set(clientRequestId, receipt);
          throw new TypeError("response lost after durable commit");
        }
        return new Response(JSON.stringify({ input: committed.get(clientRequestId), duplicate: true }), {
          status: 200,
          headers: { "content-type": "application/json" },
        });
      }
      if (requestUrl === "/api/threads/thread-commit-drop/inputs/input-commit-drop/live") {
        liveAttempts += 1;
        return sseResponse([
          `id: 1\nevent: done\ndata: ${JSON.stringify({ ...receipt, reply: "one answer" })}\n\n`,
          `id: 2\nevent: input\ndata: ${JSON.stringify({ ...receipt, state: "settled" })}\n\n`,
        ]);
      }
      return new Response("{}", { status: 404 });
    }) as unknown as typeof fetch;
    const create = await freshTransport();
    const events: ChatEvent[] = [];
    const transport = create("/api", "thread-commit-drop");
    transport.connect((event) => events.push(event));

    await expect(transport.sendMessage("run once", { clientRequestId: receipt.clientRequestId }))
      .resolves.toEqual(receipt);
    await vi.waitFor(() => expect(liveAttempts).toBe(1));

    expect(admissionBodies).toHaveLength(2);
    expect(admissionBodies[0]).toEqual(admissionBodies[1]);
    expect(admissionBodies.map((body) => body.clientRequestId)).toEqual([
      "client-commit-drop",
      "client-commit-drop",
    ]);
    expect(committed.size).toBe(1);
    expect(new Set(events.filter((event: any) => event.type === "input").map((event: any) => event.inputId)))
      .toEqual(new Set(["input-commit-drop"]));
  });

  it("releases host busy state after rejected admission without starting a follower", async () => {
    let admissionAttempts = 0;
    globalThis.fetch = vi.fn(async (raw: any) => {
      if (String(raw) === "/host-map") return new Response(JSON.stringify({ map: {} }), { status: 200 });
      admissionAttempts += 1;
      return new Response(JSON.stringify({
        error: "This conversation queue is full.",
        failure: {
          source: "web",
          kind: "limit",
          code: "web_input_queue_full",
          text: "This conversation queue is full.",
          retryable: true,
          httpStatus: 429,
        },
      }), {
        status: 429,
        headers: { "content-type": "application/json" },
      });
    }) as unknown as typeof fetch;
    const create = await freshTransport();
    const states: boolean[] = [];
    const transport = create("/api", "thread-rejected", { onResumeState: (active: boolean) => states.push(active) });
    transport.connect(() => {});
    const rejection = transport.sendMessage("too many", { clientRequestId: "client-rejected" });
    await expect(rejection).rejects.toThrow("This conversation queue is full.");
    await expect(rejection).rejects.toMatchObject({
      failure: {
        source: "web",
        kind: "limit",
        code: "web_input_queue_full",
        retryable: true,
        httpStatus: 429,
      },
    });
    expect(admissionAttempts).toBe(1);
    expect(states).toEqual([true, false]);
  });

  it("preserves a typed not-found failure when the thread disappears before admission", async () => {
    globalThis.fetch = vi.fn(async (raw: any) => {
      if (String(raw) === "/host-map") return new Response(JSON.stringify({ map: {} }), { status: 200 });
      return new Response(JSON.stringify({
        error: "This conversation no longer exists.",
        failure: {
          source: "web",
          kind: "not_found",
          code: "web_thread_not_found",
          text: "This conversation no longer exists.",
          retryable: false,
          httpStatus: 404,
        },
      }), { status: 404, headers: { "content-type": "application/json" } });
    }) as unknown as typeof fetch;
    const create = await freshTransport();
    const transport = create("/api", "thread-deleted");
    transport.connect(() => {});
    const rejection = transport.sendMessage("race deletion", { clientRequestId: "client-deleted" });
    await expect(rejection).rejects.toMatchObject({
      failure: {
        source: "web",
        kind: "not_found",
        code: "web_thread_not_found",
        retryable: false,
        httpStatus: 404,
      },
    });
  });

  it("aborts admission on disconnect and never starts an orphan follower", async () => {
    const calls: string[] = [];
    globalThis.fetch = vi.fn(async (raw: any, init: any) => {
      const requestUrl = String(raw);
      calls.push(requestUrl);
      if (requestUrl === "/host-map") return new Response(JSON.stringify({ map: {} }), { status: 200 });
      return await new Promise<Response>((_resolve, reject) => {
        init.signal.addEventListener("abort", () => reject(new DOMException("aborted", "AbortError")), { once: true });
      });
    }) as unknown as typeof fetch;
    const create = await freshTransport();
    const states: boolean[] = [];
    const transport = create("/api", "thread-switch", { onResumeState: (active: boolean) => states.push(active) });
    const disconnect = transport.connect(() => {});
    const admission = transport.sendMessage("leave now", { clientRequestId: "client-switch" });
    await vi.waitFor(() => expect(states).toEqual([true]));
    disconnect();
    await expect(admission).rejects.toThrow(/aborted|disconnected/i);
    expect(states).toEqual([true, false]);
    expect(calls.some((requestUrl) => requestUrl.endsWith("/live"))).toBe(false);
  });

  it("aborts an admission retry backoff on disconnect", async () => {
    let admissionAttempts = 0;
    let observedAttempt!: () => void;
    const attempted = new Promise<void>((resolve) => { observedAttempt = resolve; });
    globalThis.fetch = vi.fn(async (raw: any) => {
      const requestUrl = String(raw);
      if (requestUrl === "/host-map") return new Response(JSON.stringify({ map: {} }), { status: 200 });
      admissionAttempts += 1;
      observedAttempt();
      throw new TypeError("ambiguous network loss");
    }) as unknown as typeof fetch;
    const create = await freshTransport();
    const transport = create("/api", "thread-disconnect-backoff");
    const disconnect = transport.connect(() => {});
    const admission = transport.sendMessage("do not retry elsewhere", { clientRequestId: "client-disconnect-backoff" });
    await attempted;
    disconnect();

    await expect(admission).rejects.toThrow(/aborted|disconnected/i);
    await new Promise((resolve) => setTimeout(resolve, 150));
    expect(admissionAttempts).toBe(1);
  });
});

describe("orchestrator transport: interrupt (contract §9)", () => {
  it("POSTs the exact generation to the thread-bound interrupt endpoint", async () => {
    const calls = recordingFetch([]);
    const t = createOrchestratorTransport("/api", "thread-stop");
    await t.interrupt({ generationId: "generation-stop" });
    expect(calls).toEqual([{ url: "/api/threads/thread-stop/interrupt", method: "POST", body: { generationId: "generation-stop" } }]);
  });

  it("surfaces a stale/refused stop so the exact turn can offer retry", async () => {
    globalThis.fetch = vi.fn(async () => new Response(JSON.stringify({ ok: false, error: "no-active-turn" }), { status: 404 })) as unknown as typeof fetch;
    const t = createOrchestratorTransport("/api", "thread-stop2");
    await expect(t.interrupt({ generationId: "generation-stale" })).rejects.toThrow("no-active-turn");
  });
});

describe("createHttpTransport (rich path): answerQuestion", () => {
  it("POSTs the answer to <base>/claude/answer", async () => {
    const calls: { url: string; body: any }[] = [];
    globalThis.fetch = vi.fn(async (url: any, init: any) => {
      calls.push({ url: String(url), body: init?.body ? JSON.parse(init.body) : {} });
      return new Response("{}", { status: 200 });
    }) as unknown as typeof fetch;

    const t = createHttpTransport("/api");
    await t.answerQuestion!({ toolUseId: "toolu_2", label: "B" });

    expect(calls).toHaveLength(1);
    expect(calls[0].url).toBe("/api/claude/answer");
    expect(calls[0].body).toMatchObject({ tool_use_id: "toolu_2", label: "B" });
  });

  it("throws a structured ChatTransportError for a typed HTTP admission failure", async () => {
    const failure = {
      source: "web" as const,
      kind: "rate_limit" as const,
      code: "QUEUE_RATE_LIMITED",
      text: "The message could not enter the queue yet.",
      retryable: true,
      httpStatus: 429,
      retryAt: 1_787_000_000,
    };
    globalThis.fetch = vi.fn(async () => new Response(JSON.stringify({ failure }), {
      status: 429,
      headers: { "content-type": "application/json" },
    })) as unknown as typeof fetch;
    const transport = createHttpTransport("/api");
    await expect(transport.sendMessage("queued request")).rejects.toMatchObject({
      name: "ChatTransportError",
      message: failure.text,
      failure,
    });
    await transport.sendMessage("queued request").catch((error) => {
      expect(error).toBeInstanceOf(ChatTransportError);
    });
  });
});

describe("createHttpTransport (rich path): canonical session events", () => {
  it("forwards an exact canonical EventSource payload and ignores malformed frames", () => {
    const originalEventSource = globalThis.EventSource;
    const sources: FakeEventSource[] = [];

    class FakeEventSource {
      static readonly CLOSED = 2;
      readonly url: string;
      readyState = 1;
      onerror: ((event: Event) => void) | null = null;
      private readonly listeners = new Map<string, Array<(event: MessageEvent) => void>>();

      constructor(url: string | URL) {
        this.url = String(url);
        sources.push(this);
      }

      addEventListener(name: string, listener: (event: MessageEvent) => void) {
        const current = this.listeners.get(name) ?? [];
        current.push(listener);
        this.listeners.set(name, current);
      }

      emit(name: string, data: string) {
        for (const listener of this.listeners.get(name) ?? []) listener({ data } as MessageEvent);
      }

      close() {}
    }

    const canonical: SessionEvent = {
      id: "http-session-event",
      role: "assistant",
      ts: 1_786_880_000_000,
      turnId: "7",
      sessionId: "session-http",
      order: 1,
      revision: 1,
      blocks: [{ type: "text", text: "exact payload" }],
    };

    try {
      (globalThis as any).EventSource = FakeEventSource;
      const transport = createHttpTransport("/api");
      const events: ChatEvent[] = [];
      const disconnect = transport.connect((event) => events.push(event));
      expect(sources).toHaveLength(1);
      expect(sources[0].url).toBe("/api/claude/stream");

      sources[0].emit("session_event", JSON.stringify(canonical));
      sources[0].emit("session_event", "{not-json");
      sources[0].emit("session_event", JSON.stringify({ id: "missing-blocks", role: "assistant", ts: 1 }));
      const failure = {
        source: "transport",
        kind: "protocol",
        code: "STREAM_PROTOCOL_ERROR",
        text: "The stream returned an invalid frame.",
        retryable: false,
      };
      sources[0].emit("error", JSON.stringify({ failure, inputId: "input-7", generationId: "generation-7" }));
      sources[0].emit("error", JSON.stringify({ failure: { ...failure, kind: "made_up" } }));

      expect(events.filter((event) => event.type === "session_event")).toEqual([
        { type: "session_event", event: canonical },
      ]);
      expect(Object.keys(events.find((event) => event.type === "session_event") ?? {}).sort()).toEqual(["event", "type"]);
      expect(events.filter((event) => event.type === "error")).toEqual([{
        type: "error",
        failure,
        inputId: "input-7",
        generationId: "generation-7",
      }]);
      disconnect();
    } finally {
      if (originalEventSource === undefined) delete (globalThis as any).EventSource;
      else globalThis.EventSource = originalEventSource;
    }
  });
});
