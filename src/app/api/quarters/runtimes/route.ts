import { NextResponse, type NextRequest } from "next/server";
import { resolveRuntimeQuarters } from "@/lib/quarters-runtimes";
import { jsonError } from "@/lib/http";

export const runtime = "nodejs";
export const dynamic = "force-dynamic";

// The Quarters runtime dimension (GARRISON-RUNTIMES-V1 P5/D6): the runtimes
// selected in the current composition, each with its Quarters descriptor
// (deep → registered route base; generic → descriptor-rendered surface).
export async function GET(request: NextRequest) {
  try {
    const composition = request.nextUrl.searchParams.get("composition") ?? undefined;
    return NextResponse.json(await resolveRuntimeQuarters(composition));
  } catch (error) {
    return jsonError(error, 500);
  }
}
