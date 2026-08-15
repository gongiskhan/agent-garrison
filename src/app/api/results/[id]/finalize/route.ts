import { NextResponse, type NextRequest } from "next/server";
import { finalizeRun, NotFound } from "@/lib/results-store";
import { resultLinks } from "@/lib/results-links";

export const runtime = "nodejs";
export const dynamic = "force-dynamic";

// Close the run and hand back the durable link. The reporting session prints
// `url` as the last line of its output so it is tappable from the phone the
// moment the session finishes.
export async function POST(request: NextRequest, { params }: { params: { id: string } }) {
  let body: Record<string, unknown> = {};
  try {
    body = (await request.json()) as Record<string, unknown>;
  } catch {
    // Finalizing with no body derives the status from the steps.
  }
  try {
    const record = await finalizeRun(params.id, {
      status: body.status as string | undefined,
      conclusion: (body.conclusion ?? body.summary) as string | undefined
    });
    const links = await resultLinks(request, record.id);
    return NextResponse.json({ ok: true, runId: record.id, status: record.status, summary: record.summary, ...links });
  } catch (error) {
    if (error instanceof NotFound) return NextResponse.json({ error: error.message }, { status: 404 });
    return NextResponse.json({ error: error instanceof Error ? error.message : String(error) }, { status: 400 });
  }
}
