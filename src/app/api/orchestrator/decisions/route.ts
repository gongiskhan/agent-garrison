import { NextResponse, type NextRequest } from "next/server";
import { StateUnavailableError } from "@garrison/state-client";
import { getCompositionDirectory, DEFAULT_COMPOSITION_ID } from "@/lib/compositions";
import { readDecisionsTail, DEFAULT_DECISIONS_LIMIT } from "@/lib/decisions-feed";
import { recordDecisionVerdict } from "@/lib/decision-verdicts-store";
import { type Verdict } from "@/lib/decision-verdicts";
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

// POST /api/orchestrator/decisions — record a VERDICT on one decision.
//
// The feed used to be read-only in both directions: the orchestrator decided, the
// user watched. That is fine while the user makes the calls themselves and wrong
// the moment everything defaults to auto — an automatic choice nobody can correct
// never gets better. This is the correction channel.
//
// It appends to the Improver's EXISTING feedback queue rather than inventing a
// verdict store; the Improver turns accumulated verdicts into reviewable policy
// proposals and never auto-applies them, so a wrong correction costs a rejected
// proposal, not a silently re-routed fleet.
export async function POST(request: NextRequest) {
  try {
    const body = (await request.json()) as {
      decisionId?: string;
      verdict?: Verdict;
      resolved?: unknown;
      correction?: unknown;
      sessionId?: string | null;
    };
    const ok = await recordDecisionVerdict({
      decisionId: String(body?.decisionId ?? ""),
      verdict: body?.verdict as Verdict,
      resolved: body?.resolved as never,
      correction: body?.correction as never,
      sessionId: body?.sessionId ?? null
    });
    // A refusal is explicit: a verdict silently dropped would leave the user
    // believing they had corrected something they had not.
    if (!ok) {
      return jsonError(new Error("a verdict needs a decision id and one of: right, wrong, unsure"), 400);
    }
    return NextResponse.json({ ok: true });
  } catch (error) {
    // A mesh outage is the service's fault, not the caller's: 503, not 400.
    if (error instanceof StateUnavailableError) return jsonError(error, 503);
    return jsonError(error, 400);
  }
}
