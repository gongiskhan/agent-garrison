import { NextRequest, NextResponse } from "next/server";
// @ts-ignore — pure .mjs (the shared session-log substrate)
import { listRuns, readEvents } from "@garrison/claude-pty";

export const dynamic = "force-dynamic";

// The session-log viewer's read API (Harness brief §1). Read-only over the
// append-only JSONL files under $GARRISON_HOME/session-logs/:
//   GET /api/session-log                     → { runs: [{runId, bytes, mtime}] }
//   GET /api/session-log?run=<id>&offset=<c> → { events, offset } (opaque cursor)
export async function GET(request: NextRequest) {
  const run = request.nextUrl.searchParams.get("run");
  try {
    if (!run) {
      return NextResponse.json({ runs: listRuns().slice(0, 50) });
    }
    const offset = Number(request.nextUrl.searchParams.get("offset") ?? "0") || 0;
    const limit = Math.min(Number(request.nextUrl.searchParams.get("limit") ?? "300") || 300, 1000);
    const domain = request.nextUrl.searchParams.get("domain");
    const page = readEvents(run, { offset, limit });
    const events = domain
      ? page.events.filter((e: { domain?: string }) => e.domain === domain)
      : page.events;
    return NextResponse.json({ events, offset: page.offset });
  } catch (err) {
    return NextResponse.json(
      { error: err instanceof Error ? err.message : String(err) },
      { status: 500 }
    );
  }
}
