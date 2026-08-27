import { createElement as h } from "react";
import { renderToStaticMarkup } from "react-dom/server";
import { describe, expect, it } from "vitest";
import {
  conversationActivity,
  stripHandoffFence,
  type SessionBlock,
  type SessionEvent,
} from "../packages/claude-chat/src/journal";
import { SessionEventTimeline } from "../packages/claude-chat/src/SessionTranscript";
// @ts-ignore — pure .mjs
import { ledgerToSessionEvents } from "../packages/claude-pty/src/conversation-adapt.mjs";

// The conversation surface's live behaviour (spinners, the needs-input banner,
// per-stretch turn_end suppression) all hangs off ONE pure derivation over the
// event stream plus two adapter fields (`next` and the handoff bag on the ended
// stretch block). These tests pin that chain end to end: adapter -> block
// fields -> derivation -> render switch.

const assistant = (id: string, blocks: SessionBlock[], extra: Partial<SessionEvent> = {}): SessionEvent => ({
  id,
  role: "assistant",
  ts: 1_000,
  blocks,
  ...extra,
});

const user = (id: string, text: string, ts = 1_000): SessionEvent => ({
  id,
  role: "user",
  ts,
  blocks: [{ type: "text", text }],
});

const stretch = (phase: "started" | "ended", extra: Partial<SessionBlock> = {}): SessionBlock => ({
  type: "stretch",
  phase,
  stretchId: "01S",
  attribution: { model: "claude-sonnet-5" },
  duty: "implement",
  ...extra,
});

describe("conversationActivity", () => {
  it("is none for a stream with no conversation spine", () => {
    expect(conversationActivity([
      user("u1", "hello"),
      assistant("a1", [{ type: "text", text: "hi" }]),
    ]).mode).toBe("none");
  });

  it("is working while a stretch is open, carrying duty and model", () => {
    const activity = conversationActivity([assistant("e1", [stretch("started")], { ts: 5_000 })]);
    expect(activity.mode).toBe("working");
    expect(activity.duty).toBe("implement");
    expect(activity.model).toBe("claude-sonnet-5");
    expect(activity.since).toBe(5_000);
  });

  it("is handoff after an ended stretch that points at another duty", () => {
    const activity = conversationActivity([assistant("e1", [stretch("ended", { next: "review" })])]);
    expect(activity.mode).toBe("handoff");
    expect(activity.next).toBe("review");
  });

  it("is needs-input with the blocker riding along", () => {
    const activity = conversationActivity([
      assistant("e1", [stretch("ended", {
        next: "needs-input",
        blockerWhat: "no valid handoff from the stretch",
        blockerNeeds: "a human look at the conversation log",
        blockerWho: "user",
      })]),
    ]);
    expect(activity.mode).toBe("needs-input");
    expect(activity.blockerWhat).toBe("no valid handoff from the stretch");
    expect(activity.blockerNeeds).toBe("a human look at the conversation log");
  });

  it("is done at a done handoff, and idle for a record too old to carry next", () => {
    expect(conversationActivity([assistant("e1", [stretch("ended", { next: "done", summary: "shipped" })])]).mode).toBe("done");
    expect(conversationActivity([assistant("e1", [stretch("ended")])]).mode).toBe("idle");
  });

  it("ignores user-SHAPED runtime events: a teed tool result is not a queued message", () => {
    // The SDK tee writes tool results as role "user" with toolResultsOnly; the
    // live incident: a finished conversation read as "Starting - message
    // queued" because its last teed tool result outranked the done boundary.
    const activity = conversationActivity([
      assistant("e1", [stretch("ended", { next: "done", summary: "shipped" })]),
      { id: "tr1", role: "user", ts: 2_000, toolResultsOnly: true, blocks: [{ type: "tool_result", text: "ok" }] },
    ]);
    expect(activity.mode).toBe("done");
  });

  it("is starting after a user message that follows the last boundary", () => {
    const activity = conversationActivity([
      assistant("e1", [stretch("ended", { next: "needs-input" })]),
      user("u1", "here is the missing detail", 9_000),
    ]);
    expect(activity.mode).toBe("starting");
    expect(activity.since).toBe(9_000);
  });

  it("is awaiting-approval on an unanswered ask, and starting once the user replies", () => {
    const ask = assistant("e2", [{ type: "ledger", kind: "approval-requested", title: "Waiting for your go-ahead" }]);
    const paused = conversationActivity([assistant("e1", [stretch("ended", { next: "implement" })]), ask]);
    expect(paused.mode).toBe("awaiting-approval");
    const resumed = conversationActivity([
      assistant("e1", [stretch("ended", { next: "implement" })]),
      ask,
      user("u1", "Approved - continue.", 9_500),
    ]);
    expect(resumed.mode).toBe("starting");
  });
});

