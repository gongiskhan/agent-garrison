// ── Press-and-hold drag activation ───────────────────────────────────────────
//
// Cards and columns have NO separate grab handle: you press anywhere on one, hold
// still for DRAG_HOLD_MS, and it enters drag mode. A plain click is still a plain
// click, and moving further than the tolerance before the hold elapses cancels the
// pending drag and lets the gesture through as a click or a scroll.
//
// Two rules follow from "anywhere", and both were learned the hard way:
//
//  1. Nothing inside a card may swallow the press. A control that stops the
//     activator's event (a button calling stopPropagation on the press) makes the
//     hold silently do nothing on that part of the surface - which, for the card
//     title, is the most natural place to grab a card. Buttons keep their click:
//     dnd-kit suppresses the trailing click only once a hold actually activated.
//
//  2. Text entry is the one exception. Inside an input, a long press means "place
//     the cursor / select", never "drag". Those controls are exempt here rather
//     than by stopping propagation at each one, so the rule lives in one place and
//     does not depend on which DOM event the active sensor happens to listen to.

/**
 * How long the pointer must stay down before a card or column starts dragging.
 *
 * One second, not two. The timer does start at the press - measured, the card
 * enters drag mode ~90ms after the delay elapses - but a dwell with no feedback
 * reads as far longer than it is, and two seconds felt like three. A second is
 * still five times an ordinary click, so it keeps the gesture deliberate.
 */
export const DRAG_HOLD_MS = 1000;

/**
 * How far the pointer may drift during the hold before the drag is abandoned.
 * A mouse rests still, so it can be tight; a finger resting on glass wanders,
 * and a too-tight touch tolerance cancels holds the user meant.
 */
export const DRAG_HOLD_TOLERANCE_MOUSE = 8;
export const DRAG_HOLD_TOLERANCE_TOUCH = 16;

/** Controls where a long press already means something else, so it must not drag. */
export const DRAG_EXEMPT_ANCESTORS = "input, textarea, select, .card-title-editor";

interface ClosestTarget {
  closest(selector: string): unknown;
}

/**
 * True when a press on this target may begin a press-and-hold drag.
 *
 * @param target the press event's target (Element, or a stub with `.closest`)
 */
export function shouldActivateDrag(target: EventTarget | ClosestTarget | null): boolean {
  if (target == null) return false;
  if (typeof (target as ClosestTarget).closest !== "function") {
    // Non-element target (e.g. a raw text node): nothing to exempt.
    return true;
  }
  return (target as ClosestTarget).closest(DRAG_EXEMPT_ANCESTORS) == null;
}
