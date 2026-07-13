import { NextResponse, type NextRequest } from "next/server";
import { swapStandingFitting } from "../../model";
import { jsonError } from "@/lib/http";

export const runtime = "nodejs";
export const dynamic = "force-dynamic";

// POST /api/muster/standing/swap
// Body: { composition?, faculty, toId?, fromId? }
// Replace the fitting in a standing slot. `toId` is placed; `fromId` (multi
// slots) is the one it replaces; omitting `toId` removes `fromId`. Validates +
// persists atomically, then returns { model, orphaned } - `orphaned` lists any
// consumer the swap left without a provider. The UI OFFERS to remove those
// (a confirm); they are never auto-removed here.
export async function POST(request: NextRequest) {
  try {
    const body = (await request.json().catch(() => ({}))) as {
      composition?: unknown;
      faculty?: unknown;
      toId?: unknown;
      fromId?: unknown;
    };
    const composition = typeof body.composition === "string" ? body.composition.trim() || undefined : undefined;
    const faculty = typeof body.faculty === "string" ? body.faculty.trim() : "";
    const toId = typeof body.toId === "string" ? body.toId.trim() || undefined : undefined;
    const fromId = typeof body.fromId === "string" ? body.fromId.trim() || undefined : undefined;
    if (!faculty) return jsonError(new Error("faculty is required"), 400);
    if (!toId && !fromId) return jsonError(new Error("provide a toId to place and/or a fromId to remove"), 400);

    const result = await swapStandingFitting(composition, faculty, toId, fromId);
    return NextResponse.json(result);
  } catch (error) {
    return jsonError(error, 400);
  }
}
