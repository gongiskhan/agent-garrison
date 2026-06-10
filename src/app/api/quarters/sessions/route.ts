import { NextResponse, type NextRequest } from "next/server";
import { listLogEntries, tailLogEntry } from "@/lib/claude-logs";
import { jsonError } from "@/lib/http";

export const runtime = "nodejs";
export const dynamic = "force-dynamic";

// Read-only Sessions surface (Quarters > Sessions). GET with no ?path lists the
// session records + transcripts under the real ~/.claude; GET ?path=<rel>
// returns a bounded tail.
export async function GET(request: NextRequest) {
  try {
    const rel = request.nextUrl.searchParams.get("path");
    if (rel) {
      return NextResponse.json(await tailLogEntry("sessions", rel));
    }
    return NextResponse.json(await listLogEntries("sessions"));
  } catch (error) {
    return jsonError(error, 400);
  }
}
