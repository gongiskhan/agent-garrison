import { NextResponse, type NextRequest } from "next/server";
import { createDuty, deleteDuty, DutyRouteError, setSelectedDuty } from "../model";
import { jsonError } from "@/lib/http";

export const runtime = "nodejs";
export const dynamic = "force-dynamic";

const ACTIONS = ["add", "remove", "create", "delete"] as const;
type DutyAction = (typeof ACTIONS)[number];

// POST /api/muster/duty
// Body: { composition?, dutyId, action: "add" | "remove" | "create" | "delete",
//         title?, description?, target?, effort? }   (create only for the last four)
//
// add/remove toggle a KNOWN duty on the composition's selected_duties list and
// return the freshly assembled Muster model (the pre-existing contract).
//
// create/delete manage composition-local duties as Kanban board lists (the
// board's POST /lists and DELETE /lists/:id proxy here):
//   create -> { ok, dutyId, created: true, reconciled, reconcile? }
//   delete -> { ok, dutyId, deleted: true, selectedOnly?, note?, reconciled, reconcile? }
// Both reproject model.json + POST /reconcile on the live board when the edited
// composition is the one the board is currently projected from. Autosave
// discipline - a discrete change persists immediately; there is no Save button.
export async function POST(request: NextRequest) {
  try {
    const body = (await request.json().catch(() => ({}))) as {
      composition?: unknown;
      dutyId?: unknown;
      action?: unknown;
      title?: unknown;
      description?: unknown;
      target?: unknown;
      effort?: unknown;
    };
    const dutyId = typeof body.dutyId === "string" ? body.dutyId.trim() : "";
    const action = (ACTIONS as readonly string[]).includes(body.action as string)
      ? (body.action as DutyAction)
      : null;
    const composition = typeof body.composition === "string" ? body.composition.trim() || undefined : undefined;
    if (!action) return jsonError(new Error('action must be "add", "remove", "create" or "delete"'), 400);

    if (action === "create") {
      const title = typeof body.title === "string" ? body.title : undefined;
      if (!dutyId && !title?.trim()) return jsonError(new Error("create requires a dutyId or a title"), 400);
      const result = await createDuty({
        compositionId: composition,
        dutyId: dutyId || undefined,
        title,
        description: typeof body.description === "string" ? body.description : undefined,
        target: typeof body.target === "string" ? body.target : undefined,
        effort: typeof body.effort === "string" ? body.effort : undefined
      });
      return NextResponse.json(result);
    }

    if (!dutyId) return jsonError(new Error("dutyId is required"), 400);
    if (action === "delete") {
      const result = await deleteDuty({ compositionId: composition, dutyId });
      return NextResponse.json(result);
    }

    const model = await setSelectedDuty(composition, dutyId, action);
    return NextResponse.json(model);
  } catch (error) {
    return jsonError(error, error instanceof DutyRouteError ? error.status : 400);
  }
}
