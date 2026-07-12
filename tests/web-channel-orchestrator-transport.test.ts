// D28 — the chat transports surface the AskUserQuestion `tool` event and route
// the answer to the gateway. Driven with a mocked fetch (no live gateway):
//   - the orchestrator transport (web-channel default path) parses a `tool` SSE
//     frame into a ChatEvent and posts answers to /api/chat/answer;
//   - createHttpTransport (rich /claude/* path) posts answers to /api/claude/answer.

import { describe, it, expect, afterEach, vi } from "vitest";
import type { ChatEvent } from "@garrison/claude-chat";
import { createHttpTransport } from "@garrison/claude-chat";
import { createOrchestratorTransport } from "../fittings/seed/web-channel-default/ui/orchestrator-transport";

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
});

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
