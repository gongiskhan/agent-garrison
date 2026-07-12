import { describe, it, expect } from "vitest";
import { shouldGuidedAdvance, initTour, advanceTour, isComplete } from "@/lib/tour-machine";
import type { QueryRoot } from "@/lib/tour-selector";
import type { TourStep } from "@/lib/metadata";

// D4 — the GUIDED player: spotlight the target, WAIT for the user, validate via
// the step's assert (polling the DOM/route), and only then advance. This tests
// the assert-gated advance decision without a live browser.

function fakeRoot(map: Record<string, Array<Record<string, unknown>>>): QueryRoot {
  return {
    querySelectorAll(selector: string) {
      return (map[selector] ?? []) as unknown as ArrayLike<Element>;
    }
  };
}

const el = (attrs: Record<string, string>) => ({
  tagName: "BUTTON",
  textContent: "",
  getAttribute: (n: string) => (n in attrs ? attrs[n] : null),
  hasAttribute: (n: string) => n in attrs,
  contains: () => false
});

describe("shouldGuidedAdvance", () => {
  it("does not advance an informational (assert-less) step — the user must press Continue", () => {
    const step: TourStep = { id: "intro", caption: "hi", selector: "raw-css:h1" };
    expect(shouldGuidedAdvance(step, {})).toBe(false);
  });

  it("advances only once a selector+state assert passes", () => {
    const step: TourStep = {
      id: "expand",
      caption: "expand the section",
      selector: "testid:sec",
      assert: { selector: "testid:sec", state: "expanded" }
    };
    const collapsed = fakeRoot({ '[data-testid="sec"]': [el({ "data-testid": "sec", "aria-expanded": "false" })] });
    const expanded = fakeRoot({ '[data-testid="sec"]': [el({ "data-testid": "sec", "aria-expanded": "true" })] });
    expect(shouldGuidedAdvance(step, { root: collapsed })).toBe(false);
    expect(shouldGuidedAdvance(step, { root: expanded })).toBe(true);
  });

  it("advances a url-gated step only after the route changes", () => {
    const step: TourStep = {
      id: "open",
      caption: "open a category",
      selector: "testid:card",
      assert: { url: "/quarters/" }
    };
    expect(shouldGuidedAdvance(step, { pathname: "/quarters" })).toBe(false);
    expect(shouldGuidedAdvance(step, { pathname: "/quarters/skills" })).toBe(true);
  });
});

describe("guided advance loop", () => {
  it("only advances when the current step's assert passes, reaching completion", () => {
    const steps: TourStep[] = [
      { id: "s1", caption: "expand", selector: "testid:sec", assert: { selector: "testid:sec", state: "expanded" } },
      { id: "s2", caption: "done", selector: "testid:card" }
    ];
    let state = initTour(steps.length);

    // Simulate polling: the section starts collapsed → no advance.
    let expanded = false;
    const root = () =>
      fakeRoot({
        '[data-testid="sec"]': [el({ "data-testid": "sec", "aria-expanded": expanded ? "true" : "false" })]
      });

    // A few poll ticks with the section still collapsed: stays on step 0.
    for (let i = 0; i < 3; i += 1) {
      if (shouldGuidedAdvance(steps[state.index], { root: root() })) state = advanceTour(state);
    }
    expect(state.index).toBe(0);

    // User expands the section → next poll advances to the final step.
    expanded = true;
    if (shouldGuidedAdvance(steps[state.index], { root: root() })) state = advanceTour(state);
    expect(state.index).toBe(1);
    // The final step is informational (no assert) — the loop never auto-completes;
    // the user presses Done (a manual advance).
    expect(shouldGuidedAdvance(steps[state.index], { root: root() })).toBe(false);
    state = advanceTour(state);
    expect(isComplete(state)).toBe(true);
  });
});
