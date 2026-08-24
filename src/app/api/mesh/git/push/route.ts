// POST {project} — push THIS node's state of a project to the mesh:
// commit+push locally (session-guarded, fail-closed on an unreadable
// registry), then file one merge card per active peer. Fully autonomous by
// decision; the rails ride with the merge duty that executes the cards.

import { NextRequest, NextResponse } from "next/server";
import { meshPush } from "@/lib/mesh/git-mesh";
import { StateUnavailableError } from "@/lib/state-client";

export const dynamic = "force-dynamic";
export const maxDuration = 300;

export async function POST(request: NextRequest) {
  let body: { project?: string };
  try {
    body = await request.json();
  } catch {
    return NextResponse.json({ error: "invalid-json" }, { status: 400 });
  }
  if (!body.project) return NextResponse.json({ error: "project-required" }, { status: 422 });
  try {
    return NextResponse.json(await meshPush(body.project));
  } catch (err) {
    const status = err instanceof StateUnavailableError ? 503 : 500;
    return NextResponse.json(
      { error: "mesh-push-failed", detail: err instanceof Error ? err.message : String(err) },
      { status }
    );
  }
}
