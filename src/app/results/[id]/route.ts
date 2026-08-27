import { NextResponse, type NextRequest } from "next/server";
import { promises as fs } from "node:fs";
import path from "node:path";
import { readRun, runDir } from "@/lib/results-store";
import { renderReportHtml } from "@/lib/results-report";

export const runtime = "nodejs";
export const dynamic = "force-dynamic";

// Serve the run's static report. The page is written to disk on every mutation
// (so the artifact genuinely exists as a file, and a mid-run refresh shows the
// newest step); a missing or unreadable report.html re-renders from run.json
// rather than 404-ing, so the JSON stays the single source of truth.
export async function GET(_request: NextRequest, { params }: { params: { id: string } }) {
  let record;
  try {
    record = await readRun(params.id);
  } catch {
    return new NextResponse("invalid run id", { status: 400, headers: { "content-type": "text/plain" } });
  }
  if (!record) {
    return new NextResponse("No such result. It may have been deleted.", {
      status: 404,
      headers: { "content-type": "text/plain; charset=utf-8" }
    });
  }
  let html: string;
  try {
    html = await fs.readFile(path.join(runDir(params.id), "report.html"), "utf8");
  } catch {
    html = renderReportHtml(record);
  }
  return new NextResponse(html, {
    status: 200,
    headers: {
      "content-type": "text/html; charset=utf-8",
      // A run still executing must not be cached, or the phone shows a stale
      // step list on refresh.
      "cache-control": "no-store",
      "x-content-type-options": "nosniff"
    }
  });
}
