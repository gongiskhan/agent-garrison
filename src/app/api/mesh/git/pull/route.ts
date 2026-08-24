// POST {project} — pull the mesh's state of a project INTO this node:
// ask peers to commit+push, fetch, merge (full rails via the workspace
// fitting when alive; ff-only floor when not).

import { NextRequest, NextResponse } from "next/server";
import { meshPull } from "@/lib/mesh/git-mesh";
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
    return NextResponse.json(await meshPull(body.project));
  } catch (err) {
    const status = err instanceof StateUnavailableError ? 503 : 500;
    return NextResponse.json(
      { error: "mesh-pull-failed", detail: err instanceof Error ? err.message : String(err) },
      { status }
    );
  }
}
