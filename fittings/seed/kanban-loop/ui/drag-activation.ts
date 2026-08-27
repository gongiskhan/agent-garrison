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
 * TWO activation models, one per input, because a finger and a mouse conflict
 * with the board differently:
 *
 *  - TOUCH is a long-press (DRAG_HOLD_MS + DRAG_HOLD_TOLERANCE_TOUCH). The board
 *    and its lists scroll under a finger, so a touch can only mean "drag" once it
 *    has stayed still past the hold; move past the tolerance first and the gesture
 *    belongs to the scroller. This is the Trello model.
 *  - MOUSE is distance-based (DRAG_MOUSE_DISTANCE). A desktop has no scroll/drag
 *    ambiguity — the wheel scrolls, a press-and-move drags — so the drag should
 *    start the instant the pointer travels far enough, with no artificial dwell.
 *    Distance (not a short delay) is also what keeps click-to-open robust: a
 *    stationary press of ANY duration stays a click, where a shortened mouse delay
 *    would turn a slow click into a zero-distance drag that swallows the open.
 */

/**
 * How long a finger must stay down (within DRAG_HOLD_TOLERANCE_TOUCH) before a
 * card or column lifts into a drag.
 *
 * ~250ms — the usual long-press number, several times a tap yet short enough to
 * read as deliberate rather than broken. The 1s and 2s it replaced dwelt so long
 * the hold felt stuck; the visible lift (shadow + scale) now confirms it the
 * moment it fires, so a longer dwell buys nothing.
 */
export const DRAG_HOLD_MS = 250;

/**
 * How far a finger may drift during the hold before the drag is abandoned to the
 * scroller. A finger resting on glass wanders, so this is generous; a scroll
 * flick crosses it well inside the hold and escapes as a scroll.
 */
export const DRAG_HOLD_TOLERANCE_TOUCH = 16;

/**
 * How far the mouse must travel (while pressed) before a card or column starts
 * dragging on desktop. Below this it is a click (which opens the card); at or
 * beyond it, an immediate drag.
 */
export const DRAG_MOUSE_DISTANCE = 8;

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
