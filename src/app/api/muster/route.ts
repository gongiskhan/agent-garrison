import { NextResponse, type NextRequest } from "next/server";
import { assembleMusterModel } from "./model";
import { jsonError } from "@/lib/http";

export const runtime = "nodejs";
export const dynamic = "force-dynamic";

// GET /api/muster?composition=<id>
// The read surface for the Muster page (S5a): the active composition's resolved
// model — duties, selected duties, targets, readiness rules, and the composition
// list for the header switcher. `?composition=` overrides the active pointer
// (used by the switcher and by tests); absent, the active composition is read.
export async function GET(request: NextRequest) {
  try {
    const composition = request.nextUrl.searchParams.get("composition")?.trim() || undefined;
    const model = await assembleMusterModel(composition);
    return NextResponse.json(model);
  } catch (error) {
    return jsonError(error, 400);
  }
}
