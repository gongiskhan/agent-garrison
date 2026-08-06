import { NextResponse, type NextRequest } from "next/server";
import path from "node:path";
import { placeOrchestratedSession, safeComposition } from "@/lib/orchestrator-placement";
import { COMPOSITIONS_DIR } from "@/lib/paths";
import { jsonError } from "@/lib/http";

export const runtime = "nodejs";

// POST /api/orchestrator/place { channel?, composition? }
// Materializes the authoritative layered Orchestrator prompt for a new Dev Env
// session. Model and duty selection remain per-turn routing decisions.
export async function POST(request: NextRequest) {
  try {
    const body = (await request.json().catch(() => ({}))) as {
      channel?: unknown;
      composition?: unknown;
    };
    const channel = typeof body.channel === "string" && body.channel ? body.channel : "dev-env";
    const composition = safeComposition(body.composition);
    const result = await placeOrchestratedSession({
      composition,
      channel,
      decisionsPath: path.join(COMPOSITIONS_DIR, composition, ".garrison", "decisions.jsonl")
    });
    return NextResponse.json(result);
  } catch (error) {
    return jsonError(error, 400);
  }
}
