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
      generationId: "generation-fixture",
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
        event: expect.objectContaining({ id: 'terminal:["generation-fixture"]', sessionId: "session-53" }),
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

  it("preserves retry/rate-limit fields and maps assistant failures without provider secrets", () => {
    const normalizer = new AgentSdkSessionEventNormalizer({
      generationId: "generation-errors",
      sessionId: "session-errors",
      now: () => 2222,
    });
    const events = [
      ...normalizer.push({
        type: "system",
        subtype: "api_retry",
        uuid: "retry-1",
        session_id: "session-errors",
        attempt: 2,
        max_retries: 5,
        retry_delay_ms: 1750,
        error_status: null,
        error: "overloaded",
      }),
      ...normalizer.push({
        type: "system",
        subtype: "api_retry",
        uuid: "retry-2",
        session_id: "session-errors",
        attempt: 3,
        max_retries: 5,
        retry_delay_ms: 2500,
        error_status: 503,
        error: "server_error",
      }),
      ...normalizer.push({
        type: "rate_limit_event",
        uuid: "limit-1",
        session_id: "session-errors",
        rate_limit_info: {
          status: "allowed_warning",
          resetsAt: 2000,
          rateLimitType: "seven_day_opus",
          utilization: 0.91,
          overageStatus: "rejected",
          overageResetsAt: 3000,
          overageDisabledReason: "out_of_credits",
          isUsingOverage: false,
          overageInUse: true,
          surpassedThreshold: 0.9,
        },
      }),
      ...normalizer.push({
        type: "assistant",
        uuid: "assistant-error-wire",
        session_id: "session-errors",
        request_id: "request-safe",
        error: "rate_limit",
        message: { id: "assistant-error", model: "claude-a", content: [] },
      }),
    ];

    expect(blocks(events, "retry")[0].block).toEqual({
      type: "retry",
      kind: "api",
      text: "API request retrying (2/5) in 1750 ms.",
      attempt: 2,
      maxAttempts: 5,
      delayMs: 1750,
      httpStatus: null,
      errorKind: "overloaded",
    });
    expect(blocks(events, "retry")[1].block).toMatchObject({
      attempt: 3,
      maxAttempts: 5,
      delayMs: 2500,
      httpStatus: 503,
      errorKind: "server_error",
    });
    expect(blocks(events, "rate_limit")[0].block).toEqual({
      type: "rate_limit",
      status: "allowed_warning",
      resetsAt: 2000,
      rateLimitType: "seven_day_opus",
      utilization: 0.91,
      overageStatus: "rejected",
      overageResetsAt: 3000,
      overageDisabledReason: "out_of_credits",
      isUsingOverage: false,
      overageInUse: true,
      surpassedThreshold: 0.9,
    });
    expect(blocks(events, "error")[0].block).toEqual({
      type: "error",
      source: "assistant",
      kind: "rate_limit",
      code: "rate_limit",
      text: "Assistant request failed: rate_limit.",
      retryable: true,
      requestId: "request-safe",
    });
  });

  it("maps every pinned assistant error code into the closed provider-neutral failure vocabulary", () => {
    const expected = {
      authentication_failed: ["authentication", false],
      oauth_org_not_allowed: ["authorization", false],
      billing_error: ["billing", false],
      rate_limit: ["rate_limit", true],
      overloaded: ["overloaded", true],
      invalid_request: ["invalid_request", false],
      model_not_found: ["not_found", false],
      server_error: ["transport", true],
      unknown: ["unknown", false],
      max_output_tokens: ["limit", false],
    } as const;

    for (const [code, [kind, retryable]] of Object.entries(expected)) {
      const normalizer = new AgentSdkSessionEventNormalizer({ generationId: `generation-${code}` });
      const event = normalizer.push({
        type: "assistant",
        uuid: `wire-${code}`,
        error: code,
        message: { id: `assistant-${code}`, content: [] },
      })[0];
      expect(event.blocks).toEqual([expect.objectContaining({
        type: "error",
        source: "assistant",
        kind,
        code,
        retryable,
      })]);
    }
  });

  it("freezes the first timestamp/order across assistant revisions", () => {
    const normalizer = new AgentSdkSessionEventNormalizer({ generationId: "generation-revisions" });
    const first = normalizer.push({
      type: "assistant",
      uuid: "wire-revision-1",
      timestamp: "2026-08-16T10:00:00.000Z",
      message: { id: "assistant-revision", content: [{ type: "text", text: "first" }] },
    })[0];
    const second = normalizer.push({
      type: "assistant",
      uuid: "wire-revision-2",
      timestamp: "2026-08-16T10:01:00.000Z",
      message: { id: "assistant-revision", content: [{ type: "text", text: "second" }] },
    })[0];

    expect(second).toMatchObject({
      id: first.id,
      ts: first.ts,
      order: first.order,
      revision: 2,
    });
  });

  it("turns refusal fallback wire UUIDs into bounded canonical tombstones and exposes the observed model", () => {
    const normalizer = new AgentSdkSessionEventNormalizer({ generationId: "generation-fallback" });
    normalizer.push({
      type: "assistant",
      uuid: "wire-refused",
      session_id: "session-fallback",
      message: { id: "assistant-refused", model: "claude-primary", content: [{ type: "text", text: "refused leg" }] },
    });
    const [replacement] = normalizer.push({
      type: "assistant",
      uuid: "wire-replacement",
      session_id: "session-fallback",
      supersedes: ["wire-refused", "wire-unknown"],
      message: { id: "assistant-replacement", model: "claude-fallback", content: [{ type: "text", text: "replacement" }] },
    });
    const [fallback] = normalizer.push({
      type: "system",
      subtype: "model_refusal_fallback",
      uuid: "fallback-notice",
      session_id: "session-fallback",
      trigger: "refusal",
      direction: "retry",
      original_model: "claude-primary",
      fallback_model: "claude-fallback",
      request_id: "request-fallback",
      retracted_message_uuids: ["wire-refused", "wire-replacement", "wire-unknown"],
      content: "Retrying safely.",
    });

    expect(replacement.retracts).toEqual(["assistant-refused"]);
    expect(fallback.retracts).toEqual(["assistant-refused", "assistant-replacement"]);
    expect(fallback.blocks).toEqual([{
      type: "retry",
      kind: "model_fallback",
      text: "Retrying safely.",
      fromModel: "claude-primary",
      toModel: "claude-fallback",
      direction: "retry",
      requestId: "request-fallback",
    }]);
    expect(normalizer.model).toBe("claude-fallback");

    const bounded = new AgentSdkSessionEventNormalizer({ generationId: "generation-bounded-retracts" });
    for (let index = 0; index < 70; index += 1) {
      bounded.push({
        type: "assistant",
        uuid: `wire-bounded-${index}`,
        message: { id: `assistant-bounded-${index}`, content: [{ type: "text", text: String(index) }] },
      });
    }
    const [boundedFallback] = bounded.push({
      type: "system",
      subtype: "model_refusal_fallback",
      uuid: "bounded-fallback",
      original_model: "primary",
      fallback_model: "fallback",
      retracted_message_uuids: Array.from({ length: 70 }, (_value, index) => `wire-bounded-${index}`),
      content: "bounded",
    });
    expect(boundedFallback.retracts).toHaveLength(64);
    expect(boundedFallback.retracts.at(-1)).toBe("assistant-bounded-63");
  });

  it("keeps provider result facts separate from host reason and revises one terminal slot on runtime failure", () => {
    const normalizer = new AgentSdkSessionEventNormalizer({
      generationId: "generation-terminal",
      now: () => 4444,
    });
    const result = {
      type: "result",
      uuid: "provider-result-wire",
      subtype: "error_max_budget_usd",
      is_error: true,
      stop_reason: "max_budget_usd",
      terminal_reason: "blocking_limit",
      errors: ["Provider budget was exhausted."],
    };
    const [providerTerminal] = normalizer.finishResult(result, "budget_exceeded");
    expect(providerTerminal).toMatchObject({
      id: 'terminal:["generation-terminal"]',
      revision: 1,
      blocks: [
        expect.objectContaining({ source: "result", kind: "limit", code: "error_max_budget_usd" }),
        expect.objectContaining({
          type: "turn_end",
          status: "error",
          subtype: "error_max_budget_usd",
          reason: "budget_exceeded",
          stopReason: "max_budget_usd",
          terminalReason: "blocking_limit",
        }),
      ],
    });

    const [runtimeTerminal] = normalizer.runtimeError(new Error("iterator integrity failure"), {
      resultMessage: result,
    });
    expect(runtimeTerminal).toMatchObject({
      id: providerTerminal.id,
      ts: providerTerminal.ts,
      order: providerTerminal.order,
      revision: 2,
      blocks: [
        expect.objectContaining({ source: "runtime", code: "runtime_error" }),
        expect.objectContaining({
          type: "turn_end",
          status: "error",
          subtype: "error_max_budget_usd",
          stopReason: "max_budget_usd",
          terminalReason: "blocking_limit",
        }),
      ],
    });

    const apiFailure = new AgentSdkSessionEventNormalizer({ generationId: "generation-api-failure" });
    const [apiTerminal] = apiFailure.finishResult({
      type: "result",
      subtype: "success",
      is_error: true,
      api_error_status: 503,
      stop_reason: null,
      result: "partial",
    });
    expect(apiTerminal.blocks).toEqual([
      expect.objectContaining({
        type: "error",
        source: "result",
        kind: "execution",
        code: "success",
        httpStatus: 503,
        retryable: true,
      }),
      expect.objectContaining({ type: "turn_end", status: "error", subtype: "success" }),
    ]);
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
      'terminal:["scope-first","1"]',
    ]);
    expect(secondIds).toEqual([
      "session:scope-second:1:1",
      'terminal:["scope-second","1"]',
    ]);
    expect(firstIds.filter((id: string) => secondIds.includes(id))).toEqual([]);
  });

  it("finalizes a buffered standing result only after postlude events and carries generation authority on every event", () => {
    const normalizer = new AgentSdkSessionEventNormalizer({
      turnId: "turn-standing",
      generationId: "generation-standing",
      sessionId: "session-standing",
      eventScope: "scope-standing",
      now: () => 7654,
    });
    const events = [
      ...normalizer.push({
        type: "assistant",
        uuid: "assistant-standing",
        session_id: "session-standing",
        message: { content: [{ type: "text", text: "answer" }] },
      }),
      // The adapter deliberately withholds result here and continues through the
      // SDK-permitted post-result prompt suggestion.
      ...normalizer.push({
        type: "prompt_suggestion",
        uuid: "suggestion-standing",
        session_id: "session-standing",
        suggestion: "follow up",
      }),
    ];
    expect(events.flatMap((event) => event.blocks).some((block) => block.type === "turn_end")).toBe(false);
    events.push(...normalizer.finishResult({
      type: "result",
      uuid: "result-standing",
      session_id: "session-standing",
      subtype: "success",
      result: "answer",
      stop_reason: "end_turn",
    }));

    expect(events.map((event) => event.generationId)).toEqual([
      "generation-standing",
      "generation-standing",
      "generation-standing",
    ]);
    expect(events.map((event) => event.order)).toEqual([1, 2, 3]);
    expect(events.at(-1)?.blocks).toEqual([
      expect.objectContaining({ type: "turn_end", status: "completed", result: "answer" }),
    ]);
    expect(normalizer.finishResult({ type: "result", subtype: "success" })).toEqual([]);

    const cancelled = new AgentSdkSessionEventNormalizer({ generationId: "generation-cancelled" });
    const [terminal] = cancelled.finishResult({
      type: "result",
      uuid: "result-cancelled",
      subtype: "success",
      result: "partial",
    }, "cancelled");
    expect(terminal).toMatchObject({
      generationId: "generation-cancelled",
      blocks: [expect.objectContaining({
        type: "turn_end",
        status: "cancelled",
        subtype: "success",
        reason: "cancelled",
        stopReason: null,
      })],
    });
  });

  it("revises one stable permission event from pending to resolved", () => {
    const normalizer = new AgentSdkSessionEventNormalizer({
      turnId: "turn-permission",
      sessionId: "session-permission",
      eventScope: "scope-permission",
      now: () => 4321,
    });
    const [pending] = normalizer.permissionRequest({
      requestId: "request-1",
      generationId: "generation-1",
      toolUseId: "tool-1",
      name: "Bash",
      input: '{"command":"pwd"}',
      suggestions: [{ type: "addRules", destination: "session" }],
    });
    const [resolved] = normalizer.resolvePermissionRequest("request-1", "allow_always");

    expect(pending).toMatchObject({
      id: 'permission:["generation-1","request-1"]',
      role: "assistant",
      ts: 4321,
      turnId: "turn-permission",
      sessionId: "session-permission",
      order: 1,
      revision: 1,
      blocks: [expect.objectContaining({ type: "permission_request", status: "pending" })],
    });
    expect(resolved).toMatchObject({
      id: pending.id,
      ts: pending.ts,
      order: pending.order,
      revision: 2,
      blocks: [expect.objectContaining({ status: "resolved", decision: "allow_always" })],
    });
    expect(normalizer.cancelPermissionRequest("request-1")).toEqual([]);
  });

  it("namespaces reused permission request ids by the gateway generation", () => {
    const make = (generationId: string) => new AgentSdkSessionEventNormalizer({
      turnId: "1",
      sessionId: "session-reused",
      eventScope: "scope-reused",
      now: () => 4321,
    }).permissionRequest({
      requestId: "request-reused",
      generationId,
      name: "Read",
      input: '{"file_path":"notes.txt"}',
      inputComplete: true,
      suggestionsComplete: true,
    })[0];

    const first = make("generation-first");
    const second = make("generation-second");
    expect(first.id).toBe('permission:["generation-first","request-reused"]');
    expect(second.id).toBe('permission:["generation-second","request-reused"]');
    expect(second.id).not.toBe(first.id);
  });

  it("refuses a permission resolver before opening an SDK query when its generation is missing", async () => {
    let clientOpened = false;
    const adapter = new AgentSdkAdapter({
      createClient: async () => {
        clientOpened = true;
        return generator([]);
      },
    });
    const session = await adapter.spawn({ provider: "anthropic", model: "sonnet", compositionDir: "/tmp", permissionMode: "default" });
    await adapter.sendTurn(session, "go", { onPermissionRequest: () => "deny" });
    await expect(adapter.awaitResponse(session)).rejects.toThrow("requires a generation id");
    expect(clientOpened).toBe(false);
  });

  it.each([
    ["allow_once", { behavior: "allow", updatedInput: { command: "pwd" }, decisionClassification: "user_temporary" }],
    ["deny", { behavior: "deny", message: "User denied this tool request.", decisionClassification: "user_reject" }],
  ])("maps %s to the exact SDK permission result", async (decision, expectedResult) => {
    const controller = new AbortController();
    const order: string[] = [];
    const events: any[] = [];
    let sdkResult: any;
    const adapter = new AgentSdkAdapter({
      permissionRequestId: () => `request-${decision}`,
      createClient: async ({ options }: any) =>
        (async function* () {
          sdkResult = await options.canUseTool("Bash", { command: "pwd" }, {
            signal: controller.signal,
            toolUseID: "tool-permission",
            title: "Run pwd?",
          });
          yield { type: "result", uuid: `result-${decision}`, subtype: "success", result: "done" };
        })(),
    });
    const session = await adapter.spawn({ provider: "anthropic", model: "sonnet", compositionDir: "/tmp", permissionMode: "default" });
    await adapter.sendTurn(session, "go", {
      turnId: "turn-permission",
      generationId: "generation-1",
      onPermissionRequest: (request: any, context: any) => {
        order.push("registered");
        expect(context.signal).toBe(controller.signal);
        expect(request).toMatchObject({
          requestId: `request-${decision}`,
          generationId: "generation-1",
          toolUseId: "tool-permission",
          name: "Bash",
          input: expect.stringContaining('"command": "pwd"'),
          inputComplete: true,
          suggestionsComplete: true,
          status: "pending",
        });
        return decision;
      },
      onEvent: (event: any) => {
        events.push(event);
        const permission = event.blocks.find((block: any) => block.type === "permission_request");
        if (permission) order.push(`event:${permission.status}`);
      },
    });
    await expect(adapter.awaitResponse(session)).resolves.toMatchObject({ text: "done" });

    expect(sdkResult).toEqual(expectedResult);
    expect(order).toEqual(["registered", "event:pending", "event:resolved"]);
    const permissionEvents = blocks(events, "permission_request").map(({ event, block }) => ({ event, block }));
    expect(permissionEvents.map(({ event }) => [event.id, event.order, event.revision])).toEqual([
      [`permission:["generation-1","request-${decision}"]`, 1, 1],
      [`permission:["generation-1","request-${decision}"]`, 1, 2],
    ]);
    expect(permissionEvents.map(({ block }) => block.status)).toEqual(["pending", "resolved"]);
    expect(permissionEvents.at(-1)?.block.decision).toBe(decision);
  });

  it("applies private exact input and suggestion snapshots while caller-owned values mutate", async () => {
    const toolInput = { command: "pwd", options: { cwd: "/tmp" } };
    const initiallyDisclosedInput = structuredClone(toolInput);
    const suggestions = [{
      type: "addRules",
      rules: [{ toolName: "Bash", ruleContent: "pwd" }],
      behavior: "allow",
      destination: "session",
    }];
    const initiallyDisclosed = structuredClone(suggestions);
    let sdkResult: any;
    let disclosedInput: any;
    let publicSuggestions: any;
    let releaseDecision!: (decision: string) => void;
    const decision = new Promise<string>((resolve) => (releaseDecision = resolve));
    let requestSeen!: () => void;
    const sawRequest = new Promise<void>((resolve) => (requestSeen = resolve));
    const adapter = new AgentSdkAdapter({
      permissionRequestId: () => "request-always",
      createClient: async ({ options }: any) =>
        (async function* () {
          sdkResult = await options.canUseTool("Bash", toolInput, {
            signal: new AbortController().signal,
            toolUseID: "tool-always",
            suggestions,
          });
          yield { type: "result", uuid: "result-always", subtype: "success", result: "done" };
        })(),
    });
    const session = await adapter.spawn({ provider: "anthropic", model: "sonnet", compositionDir: "/tmp", permissionMode: "default" });
    await adapter.sendTurn(session, "go", {
      generationId: "generation-always",
      onPermissionRequest: (request: any) => {
        disclosedInput = JSON.parse(request.input);
        publicSuggestions = request.suggestions;
        request.input = '{"command":"browser-forged"}';
        request.suggestions[0].destination = "browser-forged";
        requestSeen();
        return decision;
      },
    });
    const response = adapter.awaitResponse(session);
    await sawRequest;
    toolInput.command = "sdk-mutated";
    toolInput.options.cwd = "/different";
    suggestions[0].destination = "sdk-mutated";
    suggestions[0].rules[0].ruleContent = "different";
    releaseDecision("allow_always");
    await response;

    expect(publicSuggestions).not.toBe(suggestions);
    expect(disclosedInput).toEqual(initiallyDisclosedInput);
    expect(publicSuggestions[0].destination).toBe("browser-forged");
    expect(suggestions[0].destination).toBe("sdk-mutated");
    expect(sdkResult).toEqual({
      behavior: "allow",
      updatedInput: disclosedInput,
      updatedPermissions: initiallyDisclosed,
      decisionClassification: "user_permanent",
    });
    expect(sdkResult.updatedPermissions).not.toBe(suggestions);
    expect(sdkResult.updatedPermissions).not.toBe(publicSuggestions);
    expect(sdkResult.updatedPermissions[0]).not.toBe(suggestions[0]);
    expect(sdkResult.updatedPermissions[0]).not.toBe(publicSuggestions[0]);
    expect(sdkResult.updatedPermissions[0].rules).not.toBe(suggestions[0].rules);
    expect(sdkResult.updatedInput).not.toBe(toolInput);
    expect(sdkResult.updatedInput.options).not.toBe(toolInput.options);
  });

  it("refuses approval when exact input or persistent permission changes cannot be disclosed", async () => {
    let deepSuggestion: any = { rule: "Bash(pwd)" };
    for (let depth = 0; depth < 9; depth += 1) deepSuggestion = { nested: deepSuggestion };
    const accessorSuggestions: any[] = [];
    Object.defineProperty(accessorSuggestions, "0", {
      enumerable: true,
      configurable: true,
      get: () => ({ type: "addRules", destination: "session", rules: ["Bash(pwd)"] }),
    });
    accessorSuggestions.length = 1;
    const cases = [
      {
        label: "oversized input",
        input: { content: "x".repeat(20_001) },
        suggestions: undefined,
        decision: "allow_once",
        incomplete: "input",
      },
      {
        label: "more than 64 permission changes",
        input: { command: "pwd" },
        suggestions: Array.from({ length: 65 }, (_, index) => ({ type: "addRules", rules: [`Bash(command-${index})`] })),
        decision: "allow_always",
        incomplete: "suggestions",
      },
      {
        label: "oversized permission changes",
        input: { command: "pwd" },
        suggestions: [{ type: "addRules", note: "x".repeat(20_001) }],
        decision: "allow_always",
        incomplete: "suggestions",
      },
      {
        label: "over-deep permission changes",
        input: { command: "pwd" },
        suggestions: [deepSuggestion],
        decision: "allow_always",
        incomplete: "suggestions",
      },
      {
        label: "dangerous permission keys",
        input: { command: "pwd" },
        suggestions: [JSON.parse('{"constructor":{"destination":"session"}}')],
        decision: "allow_always",
        incomplete: "suggestions",
      },
      {
        label: "overlong permission keys",
        input: { command: "pwd" },
        suggestions: [{ ["k".repeat(201)]: "hidden" }],
        decision: "allow_always",
        incomplete: "suggestions",
      },
      {
        label: "permission array accessors",
        input: { command: "pwd" },
        suggestions: accessorSuggestions,
        decision: "allow_always",
        incomplete: "suggestions",
      },
    ];

    for (const fixture of cases) {
      let publicRequest: any;
      const adapter = new AgentSdkAdapter({
        permissionRequestId: () => `request-${fixture.label.replaceAll(" ", "-")}`,
        createClient: async ({ options }: any) =>
          (async function* () {
            await options.canUseTool("Write", fixture.input, {
              signal: new AbortController().signal,
              toolUseID: "tool-incomplete",
              suggestions: fixture.suggestions,
            });
          })(),
      });
      const session = await adapter.spawn({ provider: "anthropic", model: "sonnet", compositionDir: "/tmp", permissionMode: "default" });
      await adapter.sendTurn(session, "go", {
        generationId: "generation-incomplete",
        onPermissionRequest: (request: any) => {
          publicRequest = request;
          return fixture.decision;
        },
      });

      await expect(adapter.awaitResponse(session), fixture.label).rejects.toThrow(/requires the complete|requires complete/i);
      if (fixture.incomplete === "input") {
        expect(publicRequest.inputComplete, fixture.label).toBe(false);
      } else {
        expect(publicRequest.inputComplete, fixture.label).toBe(true);
        expect(publicRequest.suggestionsComplete, fixture.label).toBe(false);
        expect(publicRequest.suggestions, fixture.label).toBeUndefined();
      }
    }
  });

  it("keeps Deny available when a permission disclosure is incomplete", async () => {
    let sdkResult: any;
    let publicRequest: any;
    const adapter = new AgentSdkAdapter({
      permissionRequestId: () => "request-incomplete-deny",
      createClient: async ({ options }: any) =>
        (async function* () {
          sdkResult = await options.canUseTool("Write", { content: "x".repeat(20_001) }, {
            signal: new AbortController().signal,
            toolUseID: "tool-incomplete-deny",
            suggestions: Array.from({ length: 65 }, (_, index) => ({ type: "addRules", rules: [`Write(${index})`] })),
          });
          yield { type: "result", uuid: "result-incomplete-deny", subtype: "success", result: "denied safely" };
        })(),
    });
    const session = await adapter.spawn({ provider: "anthropic", model: "sonnet", compositionDir: "/tmp", permissionMode: "default" });
    await adapter.sendTurn(session, "go", {
      generationId: "generation-incomplete-deny",
      onPermissionRequest: (request: any) => {
        publicRequest = request;
        return "deny";
      },
    });
    await expect(adapter.awaitResponse(session)).resolves.toMatchObject({ text: "denied safely" });

    expect(publicRequest).toMatchObject({ inputComplete: false, suggestionsComplete: false });
    expect(publicRequest.suggestions).toBeUndefined();
    expect(sdkResult).toEqual({
      behavior: "deny",
      message: "User denied this tool request.",
      decisionClassification: "user_reject",
    });
  });

  it("emits a cancelled revision and rejects when the SDK aborts a pending request", async () => {
    const controller = new AbortController();
    const events: any[] = [];
    let pendingSeen!: () => void;
    const sawPending = new Promise<void>((resolve) => (pendingSeen = resolve));
    const adapter = new AgentSdkAdapter({
      permissionRequestId: () => "request-aborted",
      createClient: async ({ options }: any) =>
        (async function* () {
          await options.canUseTool("Write", { file_path: "/tmp/x" }, {
            signal: controller.signal,
            toolUseID: "tool-aborted",
          });
        })(),
    });
    const session = await adapter.spawn({ provider: "anthropic", model: "sonnet", compositionDir: "/tmp", permissionMode: "default" });
    await adapter.sendTurn(session, "go", {
      generationId: "generation-aborted",
      onPermissionRequest: () => new Promise(() => {}),
      onEvent: (event: any) => {
        events.push(event);
        if (event.blocks.some((block: any) => block.type === "permission_request" && block.status === "pending")) pendingSeen();
      },
    });
    const response = adapter.awaitResponse(session);
    await sawPending;
    controller.abort();
    await expect(response).rejects.toMatchObject({ name: "AbortError" });

    const permissionEvents = blocks(events, "permission_request");
    expect(permissionEvents.map(({ event }) => [event.id, event.revision])).toEqual([
      ['permission:["generation-aborted","request-aborted"]', 1],
      ['permission:["generation-aborted","request-aborted"]', 2],
    ]);
    expect(permissionEvents.map(({ block }) => block.status)).toEqual(["pending", "cancelled"]);
    expect(permissionEvents.at(-1)?.block.decision).toBeUndefined();
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

  it("buffers a one-shot result through the postlude and returns final session/model attribution", async () => {
    const adapter = new AgentSdkAdapter({
      createClient: async () => generator([
        {
          type: "assistant",
          uuid: "wire-before-result",
          session_id: "session-before-result",
          message: { id: "assistant-before-result", model: "claude-primary", content: [{ type: "text", text: "answer" }] },
        },
        {
          type: "result",
          uuid: "result-candidate",
          session_id: "session-result",
          subtype: "success",
          is_error: false,
          result: "answer",
          stop_reason: "end_turn",
          terminal_reason: "completed",
          usage: { output_tokens: 1 },
        },
        {
          type: "prompt_suggestion",
          uuid: "postlude-suggestion",
          session_id: "session-postlude",
          suggestion: "follow up",
        },
        {
          type: "system",
          subtype: "model_refusal_fallback",
          uuid: "postlude-fallback",
          session_id: "session-postlude",
          original_model: "claude-primary",
          fallback_model: "claude-fallback",
          request_id: "request-postlude",
          content: "Fallback was made sticky.",
        },
      ]),
    });
    const session = await adapter.spawn({ provider: "anthropic", model: "claude-primary", compositionDir: "/tmp" });
    const events: any[] = [];
    await adapter.sendTurn(session, "go", {
      turnId: "turn-postlude",
      generationId: "generation-postlude",
      onEvent: (event: any) => events.push(event),
    });
    await expect(adapter.awaitResponse(session)).resolves.toMatchObject({
      text: "answer",
      terminalStatus: "completed",
      failure: null,
      sessionId: "session-postlude",
      model: "claude-fallback",
    });
    expect(session).toMatchObject({ sessionId: "session-postlude", observedModel: "claude-fallback" });
    expect(events.flatMap((event) => event.blocks).map((block) => block.type)).toEqual([
      "text",
      "status",
      "retry",
      "turn_end",
    ]);
    expect(events.at(-1)).toMatchObject({
      id: 'terminal:["generation-postlude"]',
      blocks: [expect.objectContaining({ terminalReason: "completed" })],
    });
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
    await adapter.sendTurn(session, "go", {
      turnId: "crash-turn",
      generationId: "generation-crash",
      onEvent: (event: any) => events.push(event),
    });
    let failure: any = null;
    try {
      await adapter.awaitResponse(session);
    } catch (error) {
      failure = error;
    }
    expect(failure).toMatchObject({
      message: "subprocess crashed after result",
      terminalStatus: "error",
      failure: expect.objectContaining({ source: "runtime", code: "runtime_error" }),
      model: "m",
    });

    expect(blocks(events, "turn_end")).toHaveLength(1);
    expect(blocks(events, "turn_end")[0].event.id).toBe('terminal:["generation-crash"]');
    expect(blocks(events, "turn_end")[0].block).toMatchObject({
      status: "error",
      subtype: "success",
      reason: "runtime_error",
      stopReason: "end_turn",
    });
    expect(blocks(events, "error").at(-1)?.block).toEqual({
      type: "error",
      source: "runtime",
      kind: "runtime",
      code: "runtime_error",
      text: "subprocess crashed after result",
      retryable: false
    });
  });
});
