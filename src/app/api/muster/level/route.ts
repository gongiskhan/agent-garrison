import { NextResponse, type NextRequest } from "next/server";
import { addDutyLevel, describeDutyLevel, removeDutyLevel } from "../model";
import { jsonError } from "@/lib/http";

export const runtime = "nodejs";
export const dynamic = "force-dynamic";

// POST /api/muster/level
// Body: { composition?, dutyId, action: "add" | "remove" | "describe", level?, description? }
// Manage a duty's level ladder: append a level, remove one (guarded - never
// leaves a duty level-less, never breaks another duty's sequence ref), or
// rewrite one level's description (the Dispatcher's routing criterion).
// Autosave discipline - a discrete change persists immediately.
export async function POST(request: NextRequest) {
  try {
    const body = (await request.json().catch(() => ({}))) as {
      composition?: unknown;
      dutyId?: unknown;
      action?: unknown;
      level?: unknown;
      description?: unknown;
    };
    const composition = typeof body.composition === "string" ? body.composition.trim() || undefined : undefined;
    const dutyId = typeof body.dutyId === "string" ? body.dutyId.trim() : "";
    if (!dutyId) return jsonError(new Error("dutyId is required"), 400);
    const action = body.action;
    if (action !== "add" && action !== "remove" && action !== "describe") {
      return jsonError(new Error('action must be "add", "remove", or "describe"'), 400);
    }

    if (action === "add") {
      const description = typeof body.description === "string" ? body.description : undefined;
      return NextResponse.json(await addDutyLevel(composition, dutyId, description));
    }

    const level = typeof body.level === "number" && Number.isInteger(body.level) ? body.level : NaN;
    if (!Number.isFinite(level) || level < 1) {
      return jsonError(new Error("level must be a 1-based integer"), 400);
    }
    if (action === "remove") {
      return NextResponse.json(await removeDutyLevel(composition, dutyId, level));
    }
    if (typeof body.description !== "string") {
      return jsonError(new Error("description is required for describe"), 400);
    }
    return NextResponse.json(await describeDutyLevel(composition, dutyId, level, body.description));
  } catch (error) {
    return jsonError(error, 400);
  }
}
