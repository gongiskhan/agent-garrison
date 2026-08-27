// RoutingModal pure model — the section-building helpers the dialog renders
// from. The React component is presentation; these are the semantics.
import { describe, expect, it } from "vitest";
import {
  blockedSection,
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

// A HOST may own a dimension outright (the Kanban board decides a card's working
// directory through the card's own Project field, and `cardTurnRouting` lets
// routing.project WIN over it — so a second picker here would not be a duplicate,
// it would be an override the user never saw). `unavailable` is how a host says so.
describe("blockedSection", () => {
  it("is open when nothing is unavailable", () => {
    for (const id of ["work", "tier", "execution", "account", "project", "flow", "phases"] as const) {
      expect(blockedSection(options, id), id).toBe("");
    }
    expect(blockedSection(null, "project")).toBe("");
  });

  it("blocks a section whose every field carries a reason", () => {
    const owned = { ...options, unavailable: { project: "the card decides" } };
    expect(blockedSection(owned, "project")).toBe("the card decides");
    expect(blockedSection(owned, "work")).toBe("");
  });

  it("leaves a PARTLY blocked section open — effort alone keeps its own inline gate", () => {
    const effortOnly = { ...options, unavailable: { effort: "this provider has no effort control" } };
    expect(blockedSection(effortOnly, "execution")).toBe("");
  });

  it("blocks execution only when target, model AND effort are all spoken for", () => {
    const down = { ...options, unavailable: { target: "down", model: "down", effort: "down" } };
    expect(blockedSection(down, "execution")).toBe("down");
  });

  it("needs BOTH phase pins blocked before the phases section closes", () => {
    expect(blockedSection({ ...options, unavailable: { phasesOff: "down" } }, "phases")).toBe("");
    expect(blockedSection({ ...options, unavailable: { phasesOff: "down", phasesOn: "down" } }, "phases")).toBe("down");
  });
});
