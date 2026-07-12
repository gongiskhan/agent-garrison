import { describe, it, expect } from "vitest";
import { planDemoStep, runDemoSequence } from "@/lib/tour-machine";
import type { TourStep } from "@/lib/metadata";

// D3 — the DEMO player: the engine auto-advances and performs each step's
// action. runDemoSequence is the clock-free core of that loop, so this exercises
// the step-advance state machine AND the action dispatch without a DOM.

const steps: TourStep[] = [
  { id: "intro", caption: "welcome", selector: "raw-css:h1", spotlight: true },
  {
    id: "search",
    caption: "type here",
    selector: "raw-css:input",
    action: { type: "fill", value: "orchestrator" },
    spotlight: true
  },
  {
    id: "open",
    caption: "click it",
    selector: "button:Go",
    action: { type: "click" },
    spotlight: true
  }
];

describe("planDemoStep", () => {
  it("reports whether a step drives an action", () => {
    expect(planDemoStep(steps[0])).toEqual({ acts: false });
    expect(planDemoStep(steps[1])).toMatchObject({ acts: true, actionType: "fill" });
    expect(planDemoStep(steps[2])).toMatchObject({ acts: true, actionType: "click" });
  });

  it("surfaces the navigate path", () => {
    const nav: TourStep = { id: "n", caption: "go", selector: "raw-css:body", action: { type: "navigate", path: "/compose" } };
    expect(planDemoStep(nav)).toEqual({ acts: true, actionType: "navigate", navigatePath: "/compose" });
  });
});

describe("runDemoSequence", () => {
  it("visits every step in order and performs each action on its resolved element", () => {
    const resolved: string[] = [];
    const performedOn: string[] = [];
    const result = runDemoSequence(steps, {
      resolve: (selector) => {
        resolved.push(selector);
        return { selector }; // a non-null fake element
      },
      perform: (element) => {
        performedOn.push((element as { selector: string }).selector);
      }
    });

    // Advanced through all three steps to completion.
    expect(result.visited).toEqual(["intro", "search", "open"]);
    // Only the two action steps dispatched, in order.
    expect(result.performed).toEqual([
      { stepId: "search", type: "fill" },
      { stepId: "open", type: "click" }
    ]);
    // The action steps' targets were resolved before performing.
    expect(performedOn).toEqual(["raw-css:input", "button:Go"]);
  });

  it("routes a navigate action through the navigator, not the element performer", () => {
    const navigatedTo: string[] = [];
    const performed: string[] = [];
    const withNav: TourStep[] = [
      { id: "a", caption: "a", selector: "raw-css:h1" },
      { id: "b", caption: "b", selector: "raw-css:body", action: { type: "navigate", path: "/quarters" } }
    ];
    const result = runDemoSequence(withNav, {
      resolve: () => ({}),
      perform: (_el, action) => performed.push(action.type),
      navigate: (path) => navigatedTo.push(path)
    });
    expect(navigatedTo).toEqual(["/quarters"]);
    expect(performed).toEqual([]); // navigate never calls perform
    expect(result.visited).toEqual(["a", "b"]);
  });

  it("skips an action whose element cannot be resolved", () => {
    const single: TourStep[] = [
      { id: "x", caption: "x", selector: "raw-css:.missing", action: { type: "click" } }
    ];
    const result = runDemoSequence(single, { resolve: () => null, perform: () => { throw new Error("should not perform"); } });
    expect(result.performed).toEqual([]);
    expect(result.visited).toEqual(["x"]);
  });
});
