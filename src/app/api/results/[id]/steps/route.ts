import { NextResponse, type NextRequest } from "next/server";
import { appendStep, Conflict, NotFound } from "@/lib/results-store";
import { resultLinks } from "@/lib/results-links";

export const runtime = "nodejs";
export const dynamic = "force-dynamic";

// Append one step. Reporting is incremental by design: the report page is
// viewable mid-run and the static HTML is re-rendered on every append, so a
// refresh shows whatever has happened so far.
export async function POST(request: NextRequest, { params }: { params: { id: string } }) {
  let body: Record<string, unknown>;
  try {
    body = (await request.json()) as Record<string, unknown>;
  } catch {
    return NextResponse.json({ error: "a JSON body is required" }, { status: 400 });
  }
  try {
    const { step, record } = await appendStep(params.id, {
      id: body.id as string | undefined,
      name: body.name as string | undefined,
      status: body.status as string | undefined,
      description: body.description as string | undefined,
      logs: body.logs as string | undefined,
      notes: body.notes,
      tags: body.tags as string[] | undefined,
      at: body.at as string | undefined
    });
    const links = await resultLinks(request, record.id);
    return NextResponse.json({ ok: true, stepId: step.id, n: step.n, status: step.status, ...links }, { status: 201 });
  } catch (error) {
    if (error instanceof NotFound) return NextResponse.json({ error: error.message }, { status: 404 });
    if (error instanceof Conflict) return NextResponse.json({ error: error.message }, { status: 409 });
    return NextResponse.json({ error: error instanceof Error ? error.message : String(error) }, { status: 400 });
  }
}
