// Press-and-hold drag: a card or a column enters drag mode from a hold ANYWHERE
// on its surface. Two live defects motivated these tests, and both were invisible
// to every existing check because they lived in event plumbing, not in logic:
//
//  1. The card title button called stopPropagation on the press, so the hold did
//     nothing across the top quarter of every card - the most natural place to
//     grab one. Guarded here by asserting the press is NOT swallowed there.
//  2. Sensor choice. On touch, `pointerdown` beats `touchstart`, so a PointerSensor
//     wins the gesture and then loses it: the lists scroll, so the first finger
//     movement made the browser claim the gesture and fire `pointercancel`. The
//     hold worked and the drag died instantly. MouseSensor + TouchSensor is the
//     pairing that survives, so the sensor choice is pinned here.
import { describe, it, expect } from "vitest";
import { readFileSync } from "node:fs";
import {
  DRAG_EXEMPT_ANCESTORS,
  DRAG_HOLD_MS,
  DRAG_HOLD_TOLERANCE_MOUSE,
  DRAG_HOLD_TOLERANCE_TOUCH,
  shouldActivateDrag
} from "../fittings/seed/kanban-loop/ui/drag-activation";

const source = readFileSync(
  new URL("../fittings/seed/kanban-loop/ui/main.tsx", import.meta.url),
  "utf8"
);

/** Element-like stub: `closest(sel)` matches when `sel` lists our ancestor. */
function stubTarget(ancestor: string | null) {
  return {
    closest(selector: string) {
      if (!ancestor) return null;
      return selector.split(",").map((s) => s.trim()).includes(ancestor) ? { tag: ancestor } : null;
    }
  };
}

describe("shouldActivateDrag - hold anywhere, except text entry", () => {
  it("activates on a bare card surface", () => {
    expect(shouldActivateDrag(stubTarget(null))).toBe(true);
  });

  it("activates on the card's own buttons - a hold is not a click", () => {
    // The card's 15+ controls keep their click; the hold rides underneath, and
    // dnd-kit swallows the trailing click only once a drag actually activated.
    expect(shouldActivateDrag(stubTarget("button"))).toBe(true);
    expect(shouldActivateDrag(stubTarget("a"))).toBe(true);
    expect(shouldActivateDrag(stubTarget("summary"))).toBe(true);
  });

  it("does NOT activate inside text entry, where a long press means something else", () => {
    for (const sel of DRAG_EXEMPT_ANCESTORS.split(",").map((s) => s.trim())) {
      expect(shouldActivateDrag(stubTarget(sel))).toBe(false);
    }
  });

  it("does not activate on a null target and does not throw", () => {
    expect(shouldActivateDrag(null)).toBe(false);
  });

  it("activates for a target without .closest (non-element node)", () => {
    expect(shouldActivateDrag({} as never)).toBe(true);
  });

  it("exempts the inline title editor as a whole, not just its input", () => {
    expect(DRAG_EXEMPT_ANCESTORS).toContain(".card-title-editor");
    expect(shouldActivateDrag(stubTarget(".card-title-editor"))).toBe(false);
  });
});

describe("hold timing", () => {
  it("is a two-second hold", () => {
    expect(DRAG_HOLD_MS).toBe(2000);
  });

  it("gives a finger more drift than a mouse", () => {
    // A finger resting on glass wanders; too tight a touch tolerance cancels
    // holds the user meant to make.
    expect(DRAG_HOLD_TOLERANCE_TOUCH).toBeGreaterThan(DRAG_HOLD_TOLERANCE_MOUSE);
  });
});

describe("the board's sensor wiring", () => {
  it("uses MouseSensor + TouchSensor, never PointerSensor", () => {
    expect(source).toContain("useSensor(MouseSensor");
    expect(source).toContain("useSensor(TouchSensor");
    // (the name still appears in the comment explaining why it is not used)
    expect(source).not.toContain("useSensor(PointerSensor");
    const imports = source.slice(source.indexOf('from "@dnd-kit/core"') - 800, source.indexOf('from "@dnd-kit/core"'));
    expect(imports).not.toContain("PointerSensor");
  });

  it("applies the shared hold constants to both sensors", () => {
    for (const sensor of ["MouseSensor", "TouchSensor"]) {
      const at = source.indexOf(`useSensor(${sensor}`);
      expect(at, `${sensor} is registered`).toBeGreaterThan(-1);
      expect(source.slice(at, at + 200)).toContain("delay: DRAG_HOLD_MS");
    }
  });
});

describe("nothing swallows the press", () => {
  it("the card title button does not stopPropagation on the press", () => {
    const at = source.indexOf('className="title card-title-edit"');
    expect(at).toBeGreaterThan(-1);
    const opening = source.slice(at, at + 1_400);
    expect(opening).not.toContain("onPointerDown={(e) => e.stopPropagation()}");
    expect(opening).not.toContain("onMouseDown={(e) => e.stopPropagation()}");
    // The keyboard guard is unrelated and must stay.
    expect(opening).toContain("onKeyDown={(e) => e.stopPropagation()}");
  });

  it("the inline title editor is exempted by selector, not by stopping the press", () => {
    const at = source.indexOf('className="card-title-editor"');
    expect(at).toBeGreaterThan(-1);
    const opening = source.slice(at, at + 900);
    expect(opening).not.toContain("onPointerDown={(e) => e.stopPropagation()}");
    expect(opening).not.toContain("onMouseDown={(e) => e.stopPropagation()}");
  });
});

describe("a column drags from anywhere on it", () => {
  it("puts the activators on the section, not only the header handle", () => {
    const at = source.indexOf("function SortableColumn(");
    expect(at).toBeGreaterThan(-1);
    const body = source.slice(at, at + 1_600);
    // The <section> carries the (gated) activators …
    expect(body).toMatch(/<section[\s\S]*?\{\.\.\.holdActivators\}/);
    // … and the header keeps only the accessible handle attributes.
    expect(body).toContain('<div className="col-drag-handle" {...attributes}>');
    expect(body).not.toContain('className="col-drag-handle" {...attributes} {...listeners}');
  });

  it("routes both card and column activators through the same gate", () => {
    expect(source).toContain("function useHoldActivators(");
    const card = source.indexOf("function SortableCardWrap(");
    expect(source.slice(card, card + 900)).toContain("{...holdActivators}");
  });
});
