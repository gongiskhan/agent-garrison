import { afterEach, describe, expect, it, vi } from "vitest";
import { createHttpTransport, type ChatSendMeta } from "../packages/claude-chat/src";
// @ts-ignore - the Dev Env helper is intentionally plain ESM.
import { CLAUDE_CHAT_CONTROL_SETTLE_MS, CLAUDE_CHAT_EFFORTS, createClaudeMessageGate, isClaudeChatEffort, writeClaudeChatMessage } from "../fittings/seed/dev-env/scripts/claude-message.mjs";

afterEach(() => {
  vi.unstubAllGlobals();
});

describe("shared Claude chat effort transport", () => {
  it("posts effort as typed request metadata without changing one byte of text", async () => {
    const calls: Array<{ url: string; body: unknown }> = [];
    vi.stubGlobal("fetch", vi.fn(async (url: string, init?: RequestInit) => {
      calls.push({ url, body: JSON.parse(String(init?.body)) });
      return new Response("{}", { status: 202, headers: { "content-type": "application/json" } });
    }));

    const transport = createHttpTransport("/sessions/session-1");
    const text = "think hard is user-authored\n\nkeep this exact";
    const meta: ChatSendMeta = { effort: "max" };
    await transport.sendMessage(text, meta);

    expect(calls).toEqual([{
      url: "/sessions/session-1/claude/message",
      body: { text, effort: "max" },
    }]);
  });

  it("keeps the legacy/Web HTTP body minimal when effort metadata is absent", async () => {
    const bodies: unknown[] = [];
    vi.stubGlobal("fetch", vi.fn(async (_url: string, init?: RequestInit) => {
      bodies.push(JSON.parse(String(init?.body)));
      return new Response("{}", { status: 202, headers: { "content-type": "application/json" } });
    }));

    await createHttpTransport("/api").sendMessage("plain web message");
    expect(bodies).toEqual([{ text: "plain web message" }]);
  });
});

describe("Dev Env native effort boundary", () => {
  it("applies the adapter control separately before writing the exact message", async () => {
    const writes: string[] = [];
    const waits: number[] = [];
    const text = "ultrathink is visible text, not a directive\n\nsecond paragraph";

    await writeClaudeChatMessage(
      { write: (value: string) => writes.push(value) },
      text,
      {
        effort: "max",
        delayMs: 17,
        wait: async (ms: number) => { waits.push(ms); },
      }
    );

    expect(writes).toEqual(["/effort max\r", text, "\r"]);
    expect(waits).toEqual([CLAUDE_CHAT_CONTROL_SETTLE_MS, 17]);
  });

  it("accepts only the native vocabulary and rejects injection before any PTY write", async () => {
    expect(CLAUDE_CHAT_EFFORTS).toEqual(["auto", "low", "medium", "high", "xhigh", "max"]);
    expect(CLAUDE_CHAT_EFFORTS.every(isClaudeChatEffort)).toBe(true);
    expect(isClaudeChatEffort("high\rmalicious text")).toBe(false);

    const writes: string[] = [];
    await expect(writeClaudeChatMessage(
      { write: (value: string) => writes.push(value) },
      "safe message",
      { effort: "high\rmalicious text", wait: async () => {} }
    )).rejects.toThrow("unsupported effort");
    expect(writes).toEqual([]);
  });

  it("does not emit a native control for older requests without effort", async () => {
    const writes: string[] = [];
    const waits: number[] = [];
    await writeClaudeChatMessage(
      { write: (value: string) => writes.push(value) },
      "legacy",
      { delayMs: 9, wait: async (ms: number) => { waits.push(ms); } }
    );
    expect(writes).toEqual(["legacy", "\r"]);
    expect(waits).toEqual([9]);
  });

  it("latches Stop during native-effort settlement and never submits the text", async () => {
    const gate = createClaudeMessageGate();
    const admission = gate.begin("session-effort");
    expect(admission).not.toBeNull();
    expect(gate.begin("session-effort")).toBeNull();
    const writes: string[] = [];
    const turn = writeClaudeChatMessage(
      { write: (value: string) => writes.push(value) },
      "must not be submitted",
      {
        effort: "max",
        signal: admission!.signal,
        wait: async (ms: number) => {
          expect(ms).toBe(CLAUDE_CHAT_CONTROL_SETTLE_MS);
          expect(gate.interrupt("session-effort")).toBe(true);
        },
      },
    );

    await expect(turn).rejects.toMatchObject({
      name: "AbortError",
      code: "claude_message_cancelled",
    });
    expect(writes).toEqual(["/effort max\r"]);
    admission!.release();
    expect(gate.interrupt("session-effort")).toBe(false);
    expect(gate.begin("session-effort")).not.toBeNull();
  });
});
