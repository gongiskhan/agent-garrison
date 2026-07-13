import { NextResponse, type NextRequest } from "next/server";
import { getCompositionDirectory, DEFAULT_COMPOSITION_ID } from "@/lib/compositions";
import { readDecisionsTail, DEFAULT_DECISIONS_LIMIT } from "@/lib/decisions-feed";
import { jsonError } from "@/lib/http";

export const runtime = "nodejs";
export const dynamic = "force-dynamic";

// GET /api/orchestrator/decisions?composition=<id>&limit=<n>
// The read surface for the Muster Decisions panel (S5c, D12): the tail of the
// composition's `.garrison/decisions.jsonl`, normalized to {at, kind, duty,
// level, target, reason}, newest first. Read-only and leak-safe - the reader
// whitelists scalar fields (never a raw message/prompt or a file path). A missing
// log (no session has routed yet) returns an empty feed.
export async function GET(request: NextRequest) {
  try {
    const composition =
      request.nextUrl.searchParams.get("composition")?.trim() || DEFAULT_COMPOSITION_ID;
    const limitParam = Number(request.nextUrl.searchParams.get("limit"));
    const limit = Number.isFinite(limitParam) ? limitParam : DEFAULT_DECISIONS_LIMIT;
    const decisions = await readDecisionsTail(getCompositionDirectory(composition), limit);
    return NextResponse.json({ decisions });
  } catch (error) {
    return jsonError(error, 400);
  }
}
