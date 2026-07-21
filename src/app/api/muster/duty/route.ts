import { NextResponse, type NextRequest } from "next/server";
import { setSelectedDuty } from "../model";
import { jsonError } from "@/lib/http";

export const runtime = "nodejs";
export const dynamic = "force-dynamic";

// POST /api/muster/duty
// Body: { composition?, dutyId, action: "add" | "remove" }
// Add or remove a selected duty on the composition's selected_duties list, then
// return the freshly assembled Muster model. Autosave discipline — a discrete
// change persists immediately; there is no Save button.
export async function POST(request: NextRequest) {
  try {
    const body = (await request.json().catch(() => ({}))) as {
      composition?: unknown;
      dutyId?: unknown;
      action?: unknown;
    };
    const dutyId = typeof body.dutyId === "string" ? body.dutyId.trim() : "";
    const action = body.action === "remove" ? "remove" : body.action === "add" ? "add" : null;
    const composition = typeof body.composition === "string" ? body.composition.trim() || undefined : undefined;
    if (!dutyId) return jsonError(new Error("dutyId is required"), 400);
    if (!action) return jsonError(new Error('action must be "add" or "remove"'), 400);
    const model = await setSelectedDuty(composition, dutyId, action);
    return NextResponse.json(model);
  } catch (error) {
    return jsonError(error, 400);
  }
}
