import { NextResponse, type NextRequest } from "next/server";
import { deleteRun, readRun } from "@/lib/results-store";
import { resultLinks } from "@/lib/results-links";

export const runtime = "nodejs";
export const dynamic = "force-dynamic";

export async function GET(request: NextRequest, { params }: { params: { id: string } }) {
  try {
    const record = await readRun(params.id);
    if (!record) return NextResponse.json({ error: "not found" }, { status: 404 });
    return NextResponse.json({ run: record, ...(await resultLinks(request, record.id)) });
  } catch (error) {
    return NextResponse.json({ error: error instanceof Error ? error.message : String(error) }, { status: 400 });
  }
}

// Retention is "keep everything" by default (see docs/RESULTS.md); this is the
// explicit, per-run way to drop one, and the whole run directory goes with it.
export async function DELETE(_request: NextRequest, { params }: { params: { id: string } }) {
  try {
    return NextResponse.json({ deleted: await deleteRun(params.id) });
  } catch (error) {
    return NextResponse.json({ error: error instanceof Error ? error.message : String(error) }, { status: 400 });
  }
}
