import { NextResponse, type NextRequest } from "next/server";
import { CloneError, cloneFitting } from "@/lib/clone";

export const runtime = "nodejs";
export const dynamic = "force-dynamic";

// POST /api/fittings/[id]/clone — copy the source Fitting into the local
// namespace and register it. Optional body { newId } overrides the default
// `<id>-copy` id. Returns 201 with the resolved clone library entry.
export async function POST(
  request: NextRequest,
  { params }: { params: { id: string } }
) {
  try {
    let newId: string | undefined;
    try {
      const body = await request.json();
      if (body && typeof body.newId === "string" && body.newId.trim()) {
        newId = body.newId.trim();
      }
    } catch {
      /* no body — use the default id */
    }
    const entry = await cloneFitting(params.id, { newId });
    return NextResponse.json({ entry }, { status: 201 });
  } catch (error) {
    if (error instanceof CloneError) {
      return NextResponse.json({ error: error.message }, { status: error.status });
    }
    const message = error instanceof Error ? error.message : String(error);
    return NextResponse.json({ error: message }, { status: 500 });
  }
}
