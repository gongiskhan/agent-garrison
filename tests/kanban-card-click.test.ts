// Item 5 — clicking a card's body opens its detail (the dedicated Open button is
// gone). shouldOpenCard must NOT open when (1) the click landed on an interactive
// control inside the card (its buttons / links / fields, whose clicks bubble to the
// card root), or (2) a drag just ended (its trailing synthesised click). Pure module.
import { describe, it, expect } from "vitest";
import { shouldOpenCard, INTERACTIVE_ANCESTORS } from "../fittings/seed/kanban-loop/ui/card-click";

// A minimal element-like stub: `closest(sel)` returns a truthy match when `sel`
// contains any of the element's declared interactive-ancestor tags.
function stubTarget(interactiveAncestor: string | null) {
  return {
    closest(selector: string) {
      if (!interactiveAncestor) return null;
      // selector is the comma list; match if it contains our ancestor tag.
      return selector.split(",").map((s) => s.trim()).includes(interactiveAncestor)
        ? { tag: interactiveAncestor }
        : null;
    }
  };
}

describe("shouldOpenCard — click the card body to open it", () => {
  it("opens on a plain click on the card body (no interactive ancestor, no drag)", () => {
    expect(shouldOpenCard(stubTarget(null), false)).toBe(true);
  });

  it("does NOT open when the click hit a button inside the card", () => {
    expect(shouldOpenCard(stubTarget("button"), false)).toBe(false);
  });

  it("does NOT open for clicks on any interactive control (a, input, select, …)", () => {
    for (const tag of INTERACTIVE_ANCESTORS.split(",").map((s) => s.trim())) {
      expect(shouldOpenCard(stubTarget(tag), false)).toBe(false);
    }
  });

  it("does NOT open when a drag just ended (its trailing synthetic click)", () => {
    // Even a bare-body click is suppressed while the drag-just-ended flag is up.
    expect(shouldOpenCard(stubTarget(null), true)).toBe(false);
  });

  it("does not throw on a null target and does not open", () => {
    expect(shouldOpenCard(null, false)).toBe(false);
  });

  it("opens for a target without .closest (non-element node)", () => {
    expect(shouldOpenCard({} as any, false)).toBe(true);
  });
});
