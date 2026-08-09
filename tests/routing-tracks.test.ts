// The router's track record, derived from evidence rather than counted.
//
// The reason it is derived is that a counter can drift from the evidence it
// claims to summarise, and a system that is confident for reasons nobody can
// reconstruct is exactly what this run exists to end. So the tests care about
// two things: that each log line maps to the right signal about the right
// dimension, and that machine-generated noise cannot masquerade as a person
// correcting the router.

import { describe, expect, it } from "vitest";
import {
  evidenceFromVerdict,
  evidenceFromDecision,
  collapseBursts,
  BURST_WINDOW_SECONDS,
  type Evidence
} from "@/lib/routing-tracks";

const at = (s: string) => `2026-08-09T${s}Z`;

describe("evidence from a verdict", () => {
  it("reads `right` as a confirmation about both dimensions", () => {
    const out = evidenceFromVerdict({ verdict: "right", resolved: { flow: "fix" }, at: at("10:00:00") });
    expect(out.map((e) => [e.category, e.signal])).toEqual([
      ["flow", "explicit-confirmation"],
      ["level", "explicit-confirmation"]
    ]);
    expect(out[0].shape).toBe("fix");
  });

  it("attributes a correction ONLY to the dimensions it names", () => {
    // Being told the flow was wrong says nothing about whether the level was —
    // which is the whole reason the bands are per category.
    const out = evidenceFromVerdict({
      verdict: "wrong",
      resolved: { flow: "fix" },
      applied: { flow: "feature" }
    });
    expect(out).toHaveLength(1);
    expect(out[0]).toMatchObject({ category: "flow", signal: "explicit-negative" });
  });

  it("treats a redo with overrides as the strongest signal", () => {
    // Proven error AND the ground truth, demonstrated rather than described.
    const out = evidenceFromVerdict({
      verdict: "wrong",
      redo: true,
      resolved: { flow: "fix" },
      applied: { flow: "feature" }
    });
    expect(out[0].signal).toBe("redo-with-overrides");
  });

  it("still counts a `wrong` that carries no correction", () => {
    // Being told it was wrong is information even without the answer; it is just
    // the weaker signal.
    const out = evidenceFromVerdict({ verdict: "wrong", resolved: { flow: "fix" } });
    expect(out).toHaveLength(2);
    for (const e of out) expect(e.signal).toBe("explicit-negative");
  });

  it("ignores `unsure` — 'I do not know' is not evidence", () => {
    expect(evidenceFromVerdict({ verdict: "unsure", resolved: { flow: "fix" } })).toEqual([]);
  });

  it("ignores junk", () => {
    for (const junk of [null, undefined, 3, "x", {}, { verdict: "sideways" }]) {
      expect(evidenceFromVerdict(junk)).toEqual([]);
    }
  });
});

describe("evidence from a decision", () => {
  it("reads an applied escalation as a level signal", () => {
    const out = evidenceFromDecision({ kind: "escalation", applied: true, duty: "review", at: at("10:00:00") });
    expect(out).toEqual([{ category: "level", shape: "review", signal: "escalation", at: at("10:00:00") }]);
  });

  it("ignores a REFUSED escalation", () => {
    // A refusal says nothing about the flow definition, so it must not become a
    // signal about it.
    expect(evidenceFromDecision({ kind: "escalation", applied: false, duty: "review" })).toEqual([]);
  });

  it("reads a turn-override as a manual override", () => {
    const out = evidenceFromDecision({ via: "turn-override", flow: "fix", level: 2 });
    expect(out.map((e) => e.category).sort()).toEqual(["flow", "level"]);
    for (const e of out) expect(e.signal).toBe("manual-override");
  });

  it("falls back to the duty for shape when no flow was recorded", () => {
    // Flows were never written onto decisions before this run, and 942
    // turn-overrides are already on disk — without the fallback every one of them
    // collapses into a single "unknown" bucket and the evidence is wasted.
    const out = evidenceFromDecision({ via: "turn-override", duty: "implement", level: 2 });
    expect(out[0].shape).toBe("implement");
  });

  it("ignores an ordinary routed decision", () => {
    expect(evidenceFromDecision({ kind: "duty-route", duty: "implement", via: "duty-cell" })).toEqual([]);
  });
});

describe("burst collapsing", () => {
  const burst = (n: number, startSec: number, stepSec: number): Evidence[] =>
    Array.from({ length: n }, (_, i) => ({
      category: "level",
      shape: "image",
      signal: "manual-override",
      at: new Date(Date.UTC(2026, 7, 9, 3, 0, startSec + i * stepSec)).toISOString()
    }));

  it("counts a machine loop as one occasion, not hundreds of votes", () => {
    // The live log holds 784 `image` turn-overrides at ~15s intervals in one
    // afternoon: Drill's vision path pinning the duty on every call. Feeding that
    // in raw hands one machine loop 784 votes about how the router is doing.
    const collapsed = collapseBursts(burst(200, 0, 15));
    expect(collapsed.length).toBeLessThan(20);
    expect(collapsed.length).toBeGreaterThan(0);
  });

  it("keeps genuinely separate occasions", () => {
    // Two overrides an hour apart are two decisions, not one.
    const spaced = burst(5, 0, BURST_WINDOW_SECONDS * 2);
    expect(collapseBursts(spaced)).toHaveLength(5);
  });

  it("collapses per (category, shape, signal), never across them", () => {
    const mixed: Evidence[] = [
      { category: "level", shape: "image", signal: "manual-override", at: at("03:00:00") },
      { category: "flow", shape: "image", signal: "manual-override", at: at("03:00:01") },
      { category: "level", shape: "fix", signal: "manual-override", at: at("03:00:02") },
      { category: "level", shape: "image", signal: "escalation", at: at("03:00:03") }
    ];
    // All four are distinct dimensions of evidence and must all survive.
    expect(collapseBursts(mixed)).toHaveLength(4);
  });

  it("keeps evidence with an unusable timestamp rather than guessing", () => {
    // Dropping evidence is worse than over-counting one record.
    const out = collapseBursts([
      { category: "level", shape: "fix", signal: "manual-override", at: null },
      { category: "level", shape: "fix", signal: "manual-override", at: "not-a-date" }
    ]);
    expect(out).toHaveLength(2);
  });
});
