// The roadmap -> Kanban bridge.
//
// A roadmap task becomes a board card, and the card carries a back-reference to
// the roadmap item it came from so a future revision can close the loop
// automatically. v1 does NOT close it: finishing the card does not tick the
// roadmap (that stays a human or agent action), which keeps this a one-way
// hand-off with no reconciliation machinery to get wrong.
//
// The board is addressed over loopback through its own HTTP API rather than by
// writing card files: the board owns its card format, its ULIDs and its atomic
// writes, and a second writer would have to reimplement all three. Server to
// server on the same box, so a loopback URL is the correct address here (the
// no-machine-local-URLs rule is about what reaches the user's browser).

import path from "node:path";
import { readFile } from "node:fs/promises";
import { garrisonDir } from "./claude-home";
import type { KanbanTarget, RoadmapNote, RoadmapItem } from "./roadmaps";

export const KANBAN_FITTING_ID = "kanban-loop";

export class KanbanUnavailableError extends Error {
  constructor(message: string) {
    super(message);
    this.name = "KanbanUnavailableError";
  }
}

// The board's own-port base URL, from the status file it writes on start - the
// same read the dashboard's board summary does. Missing file or malformed
// contents means the board is not running.
export async function readKanbanBaseUrl(): Promise<string> {
  let raw: string;
  try {
    raw = await readFile(
      path.join(garrisonDir(), "ui-fittings", `${KANBAN_FITTING_ID}.json`),
      "utf8"
    );
  } catch {
    throw new KanbanUnavailableError(
      "the Kanban board is not running - start the operative (or the kanban-loop Fitting) and try again"
    );
  }
  let url: unknown;
  try {
    url = (JSON.parse(raw) as { url?: unknown }).url;
  } catch {
    url = null;
  }
  if (typeof url !== "string" || !url) {
    throw new KanbanUnavailableError("the Kanban board's status file carries no URL");
  }
  return url.replace(/\/+$/, "");
}

async function boardFetch(
  baseUrl: string,
  route: string,
  init?: RequestInit
): Promise<unknown> {
  let response: Response;
  try {
    response = await fetch(`${baseUrl}${route}`, {
      ...init,
      headers: { "content-type": "application/json", ...(init?.headers ?? {}) },
      signal: AbortSignal.timeout(10_000)
    });
  } catch (error) {
    throw new KanbanUnavailableError(
      `could not reach the Kanban board at ${baseUrl} (${error instanceof Error ? error.message : String(error)})`
    );
  }
  const body = (await response.json().catch(() => null)) as Record<string, unknown> | null;
  if (!response.ok) {
    const message =
      typeof body?.error === "string" ? body.error : `board answered ${response.status}`;
    throw new Error(message);
  }
  return body;
}

// The board's list ids are derived per composition, so "todo" is not guaranteed
// to exist. Checking BEFORE creating the card avoids the worst outcome: a card
// created in Backlog, a failed move, and a user told the send failed.
async function assertListExists(baseUrl: string, list: KanbanTarget): Promise<void> {
  const body = (await boardFetch(baseUrl, "/lists")) as { lists?: { id?: unknown }[] } | null;
  const lists = Array.isArray(body?.lists) ? body!.lists : [];
  if (lists.length === 0) return; // board answered without a usable list set - let the move speak
  const ids = lists.map((entry) => entry?.id).filter((id): id is string => typeof id === "string");
  if (!ids.includes(list)) {
    throw new Error(`this board has no "${list}" list (it has: ${ids.join(", ")})`);
  }
}

// The card body. The back-reference is written into the DESCRIPTION rather than
// a bespoke card field on purpose: createCard's field set is frozen, so an
// unknown key would be dropped on the floor without a word, whereas the
// description is preserved verbatim and is also what the agent picking the card
// up actually reads.
export function buildCardDescription(options: {
  project: string;
  roadmapTitle: string;
  categoryTitle: string;
  item: RoadmapItem;
  note: RoadmapNote | null;
}): string {
  const lines = [
    `From the roadmap of \`${options.project}\` (${options.roadmapTitle}).`,
    "",
    `**${options.categoryTitle}** - ${options.item.text}`,
    "",
    `Roadmap ref: \`roadmap:${options.project}#${options.item.id}\``
  ];
  if (options.note) {
    const body = options.note.body.trim();
    lines.push(
      "",
      `## Decisions recorded on this item - ${options.note.title}`,
      "",
      body.length > 6000 ? `${body.slice(0, 6000)}\n\n(note truncated)` : body
    );
  }
  return lines.join("\n");
}

export interface SendResult {
  cardId: string;
  list: KanbanTarget;
  boardUrl: string;
}

// Create the card and, for "todo", move it there. The board always creates on
// Backlog, so a Backlog send is one call and a To Do send is two.
export async function sendItemToKanban(options: {
  project: string;
  roadmapTitle: string;
  categoryTitle: string;
  item: RoadmapItem;
  note: RoadmapNote | null;
  list: KanbanTarget;
}): Promise<SendResult> {
  const baseUrl = await readKanbanBaseUrl();
  if (options.list !== "backlog") await assertListExists(baseUrl, options.list);

  const created = (await boardFetch(baseUrl, "/cards", {
    method: "POST",
    body: JSON.stringify({
      title: options.item.text,
      description: buildCardDescription(options),
      project: options.project,
      origin: "roadmap"
    })
  })) as { card?: { id?: unknown } } | null;

  const cardId = typeof created?.card?.id === "string" ? created.card.id : null;
  if (!cardId) throw new Error("the board created a card but returned no id");

  if (options.list !== "backlog") {
    await boardFetch(baseUrl, `/cards/${encodeURIComponent(cardId)}`, {
      method: "PATCH",
      body: JSON.stringify({ list: options.list })
    });
  }

  return { cardId, list: options.list, boardUrl: baseUrl };
}
