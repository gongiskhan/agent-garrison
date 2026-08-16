import { describe, expect, it } from "vitest";
import { readFileSync } from "node:fs";
import { fileURLToPath } from "node:url";
// @ts-ignore — the fitting is intentionally dependency-free JavaScript.
import { AgentSdkAdapter } from "../fittings/seed/agent-sdk-runtime/lib/agent-sdk-adapter.mjs";
// @ts-ignore — the fitting is intentionally dependency-free JavaScript.
import { AgentSdkSessionEventNormalizer, SESSION_TEXT_BLOCK_CAP } from "../fittings/seed/agent-sdk-runtime/lib/session-events.mjs";

const FIXTURE = JSON.parse(
  readFileSync(fileURLToPath(new URL("./fixtures/agent-sdk-web-parity-events.json", import.meta.url)), "utf8")
);

function generator(messages: any[]) {
  return (async function* () {
    for (const message of messages) yield message;
  })();
}

function blocks(events: any[], type: string) {
  return events.flatMap((event) => event.blocks.map((block: any) => ({ event, block }))).filter((row) => row.block.type === type);
}

function latestById(events: any[]) {
  const latest = new Map<string, any>();
  for (const event of events) latest.set(event.id, event);
  return latest;
}

describe("Agent SDK channel-neutral session events", () => {
  it("normalizes the authentic two-tool fixture without changing legacy adapter behavior", async () => {
    let queryOptions: any = null;
    const adapter = new AgentSdkAdapter({
      createClient: async ({ options }: any) => {
        queryOptions = options;
        return generator(FIXTURE.messages);
      }
    });
    const session = await adapter.spawn({
      provider: "ollama-local",
      model: "qwen3:8b",
      compositionDir: "/tmp"
    });
    const events: any[] = [];
    const growingText: string[] = [];
    const legacyTools: any[] = [];
    const announcedSessions: string[] = [];

    await adapter.sendTurn(session, "fixture prompt", {
      turnId: "turn-fixture",
      onEvent: async (event: any) => events.push(event),
      onText: (text: string) => growingText.push(text),
      onTool: (tool: any) => legacyTools.push(tool),
      onSession: (sessionId: string) => announcedSessions.push(sessionId)
    });
    const response = await adapter.awaitResponse(session);

    expect(queryOptions.includePartialMessages).toBe(true);
    expect(response).toMatchObject({
      text: "WEB_PARITY_FIXTURE",
      toolUses: [
        { id: "tool-15", name: "Write" },
        { id: "tool-30", name: "Read" }
      ],
      stoppedReason: null
    });
    expect(growingText.at(-1)).toBe("WEB_PARITY_FIXTURE");
    expect(legacyTools.map((tool) => tool.name)).toEqual(["Write", "Read"]);
    expect(announcedSessions).toEqual(["session-2"]);
    expect(session.sessionId).toBe("session-53");

    const writeRevisions = events.filter((event) => event.id === "message-13");
    const readRevisions = events.filter((event) => event.id === "message-28");
    const textRevisions = events.filter((event) => event.id === "message-43");
    expect(writeRevisions[0].blocks).toEqual([
      { type: "tool_use", toolUseId: "tool-15", name: "Write", input: "" }
    ]);
    expect(readRevisions[0].blocks).toEqual([
      { type: "tool_use", toolUseId: "tool-30", name: "Read", input: "" }
    ]);
    expect(writeRevisions.at(-1).blocks[0].input).toContain("WEB_PARITY_FIXTURE");
    expect(readRevisions.at(-1).blocks[0].input).toContain("fixture-note.txt");
    expect(textRevisions.some((event) => event.blocks[0]?.text === "W")).toBe(true);
    expect(textRevisions.at(-1).blocks).toEqual([{ type: "text", text: "WEB_PARITY_FIXTURE" }]);

    for (const revisions of [writeRevisions, readRevisions, textRevisions]) {
      expect(new Set(revisions.map((event) => event.order)).size).toBe(1);
      expect(revisions.map((event) => event.revision)).toEqual(revisions.map((_event, index) => index + 1));
      expect(revisions.every((event) => event.turnId === "turn-fixture")).toBe(true);
    }

    const settled = latestById(events);
    expect([...settled.keys()].filter((id) => id.startsWith("message-"))).toEqual([
      "message-13",
      "message-28",
      "message-43"
    ]);
    // Settled SDK envelopes reuse their model message id; their wire UUID does
    // not create a duplicate assistant event beside the partial revisions.
    expect(settled.has("uuid-20")).toBe(false);
    expect(settled.has("uuid-36")).toBe(false);
    expect(settled.has("uuid-47")).toBe(false);

    const toolResults = blocks(events, "tool_result");
    expect(toolResults.map(({ block }) => block.toolUseId)).toEqual(["tool-15", "tool-30"]);
    expect(toolResults.every(({ event }) => event.role === "user" && event.toolResultsOnly === true)).toBe(true);
    expect(toolResults.at(-1)?.block.text).toContain("WEB_PARITY_FIXTURE");

    expect(blocks(events, "rate_limit").map(({ block }) => block)).toEqual([
      expect.objectContaining({ status: "allowed", rateLimitType: "five_hour", resetsAt: 1786881000 })
    ]);
    expect(blocks(events, "turn_end").map(({ event, block }) => ({ event, block }))).toEqual([
      expect.objectContaining({
        event: expect.objectContaining({ id: "uuid-52", sessionId: "session-53" }),
        block: expect.objectContaining({ status: "completed", subtype: "success", stopReason: "end_turn" })
      })
    ]);

    const firstWrite = events.findIndex((event) => event.id === "message-13");
    const writeResult = events.findIndex((event) => event.id === "uuid-25");
    const firstRead = events.findIndex((event) => event.id === "message-28");
    const readResult = events.findIndex((event) => event.id === "uuid-40");
    expect(firstWrite).toBeLessThan(writeResult);
    expect(writeResult).toBeLessThan(firstRead);
    expect(firstRead).toBeLessThan(readResult);
  });

  it("normalizes image results, thinking deltas, progress, status, and honest truncation", () => {
    const normalizer = new AgentSdkSessionEventNormalizer({ turnId: "turn-synthetic", now: () => 1234 });
    const longText = "x".repeat(SESSION_TEXT_BLOCK_CAP + 7);
    const events = [
      ...normalizer.push({
        type: "stream_event",
        uuid: "stream-start",
        session_id: "session-synthetic",
        event: { type: "message_start", message: { id: "message-thinking", content: [] } }
      }),
      ...normalizer.push({
        type: "stream_event",
        uuid: "thinking-start",
        session_id: "session-synthetic",
        event: { type: "content_block_start", index: 0, content_block: { type: "thinking", thinking: "" } }
      }),
      ...normalizer.push({
        type: "stream_event",
        uuid: "thinking-delta-1",
        session_id: "session-synthetic",
        event: { type: "content_block_delta", index: 0, delta: { type: "thinking_delta", thinking: "inspect" } }
      }),
      ...normalizer.push({
        type: "stream_event",
        uuid: "thinking-delta-2",
        session_id: "session-synthetic",
        event: { type: "content_block_delta", index: 0, delta: { type: "thinking_delta", thinking: " carefully" } }
      }),
      ...normalizer.push({
        type: "user",
        uuid: "result-with-image",
        session_id: "session-synthetic",
        message: {
          content: [
            {
              type: "tool_result",
              tool_use_id: "tool-image",
              content: [
                { type: "text", text: longText },
                { type: "image", source: { type: "base64", media_type: "image/png", data: "aW1hZ2U=" } }
              ]
            }
          ]
        }
      }),
      ...normalizer.push({
        type: "tool_progress",
        uuid: "progress-1",
        session_id: "session-synthetic",
        tool_use_id: "tool-image",
        tool_name: "Bash",
        elapsed_time_seconds: 1.25
      }),
      ...normalizer.push({
        type: "auth_status",
        uuid: "auth-1",
        session_id: "session-synthetic",
        output: []
      })
    ];

    expect(events.filter((event) => event.id === "message-thinking").at(-1).blocks).toEqual([
      { type: "thinking", text: "inspect carefully" }
    ]);
    const result = blocks(events, "tool_result")[0];
    expect(result.event.toolResultsOnly).toBe(true);
    expect(result.block.text).toBe(`${"x".repeat(SESSION_TEXT_BLOCK_CAP)}\n… [truncated 7 chars]`);
    expect(result.block.images).toEqual([{ mediaType: "image/png", data: "aW1hZ2U=" }]);
    expect(blocks(events, "tool_progress")[0].block).toMatchObject({
      toolUseId: "tool-image",
      name: "Bash",
      elapsedMs: 1250,
      status: "running"
    });
    expect(blocks(events, "status").at(-1)?.block).toMatchObject({ subtype: "auth_status" });
    expect(events.every((event) => event.ts === 1234)).toBe(true);
  });

  it("namespaces fallback and terminal ids when browser turn ids repeat", () => {
    const first = new AgentSdkSessionEventNormalizer({
      turnId: "1",
      eventScope: "scope-first",
      now: () => 100,
    });
    const second = new AgentSdkSessionEventNormalizer({
      turnId: "1",
      eventScope: "scope-second",
      now: () => 200,
    });

    const firstEvents = [...first.push(null), ...first.finish()];
    const secondEvents = [...second.push(null), ...second.finish()];
    const firstIds = firstEvents.map((event: any) => event.id);
    const secondIds = secondEvents.map((event: any) => event.id);

    expect(firstIds).toEqual([
      "session:scope-first:1:1",
      "turn:scope-first:1:end",
    ]);
    expect(secondIds).toEqual([
      "session:scope-second:1:1",
      "turn:scope-second:1:end",
    ]);
    expect(firstIds.filter((id: string) => secondIds.includes(id))).toEqual([]);
  });

  it("isolates throwing and rejecting onEvent consumers", async () => {
    let calls = 0;
    const adapter = new AgentSdkAdapter({
      createClient: async () =>
        generator([
          { type: "assistant", uuid: "assistant-1", message: { id: "message-1", content: [{ type: "text", text: "done" }] } },
          { type: "result", uuid: "result-1", subtype: "success", result: "done", usage: { output_tokens: 1 } }
        ])
    });
    const session = await adapter.spawn({ provider: "ollama-local", model: "m", compositionDir: "/tmp" });
    await adapter.sendTurn(session, "go", {
      onEvent: () => {
        calls += 1;
        if (calls === 1) throw new Error("sync sink failure");
        return Promise.reject(new Error("async sink failure"));
      }
    });
    await expect(adapter.awaitResponse(session)).resolves.toMatchObject({ text: "done" });
    expect(calls).toBe(2);
  });

  it("surfaces an iterator crash even when it follows a successful result", async () => {
    const adapter = new AgentSdkAdapter({
      createClient: async () =>
        (async function* () {
          yield {
            type: "result",
            uuid: "result-before-crash",
            subtype: "success",
            is_error: false,
            result: "apparently done",
            stop_reason: "end_turn",
            usage: { output_tokens: 1 }
          };
          throw new Error("subprocess crashed after result");
        })()
    });
    const session = await adapter.spawn({ provider: "ollama-local", model: "m", compositionDir: "/tmp" });
    const events: any[] = [];
    await adapter.sendTurn(session, "go", { turnId: "crash-turn", onEvent: (event: any) => events.push(event) });
    await expect(adapter.awaitResponse(session)).rejects.toThrow("subprocess crashed after result");

    expect(blocks(events, "turn_end")).toHaveLength(1);
    expect(blocks(events, "error").at(-1)?.block).toEqual({
      type: "error",
      kind: "runtime_error",
      text: "subprocess crashed after result"
    });
  });
});
