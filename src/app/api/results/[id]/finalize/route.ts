import { NextResponse, type NextRequest } from "next/server";
import { evidenceCensus, finalizeRun, NotFound } from "@/lib/results-store";
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
    // Tell the caller what it actually filed. A run of green steps with nothing
    // attached is the failure mode this API invites: the session finishes the
    // work, reports it from memory afterwards, and by then the screenshot it
    // took is a path it no longer holds. Media may still be attached after
    // finalize, so this warning is actionable rather than a post-mortem.
    const census = evidenceCensus(record);
    const warnings: string[] = [];
    if (census.steps > 0 && census.artifacts === 0) {
      warnings.push(
        `No artifacts attached to any of the ${census.steps} steps. The report says so on its face. If you still hold a screenshot, log file or recording, POST it to /api/results/${record.id}/media (stepId optional) - that still works after finalize.`
      );
    } else if (census.unbackedPasses > 0) {
      warnings.push(`${census.unbackedPasses} step(s) claim pass with no artifact attached.`);
    }
    return NextResponse.json({
      ok: true,
      runId: record.id,
      status: record.status,
      summary: record.summary,
      evidence: census,
      ...(warnings.length ? { warnings } : {}),
      ...links
    });
  } catch (error) {
    if (error instanceof NotFound) return NextResponse.json({ error: error.message }, { status: 404 });
    return NextResponse.json({ error: error instanceof Error ? error.message : String(error) }, { status: 400 });
  }
}
