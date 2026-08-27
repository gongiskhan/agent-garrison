import { NextResponse } from "next/server";
import { jsonError } from "@/lib/http";
import {
  findItemContext,
  markSentToKanban,
  mutateRoadmap,
  projectRoadmap,
  readRoadmapDoc,
  roadmapPathForProject,
  RoadmapMalformedError,
  RoadmapNotFoundError,
  RoadmapRequestError,
  type KanbanTarget
} from "@/lib/roadmaps";
import { KanbanUnavailableError, sendItemToKanban } from "@/lib/roadmap-kanban";

export const runtime = "nodejs";
export const dynamic = "force-dynamic";

interface Context {
  params: Promise<{ project: string }> | { project: string };
}

// POST - send one roadmap task to the board.
//
// Body: { itemId, list: "backlog" | "todo", force?: boolean }
//
// The anti-duplication invariant lives here rather than in the view: an item
// already sent is a 409 the user must confirm past with `force`, so a second
// click (or a second browser tab) cannot quietly mint a duplicate card.
export async function POST(request: Request, context: Context) {
  try {
    const { project } = await context.params;
    const file = roadmapPathForProject(project);
    const payload = (await request.json().catch(() => null)) as {
      itemId?: unknown;
      list?: unknown;
      force?: unknown;
    } | null;

    const itemId = typeof payload?.itemId === "string" ? payload.itemId : null;
    const list: KanbanTarget | null =
      payload?.list === "backlog" || payload?.list === "todo" ? payload.list : null;
    if (!itemId) return jsonError("itemId (string) is required", 400);
    if (!list) return jsonError('list must be "backlog" or "todo"', 400);

    // The send is NOT inside mutateRoadmap: that would hold the file's write
    // lock across a network call to the board. Read → send → stamp instead, and
    // re-check the duplicate guard under the lock when stamping.
    const { doc: preflight, context: itemContext } = await readItemContext(file, itemId);
    if (itemContext.item.sentToKanban && payload?.force !== true) {
      return NextResponse.json(
        {
          error: `already sent to ${itemContext.item.sentToKanban}`,
          alreadySent: itemContext.item.sentToKanban,
          cardId: itemContext.item.kanbanCardId,
          confirmRequired: true
        },
        { status: 409 }
      );
    }

    const sent = await sendItemToKanban({
      project,
      roadmapTitle: projectRoadmap(preflight).title,
      categoryTitle: itemContext.categoryTitle,
      item: itemContext.item,
      note: itemContext.note,
      list
    });

    const { doc } = await mutateRoadmap(file, (current) =>
      markSentToKanban(current, itemId, list, sent.cardId)
    );

    return NextResponse.json({
      project,
      sent: { list, cardId: sent.cardId },
      roadmap: projectRoadmap(doc)
    });
  } catch (error) {
    if (error instanceof RoadmapNotFoundError) return jsonError(error, 404);
    if (error instanceof RoadmapMalformedError) return jsonError(error, 422);
    if (error instanceof RoadmapRequestError) return jsonError(error, 400);
    // The board being down is an expected, recoverable state, not a bug here.
    if (error instanceof KanbanUnavailableError) return jsonError(error, 503);
    return jsonError(error, 502);
  }
}

async function readItemContext(file: string, itemId: string) {
  const doc = await readRoadmapDoc(file);
  if (!doc) throw new RoadmapNotFoundError(`${file} does not exist yet`);
  const context = findItemContext(doc, itemId);
  if (!context) throw new RoadmapNotFoundError(`no item "${itemId}" in this roadmap`);
  return { doc, context };
}
