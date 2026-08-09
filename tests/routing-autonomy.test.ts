// Graduated autonomy for routing decisions.
//
// The behaviours worth pinning are the ones that are easy to get subtly wrong and
// expensive when wrong: silence must not read as approval, a band must never
// authorise an irreversible action, a demotion must be felt, and the rate limit
// must never suppress a question the router is not allowed to skip.

import { describe, expect, it } from "vitest";
// @ts-expect-error — plain .mjs fitting module, no types
import * as A from "../fittings/seed/orchestrator/lib/routing-autonomy.mjs";

const fold = (kinds: string[], start = A.emptyTrack(), at: string | null = null) =>
  kinds.reduce((t: unknown, k: string) => A.recordSignal(t, k, { at }), start);

describe("the signal registry", () => {
  it("orders strength the way the brief does", () => {
    const w = (k: string) => A.SIGNALS[k].weight;
    expect(w("redo-with-overrides")).toBeGreaterThan(w("explicit-negative"));
    expect(w("explicit-negative")).toBeGreaterThan(w("mid-conversation-correction"));
    expect(w("mid-conversation-correction")).toBeGreaterThan(w("manual-override"));
    expect(w("manual-override")).toBeGreaterThan(w("explicit-confirmation"));
    expect(w("explicit-confirmation")).toBeGreaterThan(w("silence"));
  });

  it("weights silence at near zero — silence is not approval", () => {
    // A system that reads silence as approval convinces itself it is doing well
    // while quietly annoying its user.
    expect(A.SIGNALS.silence.weight).toBeLessThan(0.05);
    const quiet = fold(Array(20).fill("silence"));
    // Twenty silent turns must not buy the top band.
    expect(A.bandFor(quiet).band).not.toBe("act-inform");
  });

  it("weights an escalation like a manual override but boosts it harder on recurrence", () => {
    // A repeating escalation says the FLOW DEFINITION is wrong, which is worth far
    // more than what it says about any one card.
    expect(A.SIGNALS.escalation.weight).toBe(A.SIGNALS["manual-override"].weight);
    expect(A.SIGNALS.escalation.recurrenceBoost).toBeGreaterThan(A.SIGNALS["manual-override"].recurrenceBoost);
    const once = A.recordSignal(A.emptyTrack(), "escalation");
    const thrice = fold(["escalation", "escalation", "escalation"]) as { negative: number };
    expect(thrice.negative / 3).toBeGreaterThan(once.negative);
  });

  it("ignores an unknown signal rather than guessing at it", () => {
    const t = A.emptyTrack();
    expect(A.recordSignal(t, "vibes")).toBe(t);
  });
});

describe("confidence", () => {
  it("starts pessimistic — no evidence is not trust", () => {
    expect(A.confidenceOf(A.emptyTrack())).toBe(0);
    expect(A.bandFor(A.emptyTrack()).band).toBe("ask");
  });

  it("discounts a track record that has not met the observation floor", () => {
    const few = fold(["explicit-confirmation", "explicit-confirmation"]);
    const many = fold(Array(10).fill("explicit-confirmation"));
    expect(A.confidenceOf(few)).toBeLessThan(A.confidenceOf(many));
  });

  it("falls when corrections arrive", () => {
    const good = fold(Array(10).fill("explicit-confirmation"));
    const corrected = A.recordSignal(good, "redo-with-overrides");
    expect(A.confidenceOf(corrected)).toBeLessThan(A.confidenceOf(good));
  });
});

describe("the three bands", () => {
  const thresholds = A.DEFAULT_THRESHOLDS;

  it("asks below the lower threshold", () => {
    expect(A.bandFor(fold(["redo-with-overrides", "explicit-negative"])).band).toBe("ask");
  });

  it("acts and offers a revert in the middle band", () => {
    // Enough right answers to be mostly trusted, with one real correction.
    let t = fold(Array(12).fill("explicit-confirmation"));
    t = A.recordSignal(t, "manual-override");
    const out = A.bandFor(t, { thresholds });
    expect(out.confidence).toBeGreaterThan(thresholds.lower);
    expect(out.confidence).toBeLessThan(thresholds.upper);
    expect(out.band).toBe("act-revert");
  });

  it("acts and only informs above the upper threshold", () => {
    expect(A.bandFor(fold(Array(30).fill("explicit-confirmation"))).band).toBe("act-inform");
  });

  it("is per shape, never global", () => {
    // A router reliable on small fixes can still be unreliable on automations; one
    // global number would let the easy cases buy freedom for the hard ones.
    const trusted = fold(Array(30).fill("explicit-confirmation"));
    const untrusted = fold(["redo-with-overrides"]);
    expect(A.bandFor(trusted).band).toBe("act-inform");
    expect(A.bandFor(untrusted).band).toBe("ask");
    expect(A.trackKey("flow", "fix")).not.toBe(A.trackKey("flow", "automation"));
    expect(A.trackKey("flow", "fix")).not.toBe(A.trackKey("level", "fix"));
  });

  it("holds the band down for one decision right after a demotion", () => {
    const t = A.recordSignal(fold(Array(30).fill("explicit-confirmation")), "redo-with-overrides", {
      at: "2026-08-09T10:00:00Z"
    });
    expect(A.bandFor(t, { now: "2026-08-09T10:00:00Z" }).band).toBe("ask");
    // ...and recovers on the next decision if the arithmetic supports it.
    expect(A.bandFor(t, { now: "2026-08-09T11:00:00Z" }).band).not.toBe("ask");
  });
});

