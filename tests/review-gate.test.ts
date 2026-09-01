// The adversarial review used to run on every implement stretch. On the
// 2026-08-28 benchmark that was $0.44 of $2.11 across two passes that found
// nothing. It is now gated - and the gate resolves every uncertainty towards
// reviewing, because a skipped review that was needed is worse than a review
// that was not.
import { describe, it, expect } from "vitest";
// @ts-ignore - pure .mjs module (single-line on purpose; see harness-profiles.test.ts)
import { reviewGateDecision, stretchChangeFootprint, applyFlowPolicy, REVIEW_GATE } from "../fittings/seed/http-gateway/scripts/lib/stretch.mjs";

type Ev = Record<string, unknown>;
const store = (events: Ev[]) => ({
  tail: (_n: number, opts?: { kinds?: string[] }) =>
    events.filter((e) => !opts?.kinds || opts.kinds.includes(e.kind as string)),
});

const write = (stretch: string, toolUseId: string, filePath: string, content: string): Ev => ({
  kind: "session-event",
  stretch,
  payload: { id: toolUseId, blocks: [{ type: "tool_use", toolUseId, name: "Write", input: JSON.stringify({ file_path: filePath, content }) }] },
});

describe("stretchChangeFootprint", () => {
  it("sums what a stretch wrote, by file, from the ledger", () => {
    const s = store([
      write("s1", "t1", "/p/a.ts", "x".repeat(100)),
      write("s1", "t2", "/p/b.ts", "y".repeat(200)),
      write("s2", "t3", "/p/c.ts", "z".repeat(9999)),
    ]);
    const f = stretchChangeFootprint(s as never, "s1");
    expect(f.files.sort()).toEqual(["/p/a.ts", "/p/b.ts"]);
    expect(f.bytes).toBeGreaterThan(300);
    expect(f.bytes).toBeLessThan(1000);
    expect(f.known).toBe(true);
  });

  it("takes the longest input per tool id, because arguments stream as prefixes", () => {
    const s = store([
      { kind: "session-event", stretch: "s1", payload: { id: "e1", blocks: [{ type: "tool_use", toolUseId: "t1", name: "Write", input: '{"file_path":"/p/a' }] } },
      { kind: "session-event", stretch: "s1", payload: { id: "e2", blocks: [{ type: "tool_use", toolUseId: "t1", name: "Write", input: JSON.stringify({ file_path: "/p/a.ts", content: "q".repeat(500) }) }] } },
    ]);
    const f = stretchChangeFootprint(s as never, "s1");
    expect(f.files).toEqual(["/p/a.ts"]);
    expect(f.bytes).toBeGreaterThan(500);
  });

  it("ignores reads - only what was written counts as a change", () => {
    const s = store([
      { kind: "session-event", stretch: "s1", payload: { id: "e1", blocks: [{ type: "tool_use", toolUseId: "t1", name: "Read", input: JSON.stringify({ file_path: "/p/big.ts" }) }] } },
    ]);
    expect(stretchChangeFootprint(s as never, "s1").known).toBe(false);
  });
});

describe("reviewGateDecision", () => {
  const small = [write("s1", "t1", "/p/a.ts", "x".repeat(500))];

  it("skips a small, complete, unremarkable change", () => {
    const d = reviewGateDecision(store(small) as never, { stretchId: "s1", handoff: { status: "complete" } });
    expect(d.review).toBe(false);
  });

  it("reviews a large change", () => {
    const s = store([write("s1", "t1", "/p/a.ts", "x".repeat(REVIEW_GATE.changedBytes + 1))]);
    expect(reviewGateDecision(s as never, { stretchId: "s1", handoff: { status: "complete" } }).review).toBe(true);
  });

  it("reviews a change spread over many files even when each is tiny", () => {
    const s = store(Array.from({ length: REVIEW_GATE.changedFiles }, (_, i) =>
      write("s1", `t${i}`, `/p/f${i}.ts`, "x")));
    expect(reviewGateDecision(s as never, { stretchId: "s1", handoff: { status: "complete" } }).review).toBe(true);
  });

  it("reviews an incomplete handoff whatever the size", () => {
    const d = reviewGateDecision(store(small) as never, { stretchId: "s1", handoff: { status: "partial" } });
    expect(d.review).toBe(true);
    expect(d.reason).toContain("partial");
  });

  it("reviews anything touching a sensitive path", () => {
    const s = store([write("s1", "t1", "/p/auth-token.ts", "x")]);
    const d = reviewGateDecision(s as never, { stretchId: "s1", handoff: { status: "complete" } });
    expect(d.review).toBe(true);
    expect(d.reason).toContain("sensitive");
  });

  it("reviews when the request asked for one", () => {
    const s = store([...small, { kind: "user-message", payload: { text: "build it and have it reviewed properly" } }]);
    expect(reviewGateDecision(s as never, { stretchId: "s1", handoff: { status: "complete" } }).review).toBe(true);
  });

  it("reviews when the change size cannot be read - unknown is not small", () => {
    const d = reviewGateDecision(store([]) as never, { stretchId: "s1", handoff: { status: "complete" } });
    expect(d.review).toBe(true);
    expect(d.reason).toContain("unknown");
  });

  it("holds a repeat pass to a much higher bar - that is the A-B loop it stops", () => {
    const mid = "x".repeat(REVIEW_GATE.changedBytes + 1000);
    const first = store([write("s1", "t1", "/p/a.ts", mid)]);
    expect(reviewGateDecision(first as never, { stretchId: "s1", handoff: { status: "complete" } }).review).toBe(true);

    const afterReview = store([
      write("s1", "t1", "/p/a.ts", mid),
      { kind: "handoff", payload: { duty: "adversarial-review", status: "complete" } },
    ]);
    const d = reviewGateDecision(afterReview as never, { stretchId: "s1", handoff: { status: "complete" } });
    expect(d.review).toBe(false);
    expect(d.reason).toContain("repeat pass");
  });
});

describe("applyFlowPolicy with the gate", () => {
  it("still forces a review when the gate fires", () => {
    const s = store([write("s1", "t1", "/p/a.ts", "x".repeat(50_000))]);
    const p = applyFlowPolicy("done", {
      store: s as never, duty: "implement", selectedDuties: ["implement", "adversarial-review", "test"],
      stretchId: "s1", handoff: { status: "complete" },
    });
    expect(p.next).toBe("adversarial-review");
    expect(p.reason).toContain("review-before-done");
  });

  it("reports a skipped review rather than silently dropping it", () => {
    const s = store([write("s1", "t1", "/p/a.ts", "x".repeat(100))]);
    const p = applyFlowPolicy("done", {
      store: s as never, duty: "implement", selectedDuties: ["implement", "adversarial-review"],
      stretchId: "s1", handoff: { status: "complete" },
    });
    expect(p.next).not.toBe("adversarial-review");
    expect(p.skippedReview).toBeTruthy();
  });

  it("leaves a non-done handoff completely alone", () => {
    const p = applyFlowPolicy("test", { store: store([]) as never, duty: "implement", selectedDuties: ["test"] });
    expect(p).toEqual({ next: "test", rewritten: false, reason: null });
  });
});
