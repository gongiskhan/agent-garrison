import { createElement as h } from "react";
import { renderToStaticMarkup } from "react-dom/server";
import { describe, expect, it } from "vitest";
import {
  groupSessionTurns,
  hasVisibleSessionActivity,
  mergeSessionEvents,
  sessionActivityBeats,
  type SessionBlock,
  type SessionEvent,
} from "../packages/claude-chat/src/journal";
import { SessionEventTimeline } from "../packages/claude-chat/src/SessionTranscript";

// The conversation spine renders inside the SAME canonical timeline as prose,
// tools and notices - it is two new block types in one vocabulary, not a second
// lane. These tests pin the four journal-side seams a new block type has to pass
// through, plus the render switch that turns them into rows.

const assistant = (id: string, blocks: SessionBlock[], extra: Partial<SessionEvent> = {}): SessionEvent => ({
  id,
  role: "assistant",
  ts: null,
  blocks,
  ...extra,
});

const stretchBlock = (phase: "started" | "ended", extra: Partial<SessionBlock> = {}): SessionBlock => ({
  type: "stretch",
  phase,
  stretchId: "01STRETCH",
  attribution: { route: "cc-sonnet", runtime: "agent-sdk", model: "sonnet", duty: "implement" },
  duty: "implement",
  chosenBy: "duty-default",
  ...extra,
});

const ledgerBlock = (extra: Partial<SessionBlock> = {}): SessionBlock => ({
  type: "ledger",
  kind: "handoff",
  title: "implement -> review",
  ...extra,
});

describe("conversation block types in the canonical journal", () => {
  it("emits one activity beat per stretch and ledger block, in place", () => {
    const beats = sessionActivityBeats([
      assistant("e1", [
        stretchBlock("started"),
        { type: "text", text: "Working on it." },
        ledgerBlock({ kind: "delegation-dispatched", title: "review to codex/sol", seq: 7 }),
        stretchBlock("ended", { outcome: "complete", usedTokens: 12_345, durationMs: 42_000 }),
      ]),
    ]);

    expect(beats.map((beat) => beat.type)).toEqual(["stretch", "text", "ledger", "stretch"]);
    // The beat carries the block itself, so the renderer never re-reads the event.
    const first = beats[0];
    expect(first.type === "stretch" && first.block.phase).toBe("started");
    const ledger = beats[2];
    expect(ledger.type === "ledger" && ledger.block.kind).toBe("delegation-dispatched");
    expect(beats.map((beat) => beat.blockIndex)).toEqual([0, 1, 2, 3]);
  });

  it("counts a stretch-only or ledger-only event as visible activity", () => {
    // The whitelist at hasVisibleSessionActivity is what decides whether a turn
    // renders its canonical timeline at all. A conversation turn can carry ONLY a
    // boundary or a ledger row, so missing this seam makes the turn look empty.
    expect(hasVisibleSessionActivity([assistant("s", [stretchBlock("started")])])).toBe(true);
    expect(hasVisibleSessionActivity([assistant("l", [ledgerBlock()])])).toBe(true);
    // Still a whitelist: an unknown block type does not become visible for free.
    expect(hasVisibleSessionActivity([assistant("x", [{ type: "conversation_unknown" }])])).toBe(false);
  });

  it("splits synthetic assistant turns when the stamped turnId changes", () => {
    // The stretch launcher stamps turnId = stretchId, so each stretch becomes its
    // own visual turn without groupSessionTurns learning anything about stretches.
    const turns = groupSessionTurns([
      assistant("a1", [stretchBlock("started")], { turnId: "01STRETCH-A" }),
      assistant("a2", [{ type: "text", text: "first stretch" }], { turnId: "01STRETCH-A" }),
      assistant("a3", [stretchBlock("started", { stretchId: "01STRETCH-B" })], { turnId: "01STRETCH-B" }),
      assistant("a4", [{ type: "text", text: "second stretch" }], { turnId: "01STRETCH-B" }),
    ]);

    expect(turns).toHaveLength(2);
    expect(turns.map((turn) => turn.assistantEvents.map((event) => event.id))).toEqual([
      ["a1", "a2"],
      ["a3", "a4"],
    ]);
    expect(turns.every((turn) => turn.userEvents.length === 0)).toBe(true);
  });

  it("settles a stretch in place when the ended revision replaces the started row", () => {
    const started = assistant("stretch:01STRETCH", [stretchBlock("started")], { revision: 0, order: 1 });
    const trailing = assistant("after", [{ type: "text", text: "done" }], { revision: 0, order: 2 });
    const ended = assistant(
      "stretch:01STRETCH",
      [stretchBlock("ended", { outcome: "complete", usedTokens: 900, durationMs: 1_500 })],
      { revision: 1, order: 1 }
    );

    const merged = mergeSessionEvents([started, trailing], [ended]);

    // Replaced, not appended: the boundary keeps its chronological slot.
    expect(merged).toHaveLength(2);
    expect(merged[0].id).toBe("stretch:01STRETCH");
    expect(merged[0].blocks[0].phase).toBe("ended");
    expect(merged[0].blocks[0].outcome).toBe("complete");
    expect(merged[1].id).toBe("after");
    // A stale replay of the started row can never un-settle it.
    expect(mergeSessionEvents(merged, [started])[0].blocks[0].phase).toBe("ended");
  });
});

