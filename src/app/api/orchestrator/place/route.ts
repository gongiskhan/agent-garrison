import { NextResponse, type NextRequest } from "next/server";
import path from "node:path";
import os from "node:os";
import { placeOrchestratedSession, resolvePlacementPaths, safeComposition } from "@/lib/orchestrator-placement";
import { COMPOSITIONS_DIR } from "@/lib/paths";
import { jsonError } from "@/lib/http";

export const runtime = "nodejs";

// POST /api/orchestrator/place { channel?, mode?, composition? }
// The front door for starting a session THROUGH the orchestrator: resolves the
// mode (channel default — dev-env → joe — or the explicit mode), composes that
// mode's prompt, and returns { mode, promptPath, model, effort, role } so a caller
// (the Dev Env) can spawn Claude Code with the orchestrator-composed identity.
export async function POST(request: NextRequest) {
  try {
    const body = (await request.json().catch(() => ({}))) as {
      channel?: unknown;
      mode?: unknown;
      composition?: unknown;
    };
    const channel = typeof body.channel === "string" && body.channel ? body.channel : "dev-env";
    const mode = typeof body.mode === "string" ? body.mode : null;
    // honor the ACTIVE composition the caller is starting a session in (defaults to the
    // single-composition "default" when not supplied), so a non-default composition uses
    // its own live modes/routing — not default's.
    const composition = safeComposition(body.composition);
    const { modesDir, routingConfigPath } = resolvePlacementPaths(composition);
    const result = await placeOrchestratedSession({
      channel,
      mode,
      modesDir,
      routingConfigPath,
      outDir: path.join(os.homedir(), ".garrison", "dev-env-souls"),
      // record the placement decision to the ACTIVE composition's decisions.jsonl
      // (best-effort telemetry; sits alongside the gateway's routing decisions).
      decisionsPath: path.join(COMPOSITIONS_DIR, composition, ".garrison", "decisions.jsonl")
    });

    if (!result) {
      return NextResponse.json(
        { error: "modes fitting not available — install the `modes` fitting to start orchestrated sessions" },
        { status: 404 }
      );
    }
    return NextResponse.json(result);
  } catch (error) {
    return jsonError(error, 400);
  }
}
