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
      { type: "error", message: "chat stream ended without a completion event" },
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
      { type: "error", message: "the gateway stream ended without a done event" },
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
  it("uses the normal reducer, preserves replace, restamps route seq, and owns busy state", async () => {
    const replayEvent = canonicalFixtureEvents("77").find((event: any) =>
      event.blocks.some((block: any) => block.type === "tool_use" && block.name === "Write")
    );
    const frames = [
      `id: 1\nevent: route\ndata: ${JSON.stringify({ runtime: "agent-sdk", session_id: "sess-live", turnSeq: 77, pending: true })}\n\n`,
      `id: 2\nevent: session_event\ndata: ${JSON.stringify(replayEvent)}\n\n`,
      `id: 3\nevent: chunk\ndata: ${JSON.stringify({ text: "draft " })}\n\n`,
      `id: 4\nevent: chunk\ndata: ${JSON.stringify({ text: "clean", replace: true })}\n\n`,
      `id: 5\nevent: chunk\ndata: ${JSON.stringify({ text: " answer" })}\n\n`,
      `id: 6\nevent: done\ndata: ${JSON.stringify({ reply: "clean answer", runtime: "agent-sdk", session_id: "sess-live", turnSeq: 77 })}\n\n`,
    ];
    const calls: string[] = [];
    globalThis.fetch = vi.fn(async (raw: any) => {
      const u = String(raw);
      calls.push(u);
      if (u === "/host-map") {
        return new Response(JSON.stringify({ map: {} }), { status: 200, headers: { "content-type": "application/json" } });
      }
      if (u === "/api/threads/thread-resume/live") return sseResponse(frames);
      return new Response("{}", { status: 404 });
    }) as unknown as typeof fetch;
    const create = await freshTransport();
    const events: ChatEvent[] = [];
    const states: boolean[] = [];
    let settled!: () => void;
    const finished = new Promise<void>((resolve) => { settled = resolve; });
    const transport = create("/api", "thread-resume", {
      resumeOnConnect: true,
      onResumeState: (active: boolean) => states.push(active),
      onResumeSettled: settled,
    });
    transport.connect((event) => events.push(event));
    await finished;

    expect(calls).toContain("/api/threads/thread-resume/live");
    expect(states).toEqual([true, false]);
    expect(events.filter((event) => event.type === "turn").map((event: any) => event.active)).toEqual([true, false]);
    expect(events.filter((event) => event.type === "assistant").map((event: any) => event.text)).toEqual([
      "draft ",
      "clean",
      "clean answer",
      "clean answer",
    ]);
    // The wire came from another client's send #77. Restored history is seq 0,
    // so both route frames are deliberately rebound to 0 before ClaudeChat sees them.
    expect(events.filter((event) => event.type === "route").map((event: any) => event.turnSeq)).toEqual([0, 0]);
    const restored = events.find((event: any) => event.type === "session_event") as any;
    expect(restored.event).toEqual({ ...replayEvent, turnId: "0" });
    expect(restored.event.blocks).toEqual(replayEvent.blocks);
  });
});

describe("orchestrator transport: interrupt (contract §9)", () => {
  it("POSTs the thread id to /api/chat/interrupt", async () => {
    const calls = recordingFetch([]);
    const t = createOrchestratorTransport("/api", "thread-stop");
    await t.interrupt();
    expect(calls).toEqual([{ url: "/api/chat/interrupt", method: "POST", body: { thread: "thread-stop" } }]);
  });

  it("treats a refusal as done - Stop must never throw at the UI", async () => {
    globalThis.fetch = vi.fn(async () => new Response(JSON.stringify({ ok: false, error: "no-active-turn" }), { status: 404 })) as unknown as typeof fetch;
    const t = createOrchestratorTransport("/api", "thread-stop2");
    await expect(t.interrupt()).resolves.toBeUndefined();
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

      expect(events.filter((event) => event.type === "session_event")).toEqual([
        { type: "session_event", event: canonical },
      ]);
      expect(Object.keys(events.find((event) => event.type === "session_event") ?? {}).sort()).toEqual(["event", "type"]);
      disconnect();
    } finally {
      if (originalEventSource === undefined) delete (globalThis as any).EventSource;
      else globalThis.EventSource = originalEventSource;
    }
  });
});