describe("conversation block renderers", () => {
  const render = (blocks: SessionBlock[]) =>
    renderToStaticMarkup(h(SessionEventTimeline, { events: [assistant("e", blocks)] }));

  it("renders a stretch boundary as a rule carrying the rail's badge vocabulary", () => {
    const html = render([
      stretchBlock("ended", { outcome: "partial", usedTokens: 12_345, durationMs: 65_000 }),
    ]);

    expect(html).toContain("cc-stretch-ended");
    expect(html).toContain("Stretch ended");
    expect(html).toContain("01STRETCH");
    expect(html).toContain("duty implement");
    expect(html).toContain("via duty-default");
    expect(html).toContain("partial");
    expect(html).toContain("12,345 tok");
    expect(html).toContain("1m 5s");
    // railBadges, not a second badge model: the target and the model both badge.
    expect(html).toContain("cc-stretch-badge");
    expect(html).toContain("cc-sonnet");
    expect(html).toContain("agent-sdk");
  });

  it("omits a badge for every dimension the stretch attribution cannot report", () => {
    const html = render([
      { type: "stretch", phase: "started", stretchId: "01BARE", attribution: {} },
    ]);

    expect(html).toContain("Stretch started");
    // No badges at all rather than "unknown" placeholders.
    expect(html).not.toContain("cc-stretch-badge");
    expect(html).not.toContain("cc-stretch-chip");
  });

  it("renders a ledger row as one expandable disclosure with an inert payload ref", () => {
    const html = render([
      ledgerBlock({
        kind: "delegation-failed",
        title: "review delegation failed",
        detail: "DelegationError: bridge exited 1",
        payloadRef: "delegation-01ABC",
        seq: 42,
      }),
    ]);

    expect(html).toContain("<details");
    expect(html).toContain("cc-ledger-warn");
    expect(html).toContain("Delegation failed");
    expect(html).toContain("review delegation failed");
    expect(html).toContain("#42");
    expect(html).toContain("DelegationError: bridge exited 1");
    // A reference label, never a link: the payload viewer is a later slice.
    expect(html).toContain("payload delegation-01ABC");
    expect(html).not.toContain('href="delegation-01ABC"');
  });

  it("keeps an unknown ledger kind readable instead of dropping the row", () => {
    const html = render([ledgerBlock({ kind: "summary-trimmed", title: "L1 trimmed to cap" })]);
    expect(html).toContain("Ledger");
    expect(html).toContain("L1 trimmed to cap");
  });
});
