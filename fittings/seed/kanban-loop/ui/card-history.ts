// ── Card overlays and the browser's Back ─────────────────────────────────────
//
// Opening a card used to be pure React state: no history entry, no URL change.
// On the phone that meant the shell's Back control (and a swipe) had nothing
// of ours to pop, so it left the board entirely - a card opened from
// Conversations went back to Conversations, never to the board it sits on.
//
// Now every card overlay is an entry in the session history. The board runs in
// an iframe, and a frame's pushState joins the top window's history, so the
// shell's Back pops OUR entry first: the card closes and the board is what is
// left. A card reached by deep link gets a board entry put UNDER it for the
// same reason - Back lands on the board, not on wherever the link was tapped.
//
// This module is the pure part: given the overlay React wants shown and what
// the history currently holds, it says which history operations make the two
// agree. DOM-free so it unit-tests without a browser; main.tsx applies the
// steps and listens for popstate.

import { cardIdFromLocation } from "./card-location";

export type CardOverlayKind = "detail" | "conversation";

export interface CardOverlay {
  kind: CardOverlayKind;
  cardId: string;
}

/** What we stamp on a history entry we own. `depth` counts how many of our
 *  entries sit on top of the board entry, so closing the card (the X, Escape,
 *  the backdrop) can go back past ALL of them in one move. */
export interface CardHistoryState {
  garrisonKanban: CardOverlay & { depth: number };
}

interface LocationLike {
  pathname: string;
  search: string;
  hash: string;
}

export type HistoryStep =
  | { op: "push"; state: CardHistoryState; url: string }
  | { op: "replace"; state: CardHistoryState | null; url: string }
  | { op: "back"; depth: number };

export function isCardHistoryState(state: unknown): state is CardHistoryState {
  if (!state || typeof state !== "object") return false;
  const inner = (state as { garrisonKanban?: unknown }).garrisonKanban;
  if (!inner || typeof inner !== "object") return false;
  const { kind, cardId, depth } = inner as Record<string, unknown>;
  return (kind === "detail" || kind === "conversation") && typeof cardId === "string" && cardId !== "" &&
    typeof depth === "number" && depth >= 1;
}

/** The board's own URL: no card pin, no `#/cards/<id>` hash. */
export function boardUrl(location: LocationLike): string {
  const params = new URLSearchParams(location.search || "");
  params.delete("card");
  const query = params.toString();
  return `${location.pathname}${query ? `?${query}` : ""}`;
}

/** The URL for a card: the board's own `?card=<id>` shape, whatever shape the
 *  link that opened it used. */
export function cardUrl(location: LocationLike, cardId: string): string {
  const params = new URLSearchParams(location.search || "");
  params.set("card", cardId);
  return `${location.pathname}?${params.toString()}`;
}

function stateFor(overlay: CardOverlay, depth: number): CardHistoryState {
  return { garrisonKanban: { kind: overlay.kind, cardId: overlay.cardId, depth } };
}

/**
 * The history operations that make the session history agree with `overlay`.
 *
 * @param overlay         the card overlay React is showing, or null for none
 *                        (the board, or a non-card sheet such as Watch)
 * @param state           `window.history.state` right now
 * @param location        `window.location` right now
 * @param mountedWithCard true on the FIRST call after a mount whose URL already
 *                        named a card - the deep-link case, where the entry we
 *                        are standing on belongs to whoever linked here
 */
export function cardHistoryPlan({
  overlay,
  state,
  location,
  mountedWithCard,
}: {
  overlay: CardOverlay | null;
  state: unknown;
  location: LocationLike;
  mountedWithCard: boolean;
}): HistoryStep[] {
  const ours = isCardHistoryState(state) ? state.garrisonKanban : null;
  const urlCard = cardIdFromLocation(location);

  if (!overlay) {
    // Leaving the card: pop every entry of ours in one move, so Back never
    // has to be pressed once per sheet the card opened along the way.
    if (ours) return [{ op: "back", depth: ours.depth }];
    // A card in the URL that nothing of ours put there (a hash link the
    // board never opened, an older entry): strip it so re-clicking the same
    // link changes the URL again.
    if (urlCard) return [{ op: "replace", state: null, url: boardUrl(location) }];
    return [];
  }

  if (ours) {
    // Already on this entry (a popstate restored it, or a re-render).
    if (ours.kind === overlay.kind && ours.cardId === overlay.cardId) return [];
    // A card leading to another card, or the conversation sheet opening the
    // full card: one more entry on top, so Back retraces the path.
    return [{ op: "push", state: stateFor(overlay, ours.depth + 1), url: cardUrl(location, overlay.cardId) }];
  }

  if (urlCard === overlay.cardId) {
    if (mountedWithCard) {
      // Deep link: the entry under our feet is the link's, and the board has
      // no entry at all. Turn this entry INTO the board and put the card on
      // top, so Back is the board.
      return [
        { op: "replace", state: null, url: boardUrl(location) },
        { op: "push", state: stateFor(overlay, 1), url: cardUrl(location, overlay.cardId) },
      ];
    }
    // A hash link opened while the board was up: the browser already pushed
    // this entry over the board's. Claim it (and normalise its URL shape).
    return [{ op: "replace", state: stateFor(overlay, 1), url: cardUrl(location, overlay.cardId) }];
  }

  // Opened from the board itself: a click, a search hit, the history view.
  return [{ op: "push", state: stateFor(overlay, 1), url: cardUrl(location, overlay.cardId) }];
}

/** The card overlay a history entry stands for: ours by its state, a link's by
 *  its URL, or none. What popstate hands back to React. */
export function overlayFromHistory(location: LocationLike, state: unknown): CardOverlay | null {
  if (isCardHistoryState(state)) {
    const { kind, cardId } = state.garrisonKanban;
    return { kind, cardId };
  }
  const cardId = cardIdFromLocation(location);
  return cardId ? { kind: "detail", cardId } : null;
}
