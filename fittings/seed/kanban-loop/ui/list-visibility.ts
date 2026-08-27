// ── Board column visibility ──────────────────────────────────────────────────
//
// The rail carries one column per phase, and most phases are empty most of the
// time: a board with fourteen autonomous lists and three occupied ones makes the
// human scroll past eleven empty columns to reach the work. So an AUTONOMOUS
// (engine-owned agent) list with no cards on it is hidden by default.
//
// Three rules keep that from losing anything:
//
//   1. Only autonomous lists are ever hidden. Manual lists, system lists
//      (scheduled, running) and interactive agent lists (Discuss) are the
//      human's own surfaces — an empty one is still where you put the next
//      card, so hiding it would remove a drop target the human needs.
//   2. Nothing is hidden while a drag is in flight. A card in the hand must be
//      droppable onto any column the board would accept it on, and a column
//      that vanished when you picked a card up cannot be one.
//   3. `showAll` reveals everything. The board offers it as an explicit toggle
//      so the gear (list configuration) on an empty phase stays reachable.
//
// Pure + dependency-free so it unit-tests without booting the board or React.

export interface VisibilityListLike {
  id: string;
  kind?: string | null;
  interactive?: boolean | null;
  system?: boolean | null;
  cards?: unknown[] | null;
}

export interface VisibilityOptions {
  /** The human asked to see every column, empty or not. */
  showAll?: boolean;
  /** A card is currently in the hand — every drop target must stay mounted. */
  dragging?: boolean;
}

/**
 * True when this list is engine-owned: an agent list the human does not drive.
 * Interactive agent lists (Discuss) are excluded — a human opens those.
 */
export function isAutonomousList(list: VisibilityListLike): boolean {
  return list.kind === "agent" && !list.interactive && !list.system;
}

/** True when the board would hide this list right now. */
export function isHiddenList(list: VisibilityListLike, opts: VisibilityOptions = {}): boolean {
  if (opts.showAll || opts.dragging) return false;
  if (!isAutonomousList(list)) return false;
  return (list.cards?.length ?? 0) === 0;
}

/** The columns the board should render, in the order it was given them. */
export function visibleLists<T extends VisibilityListLike>(lists: T[], opts: VisibilityOptions = {}): T[] {
  return lists.filter((list) => !isHiddenList(list, opts));
}

/**
 * How many columns the current view is holding back — the number the "show all"
 * affordance reports, so the human knows something is there before they ask.
 */
export function hiddenListCount(lists: VisibilityListLike[], opts: VisibilityOptions = {}): number {
  return lists.reduce((count, list) => count + (isHiddenList(list, opts) ? 1 : 0), 0);
}
