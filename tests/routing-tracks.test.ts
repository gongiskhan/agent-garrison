// The router's track record, derived from evidence rather than counted.
//
// The reason it is derived is that a counter can drift from the evidence it
// claims to summarise, and a system that is confident for reasons nobody can
// reconstruct is exactly what this run exists to end. So the tests care about
// three things: that each log line maps to the right signal about the right
// dimension, that a line written by one of the OTHER producers sharing the
// feedback queue is not read as a verdict, and that machine-generated noise
// cannot masquerade as a person correcting the router.
//
// Fixtures are built by the real writers, never hand-rolled. That is not style:
// this suite used to invent the verdict shape it wished existed and passed for
// months while the reader could not read a single real verdict.

import { describe, expect, it } from "vitest";
import path from "node:path";
import { pathToFileURL } from "node:url";
import {
  evidenceFromVerdict,
  evidenceFromDecision,
  collapseBursts,
  BURST_WINDOW_SECONDS,
  type Evidence
} from "@/lib/routing-tracks";
import { buildVerdictRecord, type DecisionVerdictInput } from "@/lib/decision-verdicts";

const at = (s: string) => `2026-08-09T${s}Z`;

// The gateway's writer for the OTHER records in the same queue, loaded the way
// every suite here loads a fitting's .mjs.
const GATEWAY_FEEDBACK_LIB = pathToFileURL(
  path.join(path.resolve(__dirname, ".."), "fittings/seed/http-gateway/scripts/lib/feedback-queue.mjs")
).href;

// Every verdict fixture is built by the PRODUCER and round-tripped through JSON,
// which is exactly how `readEvidence` receives it off the queue. The previous
// suite hand-rolled {verdict, resolved, at} records instead - a shape no producer
// has ever written - so it stayed green for months while every real verdict tap
// folded to zero evidence and the bands on the home Router panel could not move.
// Building fixtures through buildVerdictRecord is what stops the reader and the
// writer drifting apart again: change the record shape and these tests fail.
const queued = (input: Omit<DecisionVerdictInput, "decisionId">) =>
  JSON.parse(JSON.stringify(buildVerdictRecord({ ...input, decisionId: "dec-1" })!));

