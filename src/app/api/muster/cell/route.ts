import { NextResponse, type NextRequest } from "next/server";
import { setCellTarget } from "../model";
import { jsonError } from "@/lib/http";
import { dutyEfforts, type DutyEffort } from "@/lib/types";

export const runtime = "nodejs";
export const dynamic = "force-dynamic";

// POST /api/muster/cell
// Body: { composition?, dutyId, level, target?, effort? }
// Set a leaf level's target and/or effort (drag-to-place, tap-to-place, or the
// effort segments). Persists into composition.duties and returns the fresh
// model. Assigning an ineligible target (e.g. garrison-call onto a skill cell)
// is NOT rejected here — the model round-trips it and the UI surfaces the
// violation inline (never silently accept, per D-live-validation).
export async function POST(request: NextRequest) {
  try {
    const body = (await request.json().catch(() => ({}))) as {
      composition?: unknown;
      dutyId?: unknown;
      level?: unknown;
      target?: unknown;
      effort?: unknown;
    };
    const composition = typeof body.composition === "string" ? body.composition.trim() || undefined : undefined;
    const dutyId = typeof body.dutyId === "string" ? body.dutyId.trim() : "";
    const level = typeof body.level === "number" && Number.isInteger(body.level) ? body.level : NaN;
    if (!dutyId) return jsonError(new Error("dutyId is required"), 400);
    if (!Number.isFinite(level) || level < 1) return jsonError(new Error("level must be a 1-based integer"), 400);

    const patch: { target?: string; effort?: DutyEffort } = {};
    if (typeof body.target === "string") patch.target = body.target.trim();
    if (typeof body.effort === "string") {
      if (!(dutyEfforts as readonly string[]).includes(body.effort)) {
        return jsonError(new Error(`effort must be one of ${dutyEfforts.join(", ")}`), 400);
      }
      patch.effort = body.effort as DutyEffort;
    }
    if (patch.target === undefined && patch.effort === undefined) {
      return jsonError(new Error("provide a target and/or an effort to set"), 400);
    }

    const model = await setCellTarget(composition, dutyId, level, patch);
    return NextResponse.json(model);
  } catch (error) {
    return jsonError(error, 400);
  }
}
