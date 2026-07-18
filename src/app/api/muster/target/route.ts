import { NextResponse, type NextRequest } from "next/server";
import { upsertCompositionTarget } from "../model";
import { jsonError } from "@/lib/http";

export const runtime = "nodejs";
export const dynamic = "force-dynamic";

// POST /api/muster/target
// Body: { composition?, originalId?, id, runtime, provider?, model,
//         promptMode: "lean"|"full"|null, maxTurns: integer|null }
export async function POST(request: NextRequest) {
  try {
    const body = (await request.json().catch(() => ({}))) as Record<string, unknown>;
    const composition = typeof body.composition === "string" ? body.composition.trim() || undefined : undefined;
    const id = typeof body.id === "string" ? body.id.trim() : "";
    const runtimeId = typeof body.runtime === "string" ? body.runtime.trim() : "";
    const model = typeof body.model === "string" ? body.model.trim() : "";
    if (!id) return jsonError(new Error("id is required"), 400);
    if (!runtimeId) return jsonError(new Error("runtime is required"), 400);
    if (!model) return jsonError(new Error("model is required"), 400);
    const promptMode = body.promptMode === null || body.promptMode === undefined
      ? null
      : body.promptMode === "lean" || body.promptMode === "full"
        ? body.promptMode
        : undefined;
    if (promptMode === undefined) return jsonError(new Error('promptMode must be "lean", "full", or null'), 400);
    const maxTurns = body.maxTurns === null || body.maxTurns === undefined ? null : body.maxTurns;
    if (maxTurns !== null && typeof maxTurns !== "number") {
      return jsonError(new Error("maxTurns must be a number or null"), 400);
    }
    return NextResponse.json(
      await upsertCompositionTarget(composition, {
        originalId: typeof body.originalId === "string" ? body.originalId : undefined,
        id,
        runtime: runtimeId,
        provider: typeof body.provider === "string" ? body.provider : undefined,
        model,
        promptMode,
        maxTurns
      })
    );
  } catch (error) {
    return jsonError(error, 400);
  }
}
