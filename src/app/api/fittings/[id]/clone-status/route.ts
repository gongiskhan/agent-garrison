import { NextResponse, type NextRequest } from "next/server";
import { CloneError, cloneDrift, readCloneProvenance } from "@/lib/clone";

export const runtime = "nodejs";
export const dynamic = "force-dynamic";

// GET /api/fittings/[id]/clone-status — for a clone, its upstream pin plus the
// live drift against the clone-time baseline. 404 for anything that is not a
// clone (unknown id, non-local Fitting, or a local Fitting with no clone.json).
export async function GET(
  _request: NextRequest,
  { params }: { params: { id: string } }
) {
  try {
    const provenance = await readCloneProvenance(params.id);
    if (!provenance) {
      return NextResponse.json({ error: `Fitting ${params.id} is not a clone` }, { status: 404 });
    }
    const { drifted, clean } = await cloneDrift(params.id);
    return NextResponse.json({ cloned_from: provenance.cloned_from, drifted, clean });
  } catch (error) {
    if (error instanceof CloneError) {
      return NextResponse.json({ error: error.message }, { status: error.status });
    }
    const message = error instanceof Error ? error.message : String(error);
    return NextResponse.json({ error: message }, { status: 500 });
  }
}