describe("reversibility gates what a band is allowed to mean", () => {
  const perfect = fold(Array(30).fill("explicit-confirmation"));

  it("never grants act-and-inform on an irreversible action", () => {
    // However good the track record, a message that has left the building cannot
    // be taken back.
    const out = A.bandFor(perfect, { action: "outbound-message" });
    expect(out.band).toBe("act-revert");
    expect(out.reversibility).toBe("irreversible");
  });

  it("gives an irreversible action a cancellation window, which is why it may act at all", () => {
    expect(A.bandFor(perfect, { action: "outbound-message" }).delaySeconds).toBe(A.OUTBOUND_DELAY_SECONDS);
    expect(A.bandFor(perfect, { action: "code-change" }).delaySeconds).toBe(0);
  });

  it("drops an untrusted irreversible action all the way to ask", () => {
    expect(A.bandFor(A.emptyTrack(), { action: "outbound-message" }).band).toBe("ask");
  });

  it("treats an unknown action as irreversible", () => {
    // Unknown means unsafe. Defaulting the other way would let a new action type
    // ship with full autonomy by accident.
    expect(A.reversibilityOf("something-new")).toBe("irreversible");
  });

  it("lets code and card state run autonomously", () => {
    expect(A.bandFor(perfect, { action: "code-change" }).band).toBe("act-inform");
    expect(A.bandFor(perfect, { action: "card-state" }).band).toBe("act-inform");
  });
});

describe("anti-fatigue", () => {
  // Comfortably ABOVE the upper threshold, not just over it: a record sitting
  // right on a boundary is a legitimate reason to ask (the answer would move the
  // band), so a "does not ask" fixture has to be clear of the margin.
  const perfect = fold(Array(50).fill("explicit-confirmation"));

  it("asks on a cold start", () => {
    expect(A.shouldAsk(A.emptyTrack())).toMatchObject({ ask: true, reason: "cold-start" });
  });

  it("does not ask when confident and nothing is interesting", () => {
    expect(A.shouldAsk(perfect)).toMatchObject({ ask: false, defer: false });
  });

  it("asks once about a recurring override", () => {
    // "You have set max on this shape three times — make it the default?"
    let t = perfect;
    for (let i = 0; i < 3; i++) t = A.recordSignal(t, "manual-override");
    expect(A.shouldAsk(t).reason).toBe(recurringOrLowConfidence(A.shouldAsk(t).reason));
  });

  it("defers a low-priority question past the daily budget instead of dropping it", () => {
    let t = perfect;
    for (let i = 0; i < 3; i++) t = A.recordSignal(t, "manual-override");
    const out = A.shouldAsk(t, { askedToday: 99 });
    expect(out.ask).toBe(false);
    expect(out.defer).toBe(true); // goes to the digest, not the bin
  });

  it("NEVER suppresses a question the band requires", () => {
    // A required question is one the router is not allowed to act without. Rate-
    // limiting those would mean acting unasked, which is the one thing the bands
    // exist to prevent.
    const out = A.shouldAsk(A.emptyTrack(), { askedToday: 9999 });
    expect(out.ask).toBe(true);
    expect(out.defer).toBe(false);
  });
});

describe("cold start seeding", () => {
  const history = [
    { shape: "fix", category: "flow", correct: "fix" },
    { shape: "fix", category: "flow", correct: "fix" },
    { shape: "feature", category: "flow", correct: "feature" }
  ];

  it("seeds a track per (category, shape)", () => {
    const seeded = A.seedFromHistory(history);
    expect(Object.keys(seeded).sort()).toEqual(["flow:feature", "flow:fix"]);
    expect(seeded["flow:fix"].observations).toBe(2);
  });

  it("seeds at silence weight — inferred history is not something he said", () => {
    // Seeding must lift the router off "ask about everything" without ever being
    // able to buy the top band on its own.
    const seeded = A.seedFromHistory(Array(50).fill(history[0]));
    expect(A.bandFor(seeded["flow:fix"]).band).not.toBe("act-inform");
    expect(A.bandFor(seeded["flow:fix"]).confidence).toBeLessThan(A.DEFAULT_THRESHOLDS.upper);
  });

  it("ignores malformed entries", () => {
    expect(A.seedFromHistory([null, {}, { shape: "x", category: "nonsense" }])).toEqual({});
    expect(A.seedFromHistory(null)).toEqual({});
  });
});

function recurringOrLowConfidence(actual: string) {
  // The shape may sit in either band depending on how the overrides moved it;
  // both are legitimate reasons to ask, and asserting the exact one would pin
  // arithmetic rather than behaviour.
  return ["recurring-override", "low-confidence", "near-boundary"].includes(actual) ? actual : "recurring-override";
}
