// Weekly board review (Workstream C): computeReview buckets cards into
// attention / stalled / moving from timestamps alone — pure, no disk, no
// engine. These tests pin the bucket predicates and their precedence
// (attention > stalled > moving), the stall threshold boundary, and that
// terminal cards vanish from the report.
import { describe, it, expect } from "vitest";

// @ts-ignore — pure .mjs
import { computeReview, renderReviewMarkdown, reviewNoticeText, DEFAULT_STALL_HOURS } from "../fittings/seed/kanban-loop/lib/review.mjs";

const NOW = Date.parse("2026-07-20T08:00:00.000Z");
const HOUR = 3_600_000;
const DAY = 24 * HOUR;
const iso = (msAgo: number) => new Date(NOW - msAgo).toISOString();

const STALL = DEFAULT_STALL_HOURS * HOUR; // 2h

function card(overrides: Record<string, unknown> = {}) {
  return {
    id: "01AAAAAAAAAAAAAAAAAAAAAAAA",
    title: "a card",
    list: "todo",
    status: "ok",
    updated: iso(HOUR),
    events: [],
    ...overrides
  };
}

describe("computeReview buckets", () => {
  it("a recently routed/moved card is moving", () => {
    const r = computeReview({
      cards: [
        card({ id: "01R1", events: [{ at: iso(2 * DAY), kind: "routed", message: "x" }] }),
        card({ id: "01M1", events: [{ at: iso(6 * DAY), kind: "moved", message: "x" }] })
      ],
      now: NOW
    });
    expect(r.moving.map((m: any) => m.card.id)).toEqual(["01R1", "01M1"]);
    expect(r.stalled).toEqual([]);
    expect(r.attention).toEqual([]);
  });

  it("a routed event OUTSIDE the 7-day window does not count as moving", () => {
    const r = computeReview({
      cards: [card({ events: [{ at: iso(8 * DAY), kind: "routed", message: "x" }] })],
      now: NOW
    });
    expect(r.moving).toEqual([]);
  });

  it("a running card past the stall threshold is stalled; just under is not", () => {
    const r = computeReview({
      cards: [
        card({ id: "01S1", status: "running", runningSince: iso(3 * HOUR), events: [{ at: iso(3 * HOUR), kind: "routed" }] }),
        card({ id: "01OK", status: "running", runningSince: iso(STALL - 60_000), events: [{ at: iso(HOUR), kind: "routed" }] })
      ],
      now: NOW
    });
    expect(r.stalled.length).toBe(1);
    expect(r.stalled[0].card.id).toBe("01S1");
    expect(r.stalled[0].reasons[0]).toMatch(/running for/);
    // stalled takes precedence over moving; the healthy runner still shows as moving
    expect(r.moving.map((m: any) => m.card.id)).toEqual(["01OK"]);
  });

  it("an aged waitingOn.since is stalled with the waiting reason", () => {
    const r = computeReview({
      cards: [card({ waitingOn: { cardId: "01X", cardTitle: "blocker", since: iso(5 * HOUR), until: "lease" } })],
      now: NOW
    });
    expect(r.stalled.length).toBe(1);
    expect(r.stalled[0].reasons[0]).toMatch(/waiting on blocker/);
  });

  it("a non-terminal card untouched for over 7 days is stalled as idle", () => {
    const r = computeReview({ cards: [card({ updated: iso(8 * DAY) })], now: NOW });
    expect(r.stalled.length).toBe(1);
    expect(r.stalled[0].reasons[0]).toMatch(/untouched for/);
  });

  it("needs-attention cards land in attention ONLY, even when also aged", () => {
    const r = computeReview({
      cards: [card({ list: "needs-attention", status: "needs-attention", attentionReason: "parked: no evidence", updated: iso(9 * DAY) })],
      now: NOW
    });
    expect(r.attention.length).toBe(1);
    expect(r.attention[0].reason).toMatch(/no evidence/);
    expect(r.stalled).toEqual([]);
  });

  it("done cards appear in no bucket", () => {
    const r = computeReview({
      cards: [card({ list: "done", updated: iso(30 * DAY), events: [{ at: iso(DAY), kind: "routed" }] })],
      now: NOW
    });
    expect(r.moving).toEqual([]);
    expect(r.stalled).toEqual([]);
    expect(r.attention).toEqual([]);
  });

  it("a custom stallMs is honored", () => {
    const r = computeReview({
      cards: [card({ status: "running", runningSince: iso(30 * 60_000) })],
      now: NOW,
      stallMs: 15 * 60_000
    });
    expect(r.stalled.length).toBe(1);
  });
});

describe("review rendering", () => {
  it("renderReviewMarkdown sections carry counts and card lines", () => {
    const r = computeReview({
      cards: [
        card({ id: "01S1", title: "stuck one", project: "side-income", workKind: "channel", status: "running", runningSince: iso(4 * HOUR) }),
        card({ id: "01M1", title: "healthy", events: [{ at: iso(DAY), kind: "moved" }] }),
        card({ id: "01A1", title: "parked", list: "needs-attention", attentionReason: "iteration cap" })
      ],
      now: NOW
    });
    const md = renderReviewMarkdown(r, { now: new Date(NOW).toISOString() });
    expect(md).toContain("# Kanban weekly review - 2026-07-20");
    expect(md).toContain("## Needs attention (1)");
    expect(md).toContain("## Stalled (1)");
    expect(md).toContain("stuck one");
    expect(md).toContain("(side-income)");
    expect(md).toContain("{channel}");
    expect(md).toMatch(/## Moving - last 7 days \(1\)/);
  });

  it("reviewNoticeText leads with the counts and names stalled cards", () => {
    const r = computeReview({
      cards: [card({ id: "01S1", title: "stuck one", status: "running", runningSince: iso(4 * HOUR) })],
      now: NOW
    });
    const text = reviewNoticeText(r, "/tmp/report.md");
    expect(text).toMatch(/1 needs attention|0 needs attention/);
    expect(text).toContain("Stalled: stuck one");
    expect(text).toContain("Report: /tmp/report.md");
  });
});