describe("adapter: the ended stretch carries its handoff", () => {
  const records = [
    {
      index: 0,
      ts: "2026-08-27T21:00:00.000Z",
      kind: "stretch-started",
      stretch: "s1",
      duty: "test",
      payload: { stretchId: "s1", target: { model: "claude-sonnet-5" } },
    },
    {
      index: 1,
      ts: "2026-08-27T21:05:00.000Z",
      kind: "handoff",
      stretch: "s1",
      duty: "test",
      payload: {
        stretchId: "s1",
        status: "failed",
        summary: "The stretch ended without a valid handoff.",
        nextSteps: { next: "needs-input", why: "gate could not extract", items: [] },
        blocker: { what: "no valid handoff", needs: "a human look", who: "user" },
      },
    },
    {
      index: 2,
      ts: "2026-08-27T21:05:01.000Z",
      kind: "stretch-ended",
      stretch: "s1",
      duty: "test",
      payload: { stretchId: "s1", outcome: "synthesized", next: "needs-input", usedTokens: 100, durationMs: 1_000 },
    },
  ];

  it("attaches next, summary and blocker from the preceding handoff record", () => {
    const events = ledgerToSessionEvents(records, { conversationId: "c1" });
    const ended = events
      .flatMap((event: SessionEvent) => event.blocks)
      .find((block: SessionBlock) => block.type === "stretch" && block.phase === "ended");
    expect(ended?.next).toBe("needs-input");
    expect(ended?.summary).toBe("The stretch ended without a valid handoff.");
    expect(ended?.blockerWhat).toBe("no valid handoff");
    expect(ended?.blockerNeeds).toBe("a human look");
    expect(ended?.blockerWho).toBe("user");
  });

  it("keeps the pairing across a batch boundary via the continuity maps", () => {
    const stretchStarts = new Map();
    const eventSlots = new Map();
    const handoffBags = new Map();
    const opts = { conversationId: "c1", stretchStarts, eventSlots, handoffBags };
    ledgerToSessionEvents(records.slice(0, 2), opts);
    const later = ledgerToSessionEvents(records.slice(2), opts);
    const ended = later
      .flatMap((event: SessionEvent) => event.blocks)
      .find((block: SessionBlock) => block.type === "stretch" && block.phase === "ended");
    expect(ended?.blockerWhat).toBe("no valid handoff");
    expect(ended?.summary).toBe("The stretch ended without a valid handoff.");
  });

  it("renders approval-requested as its own first-class ledger kind", () => {
    const events = ledgerToSessionEvents([
      {
        index: 0,
        ts: "2026-08-27T21:00:00.000Z",
        kind: "approval-requested",
        payload: { next: "implement", plan: "three edits, one test", items: ["a", "b"] },
      },
    ], { conversationId: "c1" });
    const row = events[0]?.blocks[0];
    expect(row?.type).toBe("ledger");
    expect(row?.kind).toBe("approval-requested");
    expect(row?.title).toContain("go-ahead");
  });
});

describe("handoff-fence stripping", () => {
  it("cuts the fence and its tail from prose, and leaves fence-free text alone", () => {
    const reply = "All done here.\n\n```handoff\n{\"v\":1,\"status\":\"complete\"}\n```\n";
    expect(stripHandoffFence(reply)).toBe("All done here.");
    expect(stripHandoffFence("plain reply")).toBe("plain reply");
    // Mid-stream, the fence opener may be all that has arrived - the cut is
    // still exactly right because the fence is the reply's tail by contract.
    expect(stripHandoffFence("working…\n```handoff\n{\"v\"")).toBe("working…");
  });

  it("never renders the protocol fence inside a stretch turn", () => {
    const html = renderToStaticMarkup(
      h(SessionEventTimeline, {
        events: [
          assistant("e1", [stretch("started")], { turnId: "01S" }),
          assistant("t1", [{ type: "text", text: "Replied warmly.\n\n```handoff\n{\"v\":1,\"duty\":\"responder\"}\n```" }], { turnId: "01S" }),
        ],
      })
    );
    expect(html).toContain("Replied warmly.");
    expect(html).not.toContain("handoff");
  });
});

describe("per-stretch turn_end suppression in conversation turns", () => {
  const stretchTurn = (turnEnd: SessionBlock, extraEvents: SessionEvent[] = []): SessionEvent[] => [
    assistant("e1", [stretch("started")], { turnId: "01S" }),
    ...extraEvents,
    assistant("e2", [turnEnd], { turnId: "01S" }),
  ];

  it("drops a completed turn_end notice inside a stretch turn", () => {
    const html = renderToStaticMarkup(
      h(SessionEventTimeline, {
        events: stretchTurn(
          { type: "turn_end", status: "completed", result: "done here" },
          [assistant("t1", [{ type: "text", text: "done here" }], { turnId: "01S" })]
        ),
      })
    );
    expect(html).not.toContain("Response complete");
  });

  it("still renders an unduplicated terminal result as prose", () => {
    const html = renderToStaticMarkup(
      h(SessionEventTimeline, {
        events: stretchTurn({ type: "turn_end", status: "completed", result: "the only copy of the answer" }),
      })
    );
    expect(html).not.toContain("Response complete");
    expect(html).toContain("the only copy of the answer");
  });

  it("keeps a failed turn_end notice - a failure must never be hidden", () => {
    const html = renderToStaticMarkup(
      h(SessionEventTimeline, {
        events: stretchTurn({ type: "turn_end", status: "error", result: null as unknown as string }),
      })
    );
    expect(html).toContain("Response failed");
  });

  it("keeps Response complete for plain (non-conversation) sessions", () => {
    const html = renderToStaticMarkup(
      h(SessionEventTimeline, {
        events: [assistant("e1", [
          { type: "text", text: "hi" },
          { type: "turn_end", status: "completed", result: "hi" },
        ])],
      })
    );
    expect(html).toContain("Response complete");
  });
});
