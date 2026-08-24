// POST /api/mesh/git/commit-push {project} — the down-survivable executor.
// Internal-token guarded: this mutates git trees, so a browser page (or a
// hostile tab pointed at loopback) must not be able to drive it. The
// scheduler daemon's event pump calls it over loopback with the token.

import { NextRequest, NextResponse } from "next/server";
import { verifyInternalToken } from "@/lib/internal-token";
import { commitPushProject } from "@/lib/mesh/git-executor";
import { StateUnavailableError } from "@/lib/state-client";

export const dynamic = "force-dynamic";

export async function POST(request: NextRequest) {
  const token = request.headers.get("x-garrison-internal");
  if (!token || !(await verifyInternalToken(token))) {
    return NextResponse.json({ error: "internal-token-required" }, { status: 403 });
  }
  let body: { project?: string };
  try {
    body = await request.json();
  } catch {
    return NextResponse.json({ error: "invalid-json" }, { status: 400 });
  }
  if (!body.project) {
    return NextResponse.json({ error: "project-required" }, { status: 422 });
  }
  try {
    const result = await commitPushProject(body.project);
    return NextResponse.json(result);
  } catch (err) {
    const status = err instanceof StateUnavailableError ? 503 : 500;
    return NextResponse.json(
      { error: "commit-push-failed", detail: err instanceof Error ? err.message : String(err) },
      { status }
    );
  }
}
