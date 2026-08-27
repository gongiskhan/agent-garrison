import { describe, expect, it } from "vitest";
import {
  PROJECT_OWNED_BY_CARD,
  RUN_SPEC_FIELDS,
  applyPinPatch,
  pinnedSummary,
  railOptionsFor,
} from "../fittings/seed/kanban-loop/ui/run-spec";
import type { RouteOptionsView } from "../fittings/seed/kanban-loop/ui/api";
// @ts-expect-error — plain .mjs fitting module, no types
import { CARD_ROUTING_FIELDS } from "../fittings/seed/kanban-loop/lib/board.mjs";

const options: RouteOptionsView = {
  targets: [{ id: "opus", runtime: "claude-code", model: "claude-opus-5" }],
  duties: [{ id: "implement", title: "Implement", levels: [{ n: 1 }, { n: 2 }] }],
  efforts: ["low", "medium", "high"],
  accounts: [{ name: "max", platform: "anthropic" }],
  tiers: ["T0-trivial", "T1-standard"],
  flows: [{ id: "full-feature", phases: ["plan", "implement", "review"] }],
  defaultFlow: "full-feature",
  projects: ["garrison", "ekoa-code"],
  phaseCatalog: ["plan", "implement", "review", "security-review"],
  tierDefinitions: { "T0-trivial": "a one-line fix" },
  sources: { gateway: true },
};

describe("applyPinPatch", () => {
  it("sets a pin and leaves every other dimension untouched", () => {
    expect(applyPinPatch({ tier: "T1-standard" }, { target: "opus" })).toEqual({
      tier: "T1-standard",
      target: "opus",
    });
  });

  it("treats null as CLEAR, never as the value null", () => {
    const out = applyPinPatch({ tier: "T1-standard", effort: "high" }, { effort: null });
    expect(out).toEqual({ tier: "T1-standard" });
    expect("effort" in out).toBe(false);
  });

  it("treats a blank string as clear too — the server drops blanks, so storing one would not round-trip", () => {
    expect(applyPinPatch({ model: "gpt-5" }, { model: "   " })).toEqual({});
  });

  it("ignores a dimension the patch does not mention", () => {
    expect(applyPinPatch({ duty: "implement", level: 2 }, { tier: "T0-trivial" })).toEqual({
      duty: "implement",
      level: 2,
      tier: "T0-trivial",
    });
  });

  it("keeps a level only inside 1..9 and only alongside a duty", () => {
    expect(applyPinPatch({ duty: "implement" }, { level: 3 })).toEqual({ duty: "implement", level: 3 });
    expect(applyPinPatch({ duty: "implement" }, { level: 0 })).toEqual({ duty: "implement" });
    expect(applyPinPatch({ duty: "implement" }, { level: 12 })).toEqual({ duty: "implement" });
    // Releasing the duty must not leave the orphan level behind.
    expect(applyPinPatch({ duty: "implement", level: 2 }, { duty: null })).toEqual({});
  });

  it("carries the console's mutual-exclusivity patch through intact (a flow releases a duty)", () => {
    const before = { duty: "implement", level: 2, phasesOff: "review" };
    expect(
      applyPinPatch(before, { flow: "full-feature", duty: null, level: null, phasesOff: null, phasesOn: null })
    ).toEqual({ flow: "full-feature" });
  });

  it("accepts phasesOn — the field the server has always taken and the old form could not send", () => {
    expect(applyPinPatch({ flow: "ui-change" }, { phasesOn: "security-review" })).toEqual({
      flow: "ui-change",
      phasesOn: "security-review",
    });
  });

  it("drops a field outside the whitelist rather than storing one the server would silently discard", () => {
    const out = applyPinPatch({}, { nonsense: "x" } as never);
    expect(out).toEqual({});
  });

  it("never mutates the spec it was given", () => {
    const before = { tier: "T1-standard" };
    applyPinPatch(before, { tier: null, target: "opus" });
    expect(before).toEqual({ tier: "T1-standard" });
  });

  it("edits exactly the dimensions the SERVER accepts — no more, no less", () => {
    expect([...RUN_SPEC_FIELDS].sort()).toEqual([...CARD_ROUTING_FIELDS].sort());
  });
});

describe("pinnedSummary", () => {
  it("says nothing when everything is automatic", () => {
    expect(pinnedSummary({})).toEqual([]);
    expect(pinnedSummary(null)).toEqual([]);
  });

  it("folds level into the duty chip", () => {
    expect(pinnedSummary({ duty: "implement", level: 2 })).toEqual([
      { field: "duty", label: "implement L2" },
    ]);
  });

  it("counts the phase pins rather than listing them", () => {
    expect(pinnedSummary({ phasesOff: "review,walkthrough", phasesOn: "security-review" })).toEqual([
      { field: "phasesOff", label: "−2 phases" },
      { field: "phasesOn", label: "+1 phase" },
    ]);
  });

  it("reports every dimension in force, in dimension order", () => {
    const pins = pinnedSummary({ effort: "high", target: "opus", tier: "T0-trivial", flow: "ui-change" });
    expect(pins.map((p) => p.field)).toEqual(["tier", "target", "effort", "flow"]);
  });
});

describe("railOptionsFor", () => {
  it("hands the console the gateway's whole vocabulary, including the two fields the old form had nowhere to put", () => {
    const rail = railOptionsFor(options, null);
    expect(rail.phaseCatalog).toEqual(["plan", "implement", "review", "security-review"]);
    expect(rail.tierDefinitions).toEqual({ "T0-trivial": "a one-line fix" });
    expect(rail.defaultFlow).toBe("full-feature");
    expect(rail.targets).toHaveLength(1);
  });

  it("always reports project as spoken for — the card's own Project field decides, and routing.project would silently win", () => {
    expect(railOptionsFor(options, null).unavailable?.project).toBe(PROJECT_OWNED_BY_CARD);
    expect(railOptionsFor(options, null).projects).toEqual([]);
  });

  it("gives every other dimension a REASON when the operative is down, not an empty menu", () => {
    const rail = railOptionsFor({ ...options, sources: { gateway: false } }, null);
    for (const field of RUN_SPEC_FIELDS) {
      expect(rail.unavailable?.[field], field).toBeTruthy();
    }
    expect(rail.unavailable?.target).toMatch(/gateway is not running/);
    expect(rail.unavailable?.project).toBe(PROJECT_OWNED_BY_CARD);
  });

  it("reports the fetch error when there are no options at all", () => {
    expect(railOptionsFor(null, "boom").unavailable?.effort).toMatch(/gateway is not running/);
  });

  it("names the error when the options loaded but the fetch failed", () => {
    const rail = railOptionsFor(options, "HTTP 500");
    expect(rail.unavailable?.effort).toMatch(/HTTP 500/);
  });
});
