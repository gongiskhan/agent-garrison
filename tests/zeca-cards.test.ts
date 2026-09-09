import { describe, expect, it, vi } from "vitest";
// @ts-ignore JavaScript service boundary
import { buildZecaWindow, conversationMessages, fallbackTranscript, inferWindow, inferencePrompt, validateInference } from "../packages/talk/src/zeca-cards.mjs";

const messages = Array.from({ length: 60 }, (_, i) => ({ id: String(i), role: i % 2 ? "assistant" : "user", ts: `2026-09-09T14:${String(i).padStart(2, "0")}:00Z`, body: `Message **${i}**` }));
const valid = { title: "Repair the calendar", description: "## Task\nRepair the calendar.\n\n## Decisions already made\n- Keep local times.\n\n## Open questions\nNone\n\n## Context\nThe reminder uses the wrong hour.", messageIds: ["58", "59"], confidence: 0.9 };

describe("Zeca message window", () => {
  it.each([10, 20, 30, 40, 50])("uses the last %i messages in chronological order", (size) => {
    const result = buildZecaWindow(messages, size);
    expect(result.messages).toEqual(messages.slice(-size));
    expect(result.boundaryApplied).toBe(false);
    expect(result.windowStartId).toBe(String(60 - size));
    expect(result.windowEndId).toBe("59");
  });
  it("shortens only the default window after the latest card and permits widening", () => {
    const history = [{ messageIds: ["53", "54"] }];
    expect(buildZecaWindow(messages, 10, history)).toMatchObject({ messages: messages.slice(55), boundaryApplied: true });
    expect(buildZecaWindow(messages, 20, history).messages).toHaveLength(20);
    expect(buildZecaWindow(messages, 10, [{ messageIds: ["39"] }]).boundaryApplied).toBe(false);
    expect(buildZecaWindow(messages, 10, [{ messageIds: ["59"] }])).toMatchObject({ messages: [], boundaryApplied: true, windowStartId: null, windowEndId: null });
    expect(buildZecaWindow([], 10).messages).toEqual([]);
    expect(() => buildZecaWindow(messages, 11)).toThrow("invalid windowSize");
  });
  it("keeps final assistant revisions and user attachments while excluding operational records and tool payloads", () => {
    const records = [
      { kind: "user-message", payload: { text: "Keep **markdown**\n\nand spacing", attachments: [{ filename: "plan.pdf" }] } },
      { kind: "session-event", stretch: "stretch-1", payload: { id: "a", role: "assistant", blocks: [{ type: "text", text: "Partial" }] } },
      { kind: "session-event", stretch: "stretch-1", payload: { id: "a", role: "assistant", blocks: [{ type: "text", text: "Final **answer**" }, { type: "tool_use", input: "NEVER INCLUDE" }] } },
      ...["note", "delegation-returned", "stretch-routing", "finding", "cost", "system", "card.created_from_zeca"].map((kind) => ({ kind, payload: { text: "NEVER INCLUDE" } })),
      { kind: "session-event", payload: { id: "tool", role: "tool", blocks: [{ type: "text", text: "NEVER INCLUDE" }] } },
    ].map((record, index) => ({ ...record, index, ts: "2026-09-09T14:32:00Z" }));
    expect(conversationMessages(records, "zeca-example")).toEqual([
      { id: "0", role: "user", ts: "2026-09-09T14:32:00.000Z", body: "Keep **markdown**\n\nand spacing\n[attachment: plan.pdf]" },
      { id: "1", role: "assistant", ts: "2026-09-09T14:32:00.000Z", body: "Final **answer**" },
    ]);
  });
  it("formats a verbatim fallback with attachment markers and day separators", () => {
    const input = [{ ...messages[0], ts: "2026-09-08T14:32:00Z", body: "**Exact**\n[attachment: plan.pdf]" }, { ...messages[1], ts: "2026-09-09T14:33:00Z" }];
    expect(fallbackTranscript("Repair it", input, "/talk?thread=zeca-example")).toBe("# Repair it\n\nSource: /talk?thread=zeca-example\nMessages: 2\n\n--- 2026-09-08 ---\n\n**You** · 14:32\n**Exact**\n[attachment: plan.pdf]\n\n--- 2026-09-09 ---\n\n**Zeca** · 14:33\nMessage **1**");
  });
  it("turns the web composer's attachment suffix into filename markers", () => {
    const rows = [{ index: 1, kind: "user-message", ts: "2026-09-09T14:32:00Z", payload: { text: "Read **these**\n\nAttached files:\n- /private/uploads/a.png\n- /private/uploads/meeting notes.pdf" } }];
    expect(conversationMessages(rows, "zeca-example")[0].body).toBe("Read **these**\n\n[attachment: a.png]\n[attachment: meeting notes.pdf]");
  });
});

describe("Zeca inference", () => {
  const window = buildZecaWindow(messages, 10);
  it("makes one bounded call and appends self-contained source context", async () => {
    const call = vi.fn(async (_input: unknown) => JSON.stringify(valid));
    const result = await inferWindow(messages, window, { conversationId: "zeca-example", call });
    expect(call).toHaveBeenCalledTimes(1);
    expect(call.mock.calls[0][0]).toMatchObject({ effort: "low", maxTokens: 800, prompt: inferencePrompt(messages.slice(-10)) });
    expect(result).toMatchObject({ title: valid.title, messageIds: valid.messageIds, fallbackUsed: false });
    expect(result.description).toContain("Source: Zeca conversation zeca-example, messages 58 to 59, [Open conversation](/talk?thread=zeca-example&message=58)");
  });
  it("retries malformed JSON once, then accepts valid JSON", async () => {
    const call = vi.fn().mockResolvedValueOnce("```json\n{}\n```").mockResolvedValueOnce(JSON.stringify(valid));
    expect((await inferWindow(messages, window, { conversationId: "zeca-example", call })).fallbackUsed).toBe(false);
    expect(call).toHaveBeenCalledTimes(2);
  });
  it("rejects out-of-window ids, missing headings and invalid confidence", () => {
    for (const change of [{ messageIds: ["1"] }, { confidence: 2 }, { description: "Not structured" }, { title: "Trailing period." }]) expect(() => validateInference(JSON.stringify({ ...valid, ...change }), window.messages)).toThrow();
  });
  it("aborts both timed-out calls and supplies a verbatim fallback", async () => {
    const signals: AbortSignal[] = [];
    const call = vi.fn(({ signal }) => { signals.push(signal); return new Promise(() => {}); });
    const result = await inferWindow(messages, window, { conversationId: "zeca-example", call, timeoutMs: 10 });
    expect(call).toHaveBeenCalledTimes(2);
    expect(signals.every((signal) => signal.aborted)).toBe(true);
    expect(result).toMatchObject({ title: "Message **58**", confidence: 0, fallbackUsed: true });
    expect(result.description).toContain("**You** · 14:58\nMessage **58**");
  });
  it("returns an editable empty description after the boundary without a model call", async () => {
    const call = vi.fn();
    const result = await inferWindow(messages, buildZecaWindow(messages, 10, [{ messageIds: ["59"] }]), { conversationId: "zeca-example", call });
    expect(result).toMatchObject({ title: "Message **58**", description: "", messageIds: [] });
    expect(call).not.toHaveBeenCalled();
  });
});
