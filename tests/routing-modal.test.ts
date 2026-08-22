// RoutingModal pure model — the section-building helpers the dialog renders
// from. The React component is presentation; these are the semantics.
import { describe, expect, it } from "vitest";
import {
  joinPhasesOn,
  resolvedPlanForPins,
  runtimeGroups,
} from "../packages/claude-chat/src/RoutingModal";
import type { RailOptions } from "../packages/claude-chat/src/AttributionRail";

const options: RailOptions = {
  targets: [
    { id: "cc-haiku-low", runtime: "agent-sdk", model: "haiku", effort: "low" },
    { id: "fable", runtime: "agent-sdk", model: "claude-opus-5" },
    { id: "sec-codex", runtime: "codex", model: "gpt-5-codex" },
    { id: "csg-work", runtime: "remote-shell", model: "csg" },
  ],
  flows: [
    { id: "fix", description: "Fix a defect", phases: ["implement", "test"] },
    { id: "full-feature", phases: ["plan", "implement", "review", "test"] },
  ],
  defaultFlow: "fix",
  phaseCatalog: ["plan", "implement", "review", "test", "security-review", "walkthrough"],
};

describe("runtimeGroups", () => {
  it("groups targets by runtime, insertion-ordered", () => {
    const groups = runtimeGroups(options);
    expect([...groups.keys()]).toEqual(["agent-sdk", "codex", "remote-shell"]);
    expect(groups.get("agent-sdk")!.map((t) => t.id)).toEqual(["cc-haiku-low", "fable"]);
    expect(groups.get("remote-shell")!.map((t) => t.id)).toEqual(["csg-work"]);
  });
});

describe("resolvedPlanForPins", () => {
  it("uses the pinned flow's plan and says it was pinned", () => {
    const plan = resolvedPlanForPins(options, { flow: "full-feature" });
    expect(plan).toEqual({
      flowId: "full-feature",
      phases: ["plan", "implement", "review", "test"],
      pinned: true,
    });
  });
  it("falls back to the default flow when nothing is pinned", () => {
    const plan = resolvedPlanForPins(options, null);
    expect(plan).toEqual({ flowId: "fix", phases: ["implement", "test"], pinned: false });
  });
  it("returns null when there is no usable plan", () => {
    expect(resolvedPlanForPins({ ...options, defaultFlow: null }, null)).toBeNull();
    expect(resolvedPlanForPins(options, { flow: "retired-flow" })).toBeNull();
  });
});

describe("joinPhasesOn", () => {
  it("orders by the catalog, keeps unknown ids, null when empty", () => {
    const catalog = options.phaseCatalog!;
    expect(joinPhasesOn(["walkthrough", "security-review"], catalog)).toBe("security-review,walkthrough");
    expect(joinPhasesOn(["mystery", "walkthrough"], catalog)).toBe("walkthrough,mystery");
    expect(joinPhasesOn([], catalog)).toBeNull();
  });
});
