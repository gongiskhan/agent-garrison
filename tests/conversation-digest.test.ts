// Layer 2. The digest exists so a stretch can see what happened without paying
// for what tool results cost. These tests pin the two properties that make it
// worth having: it carries the prose whole, and it NEVER carries a result body.
import { describe, it, expect } from "vitest";
// @ts-ignore - pure .mjs module; a multi-line import puts the error on the closing line, where the ignore does not reach
import { buildConversationDigest } from "../packages/claude-pty/src/conversation-digest.mjs";

let seq = 0;
const ev = (kind: string, extra: Record<string, unknown> = {}) => ({
  seq: ++seq, ts: new Date(1_700_000_000_000 + seq * 1000).toISOString(), kind, ...extra,
});
const sessionEvent = (id: string, blocks: unknown[], extra: Record<string, unknown> = {}) =>
  ev("session-event", { stretch: "st_1", duty: "implement", payload: { id, revision: 1, blocks }, ...extra });

describe("conversation digest", () => {
  it("carries user messages and assistant prose in full", () => {
    const prose = "I have read the manifest and here is what I concluded, at length.";
    const d = buildConversationDigest([
      ev("user-message", { payload: { text: "build the thing" } }),
      sessionEvent("a1", [{ type: "text", text: prose }]),
    ]);
    expect(d.markdown).toContain("build the thing");
    expect(d.markdown).toContain(prose);
  });

  it("reduces a tool call to name, args, one-line synopsis, size and a pointer", () => {
    const body = "line one\nline two\n" + "x".repeat(5000);
    const d = buildConversationDigest([
      sessionEvent("a1", [{ type: "tool_use", toolUseId: "t1", name: "Bash", input: '{"command":"ls -la"}' }]),
      sessionEvent("u1", [{ type: "tool_result", toolUseId: "t1", isError: false, text: body }]),
    ]);
    expect(d.markdown).toContain("`Bash`");
    expect(d.markdown).toContain("ls -la");
    expect(d.markdown).toContain("line one");
    expect(d.markdown).toContain(`${Buffer.byteLength(body)}B`);
    expect(d.markdown).toMatch(/seq:\d+/);
    // The whole point: the body is NOT in the digest.
    expect(d.markdown).not.toContain("x".repeat(300));
    expect(d.counts.toolResultBytesOmitted).toBe(Buffer.byteLength(body));
  });

  it("takes the COMPLETE tool arguments, not the first streamed prefix", () => {
    const d = buildConversationDigest([
      sessionEvent("a1", [{ type: "tool_use", toolUseId: "t1", name: "Write", input: '{"file_path":"/ho' }]),
      sessionEvent("a1b", [{ type: "tool_use", toolUseId: "t1", name: "Write", input: '{"file_path":"/home/x/y.ts","content":"..."}' }]),
    ]);
    expect(d.markdown).toContain("/home/x/y.ts");
  });

  it("keeps the settled revision of a streaming message, not every prefix of it", () => {
    const d = buildConversationDigest([
      ev("session-event", { payload: { id: "a1", revision: 1, blocks: [{ type: "text", text: "partial" }] } }),
      ev("session-event", { payload: { id: "a1", revision: 2, blocks: [{ type: "text", text: "partial and then the rest" }] } }),
    ]);
    expect(d.counts.assistant).toBe(1);
    expect(d.markdown).toContain("partial and then the rest");
  });

  it("marks an errored tool call as one", () => {
    const d = buildConversationDigest([
      sessionEvent("a1", [{ type: "tool_use", toolUseId: "t1", name: "Bash", input: "{}" }]),
      sessionEvent("u1", [{ type: "tool_result", toolUseId: "t1", isError: true, text: "Exit code 1" }]),
    ]);
    expect(d.markdown).toContain("ERROR");
  });

  it("renders handoffs, which are the durable record of a stretch's outcome", () => {
    const d = buildConversationDigest([
      ev("handoff", { stretch: "st_1", duty: "test", payload: { duty: "test", status: "complete", summary: "8/8 green", nextSteps: { next: "done" } } }),
    ]);
    expect(d.markdown).toContain("[test/complete]");
    expect(d.markdown).toContain("8/8 green");
    expect(d.markdown).toContain("done");
  });

  it("windows to the last N stretches", () => {
    const events = [
      ev("stretch-started", { stretch: "s1", payload: { ordinal: 1, duty: "triage" } }),
      sessionEvent("a1", [{ type: "text", text: "FIRST STRETCH PROSE" }], { stretch: "s1" }),
      ev("stretch-started", { stretch: "s2", payload: { ordinal: 2, duty: "implement" } }),
      sessionEvent("a2", [{ type: "text", text: "SECOND STRETCH PROSE" }], { stretch: "s2" }),
    ];
    const all = buildConversationDigest(events);
    expect(all.counts.stretches).toBe(2);
    const one = buildConversationDigest(events, { stretches: 1 });
    expect(one.counts.stretches).toBe(1);
    expect(one.markdown).toContain("SECOND STRETCH PROSE");
    expect(one.markdown).not.toContain("FIRST STRETCH PROSE");
  });

  it("reports truncation instead of silently returning a short digest", () => {
    const events = Array.from({ length: 60 }, (_, i) =>
      sessionEvent(`a${i}`, [{ type: "text", text: "z".repeat(1000) }]));
    const d = buildConversationDigest(events, { maxChars: 5000, proseChars: 1000 });
    expect(d.truncated).toBe(true);
    expect(d.markdown).toContain("digest truncated");
    // The TAIL survives: the recent end is the part a stretch needs.
    expect(d.markdown.length).toBeLessThan(5200);
  });

  it("orders by when a message first appeared, not when it settled", () => {
    const d = buildConversationDigest([
      { seq: 1, kind: "session-event", payload: { id: "a1", revision: 1, blocks: [{ type: "text", text: "EARLY" }] } },
      { seq: 2, kind: "session-event", payload: { id: "a2", revision: 1, blocks: [{ type: "text", text: "LATE" }] } },
      // a1 settles AFTER a2 was written - a long streaming reply.
      { seq: 3, kind: "session-event", payload: { id: "a1", revision: 2, blocks: [{ type: "text", text: "EARLY settled" }] } },
    ]);
    expect(d.markdown.indexOf("EARLY settled")).toBeLessThan(d.markdown.indexOf("LATE"));
  });
});
