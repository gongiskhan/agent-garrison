import { NextResponse } from "next/server";
import { resolveRuntimeQuarters } from "@/lib/quarters-runtimes";
import { jsonError } from "@/lib/http";

export const runtime = "nodejs";
export const dynamic = "force-dynamic";

// The Quarters runtime dimension (GARRISON-RUNTIMES-V1 P5/D6): the runtimes
// selected in the current composition, each with its Quarters descriptor
// (deep → registered route base; generic → descriptor-rendered surface).
export async function GET() {
  try {
    return NextResponse.json(await resolveRuntimeQuarters());
  } catch (error) {
    return jsonError(error, 500);
  }
}
