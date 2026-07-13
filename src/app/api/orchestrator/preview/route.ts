import { NextResponse, type NextRequest } from "next/server";
import { loadOrchestratorPreview } from "@/lib/orchestrator-projection";
import { DEFAULT_COMPOSITION_ID } from "@/lib/compositions";
import { jsonError } from "@/lib/http";

export const runtime = "nodejs";

// GET /api/orchestrator/preview?composition=<id>
// The read surface for the Muster orchestrator panel (S5c): returns the layered
// orchestrator prompt as { sections, assembled }. Locked sections (capabilities,
// duties-and-levels, readiness) are regenerated from the composition's resolved
// model on every read and carry `locked: true` + `regeneratedFrom: "composition"`
// so the UI renders them greyed with a "regenerated from composition" badge;
// authored sections are editable and carry their on-disk or default text.
export async function GET(request: NextRequest) {
  try {
    const composition =
      request.nextUrl.searchParams.get("composition")?.trim() || DEFAULT_COMPOSITION_ID;
    const preview = await loadOrchestratorPreview(composition);
    return NextResponse.json(preview);
  } catch (error) {
    return jsonError(error, 400);
  }
}
