import { NextResponse, type NextRequest } from "next/server";
import { coordState } from "@/lib/coord-cli";

export const runtime = "nodejs";
export const dynamic = "force-dynamic";

// GET /api/coordination/status[?repo=/abs/path]
// Returns the unified coordination state (the SAME object `coord state --json`
// renders). If the state source cannot be reached, returns an honest
// heroVerdict.overall = "unknown" — the view must never show stale green.
export async function GET(request: NextRequest) {
  const repo = request.nextUrl.searchParams.get("repo") || undefined;
  try {
    return NextResponse.json(await coordState(repo));
  } catch (error) {
    const message = error instanceof Error ? error.message : String(error);
    return NextResponse.json(
      {
        repo: repo ?? null,
        timestamp: new Date().toISOString(),
        unreachable: true,
        liveness: null,
        sessions: [],
        locks: [],
        recentIntents: [],
        recentPlans: [],
        leases: [],
        heroVerdict: { overall: "unknown", reasons: [`Coordination state is unavailable: ${message}`], details: {} }
      },
      { status: 200 }
    );
  }
}
