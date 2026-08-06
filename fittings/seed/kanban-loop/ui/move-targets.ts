// ── Move-sheet targets (Item 2) ──────────────────────────────────────────────
//
// The Move button is the MANUAL gate: it lets a human move a card ANYWHERE. So its
// targets are EVERY list except the card's current one — not the list's `validNext`.
// (Advance is the OTHER control and keeps its next-list-only semantics: it walks the
// card's rail / validNext. The two are deliberately different — "move manually" vs
// "advance one step".)
//
// Agent-kind lists are FLAGGED, never hidden. An immediate autonomous list starts
// a run, as does clarity-gated Discuss; scheduler/manual entries do not. The sheet
// describes that exact server behavior rather than treating every agent list alike.
//
// Pure + dependency-free so it unit-tests without booting the board or React.

export interface MoveTarget {
  id: string;
  title: string;
  /** The list's kind ("manual" | "agent" | …). */
  kind: string;
  /** True when this is an autonomous agent-owned list. */
  isAgent: boolean;
  /** True only when a manual move to this list dispatches immediately. */
  startsRun: boolean;
}

interface ListLike {
  id: string;
  title?: string | null;
  kind?: string | null;
  trigger?: string | null;
  interactive?: boolean | null;
}

/** Imports are content transfer only; they must never target a run-owning list. */
export function isManualImportTarget(list: ListLike): boolean {
  const kind = typeof list?.kind === "string" && list.kind ? list.kind : "manual";
  return list?.id !== "scheduled" && kind !== "agent" && kind !== "agent-interactive" && list?.interactive !== true;
}

interface BoardLike {
  lists?: ListLike[];
}
interface CardLike {
  list: string;
  clarity?: string | null;
}

/**
 * All lists a card can be MOVED to by hand: every list on the board except the one
 * it currently sits in, preserving board order. Agent-kind targets are flagged so the
 * UI can warn that dropping there starts a run.
 */
export function deriveMoveTargets(board: BoardLike, card: CardLike): MoveTarget[] {
  const lists = Array.isArray(board?.lists) ? board.lists : [];
  const currentList = card?.list ?? null;
  const out: MoveTarget[] = [];
  for (const l of lists) {
    if (!l || typeof l.id !== "string" || !l.id) continue;
    // Scheduled is managed by the schedule editor: a raw manual move would
    // create a card with no due instant or release target.
    if (l.id === "scheduled") continue;
    if (l.id === currentList) continue;
    const kind = typeof l.kind === "string" && l.kind ? l.kind : "manual";
    const interactive = kind === "agent-interactive" || l.interactive === true;
    const isAgent = kind === "agent" || kind === "agent-interactive";
    out.push({
      id: l.id,
      title: typeof l.title === "string" && l.title ? l.title : l.id,
      kind,
      isAgent,
      // Scheduler-beat/batch agent lists do not dispatch merely because a card
      // was moved there. Gated Discuss is the deliberate interactive exception.
      startsRun: isAgent && (
        (!interactive && l.trigger === "immediate")
        || (interactive && card.clarity === "needs-discuss")
      )
    });
  }
  return out;
}
