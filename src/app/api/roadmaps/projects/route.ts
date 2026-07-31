import { NextResponse } from "next/server";
import { jsonError } from "@/lib/http";
import { readDevRoot } from "@/lib/dev-root";
import { listRoadmapProjects } from "@/lib/roadmaps";

export const runtime = "nodejs";
export const dynamic = "force-dynamic";

// Every project the Roadmaps picker may offer, each flagged with whether it
// already carries a roadmap.json. The vocabulary is exactly what the resolver
// accepts, so the picker can never offer a name that would then be refused.
export async function GET() {
  try {
    return NextResponse.json({
      devRoot: readDevRoot(),
      projects: await listRoadmapProjects()
    });
  } catch (error) {
    return jsonError(error, 500);
  }
}
