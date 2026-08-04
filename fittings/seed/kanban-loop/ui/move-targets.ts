// ── Move-sheet targets (Item 2) ──────────────────────────────────────────────
//
// The Move button is the MANUAL gate: it lets a human move a card ANYWHERE. So its
// targets are EVERY list except the card's current one — not the list's `validNext`.
// (Advance is the OTHER control and keeps its next-list-only semantics: it walks the
// card's rail / validNext. The two are deliberately different — "move manually" vs
// "advance one step".)
//
// Agent-kind lists are FLAGGED, never hidden: dropping a card on an agent list
// auto-dispatches a run (the server's processChain fires on a move into an agent
// list), so the sheet shows a caution badge rather than silently starting work.
//
// Pure + dependency-free so it unit-tests without booting the board or React.

export interface MoveTarget {
  id: string;
  title: string;
  /** The list's kind ("manual" | "agent" | …). */
  kind: string;
  /** True when moving here auto-dispatches a run (agent-kind list). */
  isAgent: boolean;
}

interface ListLike {
  id: string;
  title?: string | null;
  kind?: string | null;
}
interface BoardLike {
  lists?: ListLike[];
}
interface CardLike {
  list: string;
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
    if (l.id === currentList) continue;
    const kind = typeof l.kind === "string" && l.kind ? l.kind : "manual";
    out.push({
      id: l.id,
      title: typeof l.title === "string" && l.title ? l.title : l.id,
      kind,
      isAgent: kind === "agent"
    });
  }
  return out;
}
