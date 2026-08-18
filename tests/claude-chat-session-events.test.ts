import { readFileSync } from "node:fs";
import { fileURLToPath } from "node:url";
import { createElement as h } from "react";
import { renderToStaticMarkup } from "react-dom/server";
import { describe, expect, it } from "vitest";
import { Marked } from "marked";
import {
  ClaudeChat,
  SessionEventTimeline,
  applySessionEvent,
  applyTurnActive,
  legacyAssistantFallback,
  liveSessionAnnouncement,
  mergeSessionEvents,
  resolvedAssistantText,
  type ChatTransport,
  type SessionEvent,
  type SessionEventTurn,
} from "../packages/claude-chat/src/index";
import { resolvedAssistantRaw } from "../packages/claude-chat/src/ClaudeChat";
import { installSafeMarkdownRenderer } from "../packages/claude-chat/src/markdown-safety";
// @ts-ignore — dependency-free fitting JavaScript intentionally has no .d.ts.
import { normalizeAgentSdkMessages } from "../fittings/seed/agent-sdk-runtime/lib/session-events.mjs";

const SDK_FIXTURE = JSON.parse(
  readFileSync(fileURLToPath(new URL("./fixtures/agent-sdk-web-parity-events.json", import.meta.url)), "utf8")
);

function fixtureEvents(turnId = "1"): SessionEvent[] {
  let now = 1_786_880_000_000;
  const revisions = normalizeAgentSdkMessages(SDK_FIXTURE.messages, { turnId, now: () => now++ });
  return mergeSessionEvents([], revisions);
}

function event(
  id: string,
  revision: number,
  text: string,
  turnId: string | number | null = "1"
): SessionEvent {
  return {
    id,
    role: "assistant",
    ts: null,
    turnId,
    order: 1,
    revision,
    blocks: [{ type: "text", text }],
  };
}

function stubTransport(): ChatTransport {
  return {
    connect: () => () => {},
    sendMessage: async () => {},
    sendKey: async () => {},
    setMode: async (mode) => ({ mode, reached: false }),
    interrupt: async () => {},
    fetchCommands: async () => [],
  };
}

