import { NextResponse, type NextRequest } from "next/server";
import { DEFAULT_COMPOSITION_ID, readComposition } from "@/lib/compositions";
import { readRoutingInferenceStatus } from "@/lib/decisions-feed";
import { jsonError } from "@/lib/http";

export const runtime = "nodejs";
export const dynamic = "force-dynamic";

// Read-only, leak-safe operational status for Orchestrator → Routing inference.
export async function GET(request: NextRequest) {
  try {
    const id = request.nextUrl.searchParams.get("composition")?.trim() || DEFAULT_COMPOSITION_ID;
    const composition = await readComposition(id);
    const dispatch = composition.duties.find((duty) => duty.id === "dispatch");
    const targetId = dispatch?.levels[0]?.cell?.target || "dispatch-fast";
    const target = composition.targets.find((candidate) => candidate.id === targetId) ?? null;
    const params = target?.params ?? {};
    const telemetry = await readRoutingInferenceStatus(composition.directory);
    return NextResponse.json({
      target: target ? {
        id: target.id,
        runtime: target.runtime,
        provider: target.provider ?? null,
        model: target.model,
        promptMode: typeof params.promptMode === "string" ? params.promptMode : null,
        maxTurns: typeof params.maxTurns === "number" ? params.maxTurns : null,
        timeoutMs: typeof params.timeoutMs === "number" ? params.timeoutMs : 8000,
        authMode: typeof params.authMode === "string" ? params.authMode : null
      } : null,
      ...telemetry
    });
  } catch (error) {
    return jsonError(error, 400);
  }
}
