// Kanban board summary for the Garrison dashboard.
//
// Reads the kanban-loop board's card files (<board root>/cards/<id>/card.json)
// directly off disk — the summary must work whether or not the board's own
// server process is up. The board root mirrors kanbanModelPath():
// GARRISON_KANBAN_DIR wins, else <garrison home>/kanban-loop.
//
// Classification: the pipeline list set is DYNAMIC (derived per composition via
// deriveKanbanLists), so cards are classified by exclusion against the four
// stable list ids rather than by enumerating phase lists. The terminal ids
// `done` / `needs-attention` are hardcoded engine edges
// (fittings/seed/kanban-loop/lib/board.mjs), and `backlog` / `todo` are the
// manual entry lists — everything else is in-flight ("running"). An entry-list
// card with runningSince set (an onEnter dispatch) also counts as running.

import path from "node:path";
import { readdir, readFile } from "node:fs/promises";
import { garrisonDir } from "./claude-home";

export interface BoardAttentionCard {
  id: string;
  title: string;
  reason: string | null;
}

export interface BoardSummary {
  running: number;
  needsAttention: number;
  done: number;
  needsAttentionCards: BoardAttentionCard[];
  boardUrl: string | null;
  idle: boolean;
}

// Where the board keeps its state — same convention as kanbanModelPath()
// (src/lib/kanban-model.ts). Env is read at call time so tests can point
// GARRISON_KANBAN_DIR at a sandbox without import-order tricks.
export function kanbanBoardDir(): string {
  const dir = process.env.GARRISON_KANBAN_DIR?.trim();
  return dir && dir.length > 0 ? dir : path.join(garrisonDir(), "kanban-loop");
}

interface ParsedCard {
  id: string;
  title: string;
  list: string;
  runningSince: string | null;
  reason: string | null;
  updated: string;
}

// Shape-validate one parsed card.json. Only id/title/list are required —
// attentionReason and runningSince are absent on cards that predate the
// fields, and an absent key is a valid card, not a malformed one.
function parseCard(raw: unknown): ParsedCard | null {
  if (typeof raw !== "object" || raw === null) return null;
  const card = raw as Record<string, unknown>;
  if (typeof card.id !== "string" || typeof card.title !== "string" || typeof card.list !== "string") {
    return null;
  }
  return {
    id: card.id,
    title: card.title,
    list: card.list,
    runningSince: typeof card.runningSince === "string" ? card.runningSince : null,
    reason: typeof card.attentionReason === "string" ? card.attentionReason : null,
    updated: typeof card.updated === "string" ? card.updated : ""
  };
}

const ENTRY_LISTS = new Set(["backlog", "todo"]);

// Pure classification over already-parsed card objects. Invalid shapes are
// skipped so one bad card never takes the dashboard down.
export function summarizeBoardCards(cards: unknown[]): Omit<BoardSummary, "boardUrl"> {
  let running = 0;
  let done = 0;
  const attention: (BoardAttentionCard & { updated: string })[] = [];

  for (const raw of cards) {
    const card = parseCard(raw);
    if (!card) continue;
    if (card.list === "done") {
      done += 1;
    } else if (card.list === "needs-attention") {
      attention.push({ id: card.id, title: card.title, reason: card.reason, updated: card.updated });
    } else if (ENTRY_LISTS.has(card.list)) {
      if (card.runningSince) running += 1;
    } else {
      running += 1;
    }
  }

  // Most recently touched first; ISO timestamps compare lexicographically.
  attention.sort((a, b) => b.updated.localeCompare(a.updated));

  return {
    running,
    done,
    needsAttention: attention.length,
    needsAttentionCards: attention.map(({ id, title, reason }) => ({ id, title, reason })),
    idle: running === 0 && attention.length === 0
  };
}

// The board's live URL from its own-port status file
// (~/.garrison/ui-fittings/kanban-loop.json, same read as the views API).
// Best-effort: board not running / file malformed → null, and the panel
// renders titles without links. Constructed inline rather than importing
// own-port-lifecycle, which drags vault/library modules into this leaf lib.
async function readBoardUrl(): Promise<string | null> {
  try {
    const raw = await readFile(path.join(garrisonDir(), "ui-fittings", "kanban-loop.json"), "utf8");
    const parsed = JSON.parse(raw) as { url?: unknown; route?: unknown };
    if (typeof parsed.url !== "string" || parsed.url.length === 0) return null;
    return parsed.url + (typeof parsed.route === "string" ? parsed.route : "");
  } catch {
    return null;
  }
}

// Read every card off disk and summarize. A missing board or cards/ dir is
// the normal not-installed case (zeros + idle), and an unreadable or torn
// card.json is skipped — this route must never 500 for a state the board
// itself recovers from.
export async function readBoardSummary(): Promise<BoardSummary> {
  const cardsDir = path.join(kanbanBoardDir(), "cards");
  let entries: string[] = [];
  try {
    entries = await readdir(cardsDir);
  } catch {
    entries = [];
  }

  const reads = await Promise.all(
    entries.map(async (entry) => {
      try {
        return JSON.parse(await readFile(path.join(cardsDir, entry, "card.json"), "utf8")) as unknown;
      } catch {
        return null;
      }
    })
  );

  const summary = summarizeBoardCards(reads.filter((card) => card !== null));
  return { ...summary, boardUrl: await readBoardUrl() };
}
