import { NextResponse, type NextRequest } from "next/server";
import { assembleStandingModel } from "../model";
import { jsonError } from "@/lib/http";

export const runtime = "nodejs";
export const dynamic = "force-dynamic";

// GET /api/muster/standing?composition=<id>
// The read surface for the Muster Standing Fittings section (S5b): the standing
// (non-duty) faculty slots of the active composition, each with its current
// fitting(s), config schema + values, swap candidates, and the primary runtime.
// `?composition=` overrides the active pointer (the header switcher + tests).
export async function GET(request: NextRequest) {
  try {
    const composition = request.nextUrl.searchParams.get("composition")?.trim() || undefined;
    return NextResponse.json(await assembleStandingModel(composition));
  } catch (error) {
    return jsonError(error, 400);
  }
}