describe("evidence from a verdict", () => {
  it("folds a record the writer actually produces into real evidence", () => {
    // The regression this file exists to prevent. Assert the writer's field names
    // here too, so a rename shows up as a failing expectation rather than as a
    // silently empty band months later.
    const record = buildVerdictRecord({
      decisionId: "dec-1",
      verdict: "wrong",
      resolved: { duty: "fix" },
      correction: { flow: "feature" },
      at: at("10:00:00")
    })!;
    expect(record).toMatchObject({
      answer: "wrong",
      original: { duty: "fix" },
      applied: { flow: "feature" },
      timestamp: at("10:00:00"),
      provenance: "decision-verdict"
    });
    expect(evidenceFromVerdict(JSON.parse(JSON.stringify(record)))).toEqual([
      { category: "flow", shape: "fix", signal: "explicit-negative", at: at("10:00:00") }
    ]);
  });

  it("reads `right` as a confirmation about both dimensions", () => {
    const out = evidenceFromVerdict(queued({ verdict: "right", resolved: { duty: "fix" }, at: at("10:00:00") }));
    expect(out.map((e) => [e.category, e.signal])).toEqual([
      ["flow", "explicit-confirmation"],
      ["level", "explicit-confirmation"]
    ]);
    expect(out[0]).toMatchObject({ shape: "fix", at: at("10:00:00") });
  });

  it("takes the shape from the duty when the resolution names no flow", () => {
    // The Decisions panel fills the resolution from the decision row, which is
    // {target, model, effort, duty, tier} - it never sends a flow. Without the
    // duty fallback every real verdict lands in a single "unknown" bucket and
    // stops being evidence about anything in particular.
    expect(evidenceFromVerdict(queued({ verdict: "right", resolved: { duty: "review" } }))[0].shape).toBe(
      "review"
    );
    // A flow still wins when one is recorded, and the shape is always the one the
    // router CHOSE, never the counterfactual.
    const corrected = evidenceFromVerdict(
      queued({ verdict: "wrong", resolved: { flow: "fix", duty: "implement" }, correction: { flow: "feature" } })
    );
    expect(corrected[0].shape).toBe("fix");
  });

  it("attributes a correction ONLY to the dimensions it names", () => {
    // Being told the flow was wrong says nothing about whether the level was -
    // which is the whole reason the bands are per category.
    const out = evidenceFromVerdict(
      queued({ verdict: "wrong", resolved: { duty: "fix" }, correction: { flow: "feature" } })
    );
    expect(out).toHaveLength(1);
    expect(out[0]).toMatchObject({ category: "flow", signal: "explicit-negative" });

    const level = evidenceFromVerdict(
      queued({ verdict: "wrong", resolved: { duty: "fix" }, correction: { duty: "plan", tier: "2" } })
    );
    expect(level).toHaveLength(1);
    expect(level[0]).toMatchObject({ category: "level", signal: "explicit-negative" });
  });

  it("still counts a `wrong` that carries no correction", () => {
    // Being told it was wrong is information even without the answer; it is just
    // the weaker signal.
    const out = evidenceFromVerdict(queued({ verdict: "wrong", resolved: { duty: "fix" } }));
    expect(out).toHaveLength(2);
    for (const e of out) expect(e.signal).toBe("explicit-negative");
  });

  it("counts a correction these bands do not track against both dimensions", () => {
    // "The duty and the depth were fine, the model was wrong" names neither
    // category. The call was still wrong and the record does not say which half
    // of the routing caused it, so it counts the same as a bare "wrong".
    const out = evidenceFromVerdict(
      queued({ verdict: "wrong", resolved: { duty: "fix" }, correction: { model: "opus", effort: "high" } })
    );
    expect(out.map((e) => e.category)).toEqual(["flow", "level"]);
    for (const e of out) expect(e.signal).toBe("explicit-negative");
  });

  it("ignores `unsure` - 'I do not know' is not evidence", () => {
    expect(evidenceFromVerdict(queued({ verdict: "unsure", resolved: { duty: "fix" } }))).toEqual([]);
  });

  it("ignores the other producers that share the queue", async () => {
    // feedback-queue.jsonl is written by the gateway (conversational overrides)
    // and the Improver (probe + retrospective answers) as well as by the Decisions
    // panel. Their `answer` is operator prose, not this closed vocabulary, so
    // reading one as a verdict would train the router on a phrase match. The
    // override fixture comes from the gateway's own writer for the same
    // no-hand-rolled-fixtures reason as above.
    const { buildOverrideRecord } = await import(GATEWAY_FEEDBACK_LIB);
    const override = buildOverrideRecord({
      answer: "run the full pipeline",
      original: { flow: "fix", plan: "quick" },
      applied: { flow: "fix", plan: "full" },
      at: at("10:00:00")
    });
    expect(override.provenance).toBe("override");
    expect(evidenceFromVerdict(override)).toEqual([]);
    // A probe answer that happens to read like a verdict is still not one.
    expect(
      evidenceFromVerdict({
        area: "orchestrator",
        question: "was that the right call?",
        answer: "right",
        original: { duty: "fix" },
        timestamp: at("10:00:00"),
        provenance: "probe"
      })
    ).toEqual([]);
  });

  it("ignores junk", () => {
    for (const junk of [
      null,
      undefined,
      3,
      "x",
      {},
      { provenance: "decision-verdict" },
      { provenance: "decision-verdict", answer: "sideways" },
      // The fictional shape this reader used to expect. Nothing writes it, and
      // accepting it would be the bug wearing a compat branch.
      { verdict: "wrong", resolved: { flow: "fix" }, applied: { flow: "feature" }, at: at("10:00:00") }
    ]) {
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
