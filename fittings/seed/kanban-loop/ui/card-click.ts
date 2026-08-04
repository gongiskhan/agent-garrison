// ── Click-to-open a card (Item 5) ────────────────────────────────────────────
//
// Clicking a card's body opens its detail sheet — the dedicated Open button is gone.
// Two clicks must NOT open the card:
//   1. a click on one of the card's many interactive controls (its 15+ buttons, the
//      project/anchor links, form fields). Those have their own handlers and their
//      clicks bubble up to the card root, so we ignore any click whose target sits
//      under an interactive element.
//   2. the trailing click a completed pointer-drag (>=6px) synthesises on mouse-up.
//      Without this guard the detail sheet would pop after EVERY reorder. The App
//      raises a drag-just-ended flag on dragEnd/dragCancel (cleared on the next tick),
//      which we honour here. (A stationary click never activates a drag — the sensor's
//      activation distance is 6px — so plain click-to-open coexists with drag.)
//
// Pure + DOM-light so it unit-tests without React: it only needs `.closest()` on the
// click target (any Element, or an element-like stub in tests).

/** The interactive ancestors whose own click must NOT also open the card. */
export const INTERACTIVE_ANCESTORS = "button, a, input, textarea, select, summary, label";

interface ClosestTarget {
  closest(selector: string): unknown;
}

/**
 * True when a click on the card body should open the card's detail sheet.
 *
 * @param target        the click event's target (Element or stub with `.closest`)
 * @param dragJustEnded whether a drag ended on this tick (its trailing click)
 */
export function shouldOpenCard(target: EventTarget | ClosestTarget | null, dragJustEnded: boolean): boolean {
  if (dragJustEnded) return false;
  if (target == null) return false;
  if (typeof (target as ClosestTarget).closest !== "function") {
    // Non-element target (e.g. a raw text/`document` node in some environments):
    // nothing interactive to exclude, so a bare click on the card body opens it.
    return true;
  }
  return (target as ClosestTarget).closest(INTERACTIVE_ANCESTORS) == null;
}