describe("claude-chat canonical session events", () => {
  it("renders the authentic Write/Read fixture in canonical chronological order", () => {
    const html = renderToStaticMarkup(h(SessionEventTimeline, { events: fixtureEvents(), live: false }));
    const write = html.indexOf('<b class="cc-session-tool-name" title="Write">Write</b>');
    const writeResult = html.indexOf("File created successfully");
    const read = html.indexOf('<b class="cc-session-tool-name" title="Read">Read</b>');
    const readResult = html.indexOf("1\tWEB_PARITY_FIXTURE");
    const answer = html.lastIndexOf("WEB_PARITY_FIXTURE");

    expect(write).toBeGreaterThanOrEqual(0);
    expect(writeResult).toBeGreaterThan(write);
    expect(read).toBeGreaterThan(writeResult);
    expect(readResult).toBeGreaterThan(read);
    expect(answer).toBeGreaterThan(readResult);
    expect(html).toContain("cc-session-tool is-complete");
    expect(html).not.toContain("cc-session-tool is-complete\" open");
  });

  it("keeps completed thinking and image results expandable inside the tool card", () => {
    const events: SessionEvent[] = [
      {
        id: "assistant-1",
        role: "assistant",
        ts: 1,
        revision: 1,
        blocks: [
          { type: "thinking", text: "Inspecting the screenshot carefully." },
          { type: "tool_use", name: "Read", toolUseId: "read-1", input: "{\"path\":\"shot.png\"}" },
        ],
      },
      {
        id: "result-1",
        role: "user",
        ts: 2,
        revision: 1,
        toolResultsOnly: true,
        blocks: [{
          type: "tool_result",
          toolUseId: "read-1",
          text: "image ready",
          images: [{ mediaType: "image/png", data: "aW1hZ2U=" }],
        }],
      },
    ];
    const html = renderToStaticMarkup(h(SessionEventTimeline, { events, live: false }));

    expect(html).toContain("cc-session-thinking is-complete");
    expect(html).toContain("Inspecting the screenshot carefully.");
    expect(html).toContain('alt="Read result image 1"');
    expect(html).toContain("src=\"data:image/png;base64,aW1hZ2U=\"");
    expect(html.indexOf("image ready")).toBeLessThan(html.indexOf("Open Read result image 1"));
  });

  it("attaches a late event to its explicit historical turn and ignores a stale revision", () => {
    const turns: SessionEventTurn[] = [
      { seq: 1, streaming: false, sessionEvents: [] },
      { seq: 2, streaming: true, sessionEvents: [] },
    ];
    const attached = applySessionEvent(turns, event("message-1", 2, "settled", "1"));
    expect(attached[0].sessionEvents[0].blocks[0].text).toBe("settled");
    expect(attached[1]).toBe(turns[1]);

    const stale = applySessionEvent(attached, event("message-1", 1, "stale", "1"));
    expect(stale).toBe(attached);
    expect(stale[0].sessionEvents[0].blocks[0].text).toBe("settled");
  });

  it("rebinds a resumed event to the trailing synthetic history turn", () => {
    const turns: SessionEventTurn[] = [
      { seq: 0, streaming: false, sessionEvents: [] },
      { seq: 0, streaming: true, sessionEvents: [] },
    ];
    const attached = applySessionEvent(turns, event("resumed", 1, "continued", "0"));
    expect(attached[0]).toBe(turns[0]);
    expect(attached[1].sessionEvents.map((entry) => entry.id)).toEqual(["resumed"]);
  });

  it("uses canonical activity in the main assistant bubble and preserves legacy fallback", () => {
    const canonical = renderToStaticMarkup(h(ClaudeChat, {
      transport: stubTransport(),
      initialHistory: [{
        user: "show activity",
        assistant: "CANONICAL_RENDERED",
        sessionEvents: [event("canonical", 1, "CANONICAL_RENDERED")],
      }],
    }));
    expect(canonical).toContain("CANONICAL_RENDERED");
    expect(canonical.match(/CANONICAL_RENDERED/g)).toHaveLength(1);

    const fallback = renderToStaticMarkup(h(ClaudeChat, {
      transport: stubTransport(),
      initialHistory: [{
        user: "old runtime",
        assistant: "LEGACY_RENDERED",
        sessionEvents: [{
          id: "status-only",
          role: "assistant",
          ts: null,
          blocks: [{ type: "status", text: "not part of M2" }],
        }],
      }],
    }));
    expect(fallback).toContain("LEGACY_RENDERED");
  });

  it("keeps unsafe links inert and rewrites cross-fitting and remote loopback links", () => {
    const marked = new Marked({ gfm: true });
    installSafeMarkdownRenderer(marked, () => ({
      hostname: "dev-madrid.tail31efa.ts.net",
      protocol: "https:",
      serveMap: { "8081": "https://dev-madrid.tail31efa.ts.net:8443" },
    }));
    const html = marked.parse(
      "[unsafe](javascript:alert(1)) [board](garrison://kanban/card/c-1) " +
      "[loopback](http://127.0.0.1:8081/card/c-1) <script>alert(2)</script>"
    ) as string;

    expect(html).not.toContain('href="javascript:');
    expect(html).toContain('<a href="/fitting/kanban/card/c-1">board</a>');
    expect(html).toContain('href="https://dev-madrid.tail31efa.ts.net:8443/card/c-1"');
    expect(html).toContain('rel="noopener noreferrer"');
    expect(html).not.toContain("<script>");
    // A human-written label is the author's words and must survive verbatim.
    expect(html).toContain(">loopback</a>");
  });

  it("rewrites the VISIBLE url of an autolink, not just its href", () => {
    const marked = new Marked({ gfm: true });
    installSafeMarkdownRenderer(marked, () => ({
      hostname: "dev-madrid.tail31efa.ts.net",
      protocol: "https:",
      serveMap: { "8089": "https://dev-madrid.tail31efa.ts.net:8489" },
    }));
    // The operative writes bare card urls: "Card: http://127.0.0.1:8089/#/cards/X".
    // Rewriting only the href leaves a loopback address on screen - it clicks
    // through, but it READS as dead and COPIES as dead on every device that is
    // not this machine.
    const html = marked.parse("Card: http://127.0.0.1:8089/#/cards/c-1") as string;
    expect(html).toContain('href="https://dev-madrid.tail31efa.ts.net:8489/#/cards/c-1"');
    expect(html).toContain(">https://dev-madrid.tail31efa.ts.net:8489/#/cards/c-1</a>");
    expect(html).not.toContain("127.0.0.1");
  });

  it("removes only route badges from canonical prose and mounts one stable live region", () => {
    const html = renderToStaticMarkup(h(ClaudeChat, {
      transport: stubTransport(),
      initialHistory: [{
        user: "explain",
        assistant: "",
        sessionEvents: [event(
          "canonical-badges",
          1,
          "Thinking\n\nLegitimate canonical prose.\n\n```ts\nconst safe = true;\n```\n" +
          "[route: cc-opus-high | rule: row:research]\n[orchestrator-active]"
        )],
      }],
    }));

    expect(html).toContain("Thinking");
    expect(html).toContain("Legitimate canonical prose.");
    expect(html).not.toContain("[route:");
    expect(html).not.toContain("[orchestrator-active]");
    expect(html).toContain("cc-codeblock");
    expect(html).toContain('class="cc-codecopy" aria-label="Copy code"');
    expect(html.match(/aria-live=/g)).toHaveLength(1);
    expect(html).toContain('class="cc-sr-only" role="status" aria-live="polite" aria-atomic="true"');
    // Copy is an icon now; its accessible name carries the meaning.
    expect(html).toContain('class="cc-msgcopy"');
    expect(html).toContain('aria-label="Copy this response"');
  });

  it("renders typed errors and a differing durable fallback instead of hiding failure text", () => {
    const html = renderToStaticMarkup(h(ClaudeChat, {
      transport: stubTransport(),
      initialHistory: [{
        user: "run it",
        assistant: "_Turn did not complete. Please retry._",
        sessionEvents: [
          {
            id: "tool-before-error",
            role: "assistant",
            ts: 1,
            revision: 1,
            blocks: [{ type: "tool_use", name: "Bash", toolUseId: "bash-1", input: '{"cmd":"false"}' }],
          },
          {
            id: "typed-error",
            role: "assistant",
            ts: 2,
            revision: 1,
            blocks: [{ type: "error", text: "runtime exploded", kind: "runtime_error" }],
          },
        ],
      }],
    }));

    expect(html).toContain("runtime exploded");
    expect(html).toContain("Turn did not complete. Please retry.");
    expect(html).toContain("cc-session-error");
    expect(html).toContain("cc-canonical-fallback");
  });

  it("makes a successful terminal result authoritative over stale legacy text", () => {
    const sessionEvents: SessionEvent[] = [{
      id: "terminal-authority",
      role: "assistant",
      ts: 2,
      revision: 1,
      blocks: [{ type: "turn_end", status: "completed", result: "authoritative final" }],
    }];
    const turn = { assistant: "stale streamed draft", sessionEvents };

    // These are the shared response seams for per-message/global copy, TTS,
    // composer lastReply and onTurnComplete respectively.
    expect(resolvedAssistantText(turn)).toBe("authoritative final");
    expect(resolvedAssistantRaw(turn)).toBe("authoritative final");
    expect(legacyAssistantFallback(turn.assistant, sessionEvents)).toBe("");
    expect(legacyAssistantFallback(
      "_The operative returned an empty reply. Try sending again._",
      sessionEvents
    )).toBe("");

    const html = renderToStaticMarkup(h(ClaudeChat, {
      transport: stubTransport(),
      initialHistory: [{ user: "finish it", ...turn }],
    }));
    expect(html).toContain("authoritative final");
    expect(html).not.toContain("stale streamed draft");
    expect(html).not.toContain("cc-canonical-fallback");
  });

  it("renders route, retry, warning reset, error, and terminal beats in exact order", () => {
    const reset = 1_787_000_000;
    const events: SessionEvent[] = [{
      id: "typed-settlement",
      role: "assistant",
      ts: 1,
      revision: 1,
      blocks: [
        { type: "route", attribution: { target: "claude", runtime: "agent-sdk", model: "sonnet", sessionDisposition: "new" } },
        { type: "rate_limit", status: "allowed", utilization: 0.12 },
        { type: "retry", kind: "api", text: "The request will retry.", attempt: 2, maxAttempts: 3, delayMs: 750, httpStatus: 529 },
        { type: "rate_limit", status: "allowed_warning", rateLimitType: "tokens", resetsAt: reset },
        {
          type: "error",
          source: "runtime",
          kind: "runtime",
          code: "RUNTIME_CRASH_WITH_A_LONG_UNBROKEN_IDENTIFIER",
          text: "The runtime crashed while producing this response.",
          retryable: false,
          requestId: "request-with-a-long-unbroken-identity-1234567890",
        },
        { type: "turn_end", status: "error", subtype: "runtime", reason: "runtime crash", stopReason: null, terminalReason: "runtime" },
      ],
    }];
    const html = renderToStaticMarkup(h(SessionEventTimeline, { events, live: false }));

    const route = html.indexOf("Route selected");
    const retry = html.indexOf("Retrying request");
    const warning = html.indexOf("Rate limit warning");
    const error = html.indexOf("Runtime error");
    const terminal = html.indexOf("Response failed");
    expect([route, retry, warning, error, terminal].every((index) => index >= 0)).toBe(true);
    expect(route).toBeLessThan(retry);
    expect(retry).toBeLessThan(warning);
    expect(warning).toBeLessThan(error);
    expect(error).toBeLessThan(terminal);
    expect(html).toContain("Started a new session. Using claude · agent-sdk / sonnet.");
    expect(html.match(/Rate limit/g)).toHaveLength(1);
    expect(html).toContain(`<time dateTime="${new Date(reset * 1_000).toISOString()}">`);
    expect(html).toContain("RUNTIME_CRASH_WITH_A_LONG_UNBROKEN_IDENTIFIER");
    expect(html).toContain("request request-with-a-long-unbroken-identity-1234567890");
    expect(html).not.toContain('role="alert"');

    const rejectedHtml = renderToStaticMarkup(h(SessionEventTimeline, {
      events: [{
        id: "overage-rejected",
        role: "assistant",
        ts: 2,
        revision: 1,
        blocks: [{ type: "rate_limit", status: "allowed", overageStatus: "rejected", overageResetsAt: reset + 60 }],
      }],
    }));
    expect(rejectedHtml).toContain("Rate limit reached");
    expect(rejectedHtml).toContain(`<time dateTime="${new Date((reset + 60) * 1_000).toISOString()}">`);
    const invalidTimeHtml = renderToStaticMarkup(h(SessionEventTimeline, {
      events: [{
        id: "invalid-reset",
        role: "assistant",
        ts: 3,
        revision: 1,
        blocks: [{ type: "rate_limit", status: "rejected", resetsAt: Number.NaN }],
      }],
    }));
    expect(invalidTimeHtml).toContain("Rate limit reached");
    expect(invalidTimeHtml).not.toContain("<time");

    const fallbackHtml = renderToStaticMarkup(h(SessionEventTimeline, {
      events: [{
        id: "model-fallback",
        role: "assistant",
        ts: 4,
        revision: 1,
        blocks: [{
          type: "retry",
          kind: "model_fallback",
          text: "The requested model refused the prompt.",
          fromModel: "opus",
          toModel: "sonnet",
          direction: "retry",
        }],
      }],
    }));
    expect(fallbackHtml).toContain("Route changed");
    expect(fallbackHtml).toContain("Model changed from opus to sonnet.");
  });

  it("lets an error/cancelled typed boundary suppress duplicate italic fallback for render, copy, and TTS", () => {
    const failureEvents: SessionEvent[] = [{
      id: "terminal-error",
      role: "assistant",
      ts: 2,
      revision: 1,
      blocks: [
        { type: "error", source: "runtime", kind: "runtime", code: "CRASH", text: "Runtime crashed.", retryable: false },
        { type: "turn_end", status: "error", subtype: "runtime", reason: "crash", stopReason: null, terminalReason: "runtime" },
      ],
    }];
    const failed = { assistant: "_Turn did not complete. Please retry._", sessionEvents: failureEvents };
    expect(resolvedAssistantText(failed)).toBe("Runtime crashed.");
    expect(resolvedAssistantRaw(failed)).toBe("Runtime crashed.");
    expect(legacyAssistantFallback(failed.assistant, failureEvents)).toBe("");

    const cancelledEvents: SessionEvent[] = [{
      id: "terminal-cancelled",
      role: "assistant",
      ts: 3,
      revision: 1,
      blocks: [{ type: "turn_end", status: "cancelled", subtype: "user", reason: "user requested", stopReason: "interrupt", terminalReason: null }],
    }];
    expect(resolvedAssistantText({ assistant: "_Turn stopped._", sessionEvents: cancelledEvents })).toBe("");

    const html = renderToStaticMarkup(h(ClaudeChat, {
      transport: stubTransport(),
      initialHistory: [{ user: "run it", ...failed }],
    }));
    expect(html).toContain("Runtime crashed.");
    expect(html.match(/Runtime crashed\./g)).toHaveLength(1);
    expect(html).not.toContain("Turn did not complete");
    expect(html).not.toContain("cc-canonical-fallback");
  });

  it("renders a hydrated typed admission failure without replaying legacy italic prose", () => {
    const failure = {
      source: "web" as const,
      kind: "invalid_request",
      code: "QUEUE_REJECTED",
      text: "The message was not admitted.",
      retryable: true,
      retryAt: 1_787_000_000,
    } as const;
    const html = renderToStaticMarkup(h(ClaudeChat, {
      transport: stubTransport(),
      initialHistory: [{
        user: "run it",
        assistant: "_The operative returned an empty reply. Try sending again._",
        input: { clientRequestId: "client-1", inputId: "input-1", state: "failed", failure },
      }],
    }));
    expect(html).toContain("Web error");
    expect(html).toContain("The message was not admitted.");
    expect(html).toContain("Retry after");
    expect(html).toContain(`<time dateTime="${new Date(failure.retryAt * 1_000).toISOString()}">`);
    expect(html).not.toContain("operative returned an empty reply");
    expect(html.match(/aria-live=/g)).toHaveLength(1);
  });

  it("shows an authoritative terminal result and does not reuse stale progress for an image-only result", () => {
    const events: SessionEvent[] = [
      {
        id: "tool",
        role: "assistant",
        ts: 1,
        revision: 1,
        blocks: [{ type: "tool_use", name: "Read", toolUseId: "read-image" }],
      },
      {
        id: "progress",
        role: "assistant",
        ts: 2,
        revision: 1,
        blocks: [{ type: "tool_progress", name: "Read", toolUseId: "read-image", text: "Read is running.", status: "running" }],
      },
      {
        id: "image-result",
        role: "user",
        ts: 3,
        revision: 1,
        toolResultsOnly: true,
        blocks: [{
          type: "tool_result",
          toolUseId: "read-image",
          images: [{ mediaType: "image/png", data: "aW1hZ2U=" }],
        }],
      },
      {
        id: "terminal",
        role: "assistant",
        ts: 4,
        revision: 1,
        blocks: [{ type: "turn_end", status: "completed", result: "authoritative final" }],
      },
    ];
    const html = renderToStaticMarkup(h(SessionEventTimeline, { events, live: false }));

    expect(html).toContain("authoritative final");
    expect(html).toContain("Read result image 1");
    expect(html).not.toContain("Read is running.");
  });

  it("renders durable permission requests in order with exact, text-only scope and changes", () => {
    const events: SessionEvent[] = [{
      id: "permission-sequence",
      role: "assistant",
      ts: 1,
      revision: 1,
      blocks: [
        { type: "text", text: "Before permission." },
        {
          type: "permission_request",
          requestId: "permission-1",
          generationId: "generation-7",
          toolUseId: "tool-1",
          name: "Bash",
          displayName: "Shell command",
          title: "Run the release check?",
          description: "The check reads the selected workspace.",
          blockedPath: "/srv/workspace/<release>",
          reason: "Execution needs approval.",
          input: { command: "printf '<script>not markup</script>'" },
          inputComplete: true,
          status: "pending",
          suggestions: [{ type: "addRules", destination: "userSettings", rules: ["Bash(printf:*)"], note: "<b>literal</b>" }],
          suggestionsComplete: true,
        },
        { type: "text", text: "After permission." },
      ],
    }];
    const html = renderToStaticMarkup(h(SessionEventTimeline, {
      events,
      live: true,
      onPermissionDecision: async () => {},
      permissionGenerationId: "generation-7",
    }));

    expect(html.indexOf("Before permission.")).toBeLessThan(html.indexOf("Run the release check?"));
    expect(html.indexOf("Run the release check?")).toBeLessThan(html.indexOf("After permission."));
    expect(html).toContain("Shell command");
    expect(html).toContain("Allow once: this request · Always allow: future matching requests");
    expect(html).toContain("/srv/workspace/&lt;release&gt;");
    expect(html).toContain("<dt>Blocked path</dt><dd>/srv/workspace/&lt;release&gt;</dd>");
    expect(html).toContain("<dt>Permission destination</dt><dd>userSettings</dd>");
    expect(html).toContain("Exact proposed tool input");
    expect(html).toContain("Exact changes saved by Always allow");
    expect(html).toContain("&lt;script&gt;not markup&lt;/script&gt;");
    expect(html).toContain("&lt;b&gt;literal&lt;/b&gt;");
    expect(html).not.toContain("<script>");
    expect(html).not.toContain("<b>literal</b>");
    expect(html.indexOf(">Deny<")).toBeLessThan(html.indexOf(">Allow once<"));
    expect(html.indexOf(">Allow once<")).toBeLessThan(html.indexOf(">Always allow<"));
  });

  it("keeps restored permissions readable and makes resolved or cancelled revisions non-actionable", () => {
    const pending: SessionEvent = {
      id: "durable-permission",
      role: "assistant",
      ts: 1,
      revision: 1,
      blocks: [{
        type: "permission_request",
        requestId: "permission-restored",
        generationId: "generation-restored",
        name: "Write",
        input: "{\"path\":\"/tmp/result.txt\"}",
        inputComplete: true,
        blockedPath: "/tmp/result.txt",
        status: "pending",
        suggestionsComplete: true,
      }],
    };
    const readOnly = renderToStaticMarkup(h(SessionEventTimeline, { events: [pending] }));
    expect(readOnly).toContain("Awaiting your decision");
    expect(readOnly).toContain("Return to chat to answer this permission request.");
    expect(readOnly).not.toContain(">Deny<");
    expect(readOnly).not.toContain(">Allow once<");
    expect(readOnly).not.toContain(">Always allow<");

    const resolved = mergeSessionEvents([pending], [{
      ...pending,
      revision: 2,
      blocks: [{ ...pending.blocks[0], status: "resolved", decision: "allow_once" }],
    }]);
    const resolvedHtml = renderToStaticMarkup(h(SessionEventTimeline, {
      events: resolved,
      onPermissionDecision: async () => {},
    }));
    expect(resolvedHtml).toContain("Allowed once");
    expect(resolvedHtml).not.toContain('class="cc-session-permission-actions"');

    const cancelledHtml = renderToStaticMarkup(h(SessionEventTimeline, {
      events: [{
        ...pending,
        id: "cancelled-permission",
        revision: 1,
        blocks: [{ ...pending.blocks[0], status: "cancelled" }],
      }],
      onPermissionDecision: async () => {},
    }));
    expect(cancelledHtml).toContain("Cancelled");
    expect(cancelledHtml).not.toContain('class="cc-session-permission-actions"');
  });

  it("never offers Always allow when a permission has no exact suggestions", () => {
    const html = renderToStaticMarkup(h(SessionEventTimeline, {
      events: [{
        id: "permission-once-only",
        role: "assistant",
        ts: 1,
        revision: 1,
        blocks: [{
          type: "permission_request",
          requestId: "permission-once-only",
          generationId: "generation-once-only",
          name: "Read",
          input: "{\"path\":\"notes.txt\"}",
          inputComplete: true,
          status: "pending",
          suggestions: [],
          suggestionsComplete: true,
        }],
      }],
      live: true,
      onPermissionDecision: async () => {},
      permissionGenerationId: "generation-once-only",
    }));
    expect(html).toContain(">Deny<");
    expect(html).toContain(">Allow once<");
    expect(html).not.toContain(">Always allow<");
  });

  it("keeps incomplete permission details non-approvable while preserving Deny", () => {
    const html = renderToStaticMarkup(h(SessionEventTimeline, {
      events: [{
        id: "permission-incomplete",
        role: "assistant",
        ts: 1,
        revision: 1,
        blocks: [{
          type: "permission_request",
          requestId: "permission-incomplete",
          generationId: "generation-incomplete",
          name: "Bash",
          input: "{\"command\":\"partial",
          inputComplete: false,
          status: "pending",
          suggestions: [{ type: "addRules", destination: "session", rules: ["partial"] }],
          suggestionsComplete: false,
        }],
      }],
      live: true,
      onPermissionDecision: async () => {},
      permissionGenerationId: "generation-incomplete",
    }));

    expect(html).toContain("Approval unavailable because the full request details cannot be shown.");
    expect(html).toContain("Available partial tool input");
    expect(html).toContain("Available partial persistent changes");
    expect(html).not.toContain("Exact proposed tool input");
    expect(html).not.toContain("Exact changes saved by Always allow");
    expect(html).toContain(">Deny<");
    expect(html).toMatch(/<button type="button" disabled="" title="Unavailable because the full request details cannot be shown">Allow once<\/button>/);
    expect(html).not.toContain(">Always allow<");
  });

  it("keeps stale-generation pending permissions visible but non-actionable", () => {
    const html = renderToStaticMarkup(h(SessionEventTimeline, {
      events: [{
        id: "permission-before-restart",
        role: "assistant",
        ts: 1,
        revision: 1,
        blocks: [{
          type: "permission_request",
          requestId: "permission-before-restart",
          generationId: "generation-before-restart",
          name: "Bash",
          input: '{"command":"deploy"}',
          inputComplete: true,
          status: "pending",
          suggestionsComplete: true,
        }],
      }],
      live: true,
      onPermissionDecision: async () => {},
      permissionGenerationId: "generation-after-restart",
    }));

    expect(html).toContain("No longer active");
    expect(html).toContain("This permission request is no longer active and cannot be answered.");
    expect(html).not.toContain('class="cc-session-permission-actions"');
  });

  it("warns when incomplete persistent changes were omitted entirely", () => {
    const html = renderToStaticMarkup(h(SessionEventTimeline, {
      events: [{
        id: "permission-omitted-suggestions",
        role: "assistant",
        ts: 1,
        revision: 1,
        blocks: [{
          type: "permission_request",
          requestId: "permission-omitted-suggestions",
          generationId: "generation-omitted-suggestions",
          name: "Bash",
          input: '{"command":"pwd"}',
          inputComplete: true,
          status: "pending",
          suggestionsComplete: false,
        }],
      }],
      live: true,
      onPermissionDecision: async () => {},
      permissionGenerationId: "generation-omitted-suggestions",
    }));

    expect(html).toContain("Persistent scope unavailable");
    expect(html).toContain("Always allow is unavailable because the full persistent permission changes cannot be shown.");
    expect(html).toContain(">Allow once<");
    expect(html).toContain(">Deny<");
    expect(html).not.toContain(">Always allow<");
  });

  it("announces a pending permission through the chat's single live message", () => {
    expect(liveSessionAnnouncement([{
      id: "permission-announcement",
      role: "assistant",
      ts: 1,
      revision: 1,
      blocks: [{
        type: "permission_request",
        requestId: "permission-announcement",
        generationId: "generation-announcement",
        name: "Bash",
        displayName: "Shell command",
        input: "{\"command\":\"pwd\"}",
        inputComplete: true,
        status: "pending",
        suggestionsComplete: true,
      }],
    }], "")).toBe("Permission requested for Shell command.");
  });

  it("marks a restored trailing turn live and settled without rewriting earlier turns", () => {
    const turns = [
      { id: "old", streaming: false },
      { id: "tail", streaming: false },
    ];
    const active = applyTurnActive(turns, true);
    expect(active[0]).toBe(turns[0]);
    expect(active[1]).toEqual({ id: "tail", streaming: true });
    expect(applyTurnActive(active, true)).toBe(active);
    expect(applyTurnActive(active, false)[1]).toEqual({ id: "tail", streaming: false });
  });
});
