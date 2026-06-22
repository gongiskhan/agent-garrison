import { NextResponse, type NextRequest } from "next/server";
import path from "node:path";
import os from "node:os";
import { ROOT_DIR } from "@/lib/paths";
import { placeOrchestratedSession } from "@/lib/orchestrator-placement";
import { jsonError } from "@/lib/http";

export const runtime = "nodejs";

// POST /api/orchestrator/place { channel?, mode? }
// The front door for starting a session THROUGH the orchestrator: resolves the
// mode (channel default — dev-env → joe — or the explicit mode), composes that
// mode's prompt, and returns { mode, promptPath, model, effort, role } so a caller
// (the Dev Env) can spawn Claude Code with the orchestrator-composed identity.
export async function POST(request: NextRequest) {
  try {
    const body = (await request.json().catch(() => ({}))) as { channel?: unknown; mode?: unknown };
    const channel = typeof body.channel === "string" && body.channel ? body.channel : "dev-env";
    const mode = typeof body.mode === "string" ? body.mode : null;

    const result = await placeOrchestratedSession({
      channel,
      mode,
      modesDir: path.join(ROOT_DIR, "fittings/seed/modes"),
      routingConfigPath: path.join(ROOT_DIR, "fittings/seed/model-router/config/routing.seed.json"),
      outDir: path.join(os.homedir(), ".garrison", "dev-env-souls")
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
