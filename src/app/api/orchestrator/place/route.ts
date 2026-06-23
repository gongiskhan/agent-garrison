import { NextResponse, type NextRequest } from "next/server";
import path from "node:path";
import os from "node:os";
import { existsSync } from "node:fs";
import { ROOT_DIR, COMPOSITIONS_DIR } from "@/lib/paths";
import { placeOrchestratedSession } from "@/lib/orchestrator-placement";
import { jsonError } from "@/lib/http";

export const runtime = "nodejs";

// Resolve the placement config from the LIVE installed composition when it exists,
// so placement reflects the user's actual modes.json / composition-scoped routing.json
// rather than the repo seed defaults (which can diverge). Falls back to the seed when a
// piece is not installed in the composition.
function resolvePlacementPaths(composition = "default") {
  const compDir = path.join(COMPOSITIONS_DIR, composition);
  const installedModes = path.join(compDir, "apm_modules", "_local", "modes");
  const scopedRouting = path.join(compDir, ".garrison", "routing.json");
  return {
    modesDir: existsSync(path.join(installedModes, "modes.json"))
      ? installedModes
      : path.join(ROOT_DIR, "fittings/seed/modes"),
    routingConfigPath: existsSync(scopedRouting)
      ? scopedRouting
      : path.join(ROOT_DIR, "fittings/seed/model-router/config/routing.seed.json")
  };
}

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

    const { modesDir, routingConfigPath } = resolvePlacementPaths();
    const result = await placeOrchestratedSession({
      channel,
      mode,
      modesDir,
      routingConfigPath,
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
