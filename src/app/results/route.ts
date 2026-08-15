import { NextResponse } from "next/server";
import { listRuns } from "@/lib/results-store";
import { renderIndexHtml } from "@/lib/results-report";

export const runtime = "nodejs";
export const dynamic = "force-dynamic";

// The plain list of stored runs - deliberately the whole of the "history"
// surface. Aggregation, dashboards and trends are out of scope; this exists so
// a link you did not keep is still findable from the phone.
export async function GET() {
  const rows = await listRuns(200);
  return new NextResponse(renderIndexHtml(rows), {
    status: 200,
    headers: {
      "content-type": "text/html; charset=utf-8",
      "cache-control": "no-store",
      "x-content-type-options": "nosniff"
    }
  });
}
