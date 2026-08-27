import { NextResponse, type NextRequest } from "next/server";
import { listRuns, openRun } from "@/lib/results-store";
import { resultLinks } from "@/lib/results-links";

export const runtime = "nodejs";
export const dynamic = "force-dynamic";

// The ingest surface. Deliberately plain HTTP so it is usable with nothing but
// curl from a bash tool: Claude Code loads MCP servers only at session start,
// so an ALREADY-RUNNING session can never reach the MCP wrapper. Both surfaces
// must stay functionally identical - the wrapper adds tool discoverability,
// never capability.
//
//   POST /api/results                    open a run   -> {runId, url, ...}
//   GET  /api/results                    list runs
//   POST /api/results/<id>/steps         append a step
//   POST /api/results/<id>/media         attach an image / video / file
//   POST /api/results/<id>/finalize      close the run, return the link
//   GET  /api/results/<id>               the run JSON
//   GET  /results/<id>                   the rendered report (phone-friendly)

export async function POST(request: NextRequest) {
  let body: Record<string, unknown> = {};
  try {
    body = (await request.json()) as Record<string, unknown>;
  } catch {
    // An empty body is a valid "open a run with defaults".
  }
  try {
    const record = await openRun({
      title: body.title as string | undefined,
      origin: body.origin as string | undefined,
      session: (body.session ?? body.sessionId) as string | undefined,
      tool: (body.tool ?? "http") as string | undefined,
      cwd: body.cwd as string | undefined,
      project: body.project as string | undefined,
      path: body.path as string | undefined,
      meta: body.meta as Record<string, unknown> | undefined
    });
    const links = await resultLinks(request, record.id);
    return NextResponse.json({ runId: record.id, origin: record.origin, ...links, run: record }, { status: 201 });
  } catch (error) {
    return NextResponse.json({ error: error instanceof Error ? error.message : String(error) }, { status: 500 });
  }
}

export async function GET(request: NextRequest) {
  const limitRaw = Number(request.nextUrl.searchParams.get("limit"));
  const limit = Number.isFinite(limitRaw) && limitRaw > 0 ? Math.min(limitRaw, 1000) : 200;
  try {
    return NextResponse.json({ runs: await listRuns(limit) });
  } catch (error) {
    return NextResponse.json({ error: error instanceof Error ? error.message : String(error) }, { status: 500 });
  }
}
