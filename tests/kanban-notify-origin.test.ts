// The feedback slice: a channel-originated card posts its outcome back to the
// originating thread when it lands terminal (done / needs-attention). These
// cover the PURE edge logic + message shape; the fetch side is fire-and-forget
// by design and exercised by the live run.
import { describe, it, expect } from "vitest";

// @ts-ignore — pure .mjs
const lib = () => import("../fittings/seed/kanban-loop/lib/notify-origin.mjs");

const origin = { channel: "web", threadId: "chat-abc123-xyz" };
const base = {
  id: "01TESTCARD",
  title: "Add a CSV export button",
  originChannel: origin,
  lastReply: "Done - the button exports the visible rows.",
  videoUrl: null,
  attentionReason: null
};

describe("terminalTransition (edge detection)", () => {
  it("fires when the list CHANGES into done or needs-attention", async () => {
    const { terminalTransition } = await lib();
    expect(terminalTransition({ ...base, list: "test" }, { ...base, list: "done" })).toBe(true);
    expect(terminalTransition({ ...base, list: "plan" }, { ...base, list: "needs-attention" })).toBe(true);
  });

  it("does NOT fire on repeated saves in the same terminal list", async () => {
    const { terminalTransition } = await lib();
    expect(terminalTransition({ ...base, list: "done" }, { ...base, list: "done" })).toBe(false);
    expect(terminalTransition({ ...base, list: "needs-attention" }, { ...base, list: "needs-attention" })).toBe(false);
  });

  it("does NOT fire for non-terminal moves, quick cards, or cards without an origin", async () => {
    const { terminalTransition } = await lib();
    expect(terminalTransition({ ...base, list: "plan" }, { ...base, list: "implement" })).toBe(false);
    expect(terminalTransition({ ...base, list: "test" }, { ...base, list: "done", quick: true })).toBe(false);
    expect(terminalTransition({ ...base, list: "test", originChannel: null }, { ...base, list: "done", originChannel: null })).toBe(false);
    expect(terminalTransition({ ...base, list: "test" }, { ...base, list: "done", originChannel: { channel: "web" } })).toBe(false);
  });

  it("fires again on a NEW outcome after the card was revived", async () => {
    const { terminalTransition } = await lib();
    // parked -> retried (todo) -> done: both edges are real outcomes.
    expect(terminalTransition({ ...base, list: "needs-attention" }, { ...base, list: "todo" })).toBe(false);
    expect(terminalTransition({ ...base, list: "todo" }, { ...base, list: "done" })).toBe(true);
  });
});

describe("outcomeMessage (what the thread reads)", () => {
  it("a done card reads as a completion with the reply snippet", async () => {
    const { outcomeMessage } = await lib();
    const text = outcomeMessage({ ...base, list: "done" });
    expect(text).toContain("Run complete — Add a CSV export button.");
    expect(text).toContain("exports the visible rows");
  });

  it("a parked card carries the attention reason", async () => {
    const { outcomeMessage } = await lib();
    const text = outcomeMessage({
      ...base,
      list: "needs-attention",
      attentionReason: "The Implement run produced no output."
    });
    expect(text).toContain("Run needs attention — Add a CSV export button.");
    expect(text).toContain("produced no output");
  });

  it("long snippets are truncated, evidence video linked when present", async () => {
    const { outcomeMessage } = await lib();
    const text = outcomeMessage({
      ...base,
      list: "done",
      lastReply: "x".repeat(1000),
      videoUrl: "http://gallery/final.mp4"
    });
    expect(text).toContain("…");
    expect(text).not.toContain("x".repeat(500));
    expect(text).toContain("Evidence video: http://gallery/final.mp4");
  });
});
