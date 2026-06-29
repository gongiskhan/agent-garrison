import { NextResponse, type NextRequest } from "next/server";
import { getPromotedFittingsView, savePromotedSetup } from "@/lib/promoted-fittings";
import { jsonError } from "@/lib/http";

export const runtime = "nodejs";
export const dynamic = "force-dynamic";

// GET — the promoted Fittings (skills/agent-tools/plugins as first-class
// Fittings) grouped by faculty under their Agent/Dev tier, joined to live
// Quarters discovery + setup overrides.
export async function GET() {
  try {
    return NextResponse.json(await getPromotedFittingsView());
  } catch (error) {
    return jsonError(error, 400);
  }
}

// PUT — persist edited setup instructions for one promoted Fitting.
// Body: { id: string, setup: SetupStep[] }
export async function PUT(request: NextRequest) {
  try {
    const body = (await request.json()) as { id?: unknown; setup?: unknown };
    if (typeof body.id !== "string") {
      return jsonError(new Error("id is required"), 400);
    }
    const setup = await savePromotedSetup(body.id, body.setup);
    return NextResponse.json({ ok: true, id: body.id, setup });
  } catch (error) {
    return jsonError(error, 400);
  }
}
