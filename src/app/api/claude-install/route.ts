import { NextResponse, type NextRequest } from "next/server";
import {
  listInstalledFittings,
  detectDrift,
  installFitting,
  adoptFitting,
  uninstallFitting
} from "@/lib/claude-install";
import { resolveArtifacts } from "@/lib/claude-install-source";
import { jsonError } from "@/lib/http";

export const runtime = "nodejs";
export const dynamic = "force-dynamic";

async function inventory() {
  const [installed, drift] = await Promise.all([listInstalledFittings(), detectDrift()]);
  return { installed, drift };
}

export async function GET() {
  try {
    return NextResponse.json(await inventory());
  } catch (error) {
    return jsonError(error, 400);
  }
}

export async function POST(request: NextRequest) {
  try {
    const body = await request.json();
    const fittingId = String(body?.fittingId ?? "").trim();
    const action = String(body?.action ?? "");
    if (!fittingId) return jsonError(new Error("fittingId is required"), 400);

    if (action === "uninstall") {
      const result = await uninstallFitting(fittingId);
      return NextResponse.json({ result, ...(await inventory()) });
    }

    const manifest = await resolveArtifacts(fittingId);
    const result = action === "adopt" ? await adoptFitting(manifest) : await installFitting(manifest);

    // A collision is an expected, actionable state (offer "adopt"), not a 500.
    const status = result.ok ? 200 : result.code === "unowned-collision" ? 409 : 422;
    return NextResponse.json({ result, manifest, ...(await inventory()) }, { status });
  } catch (error) {
    return jsonError(error, 400);
  }
}
