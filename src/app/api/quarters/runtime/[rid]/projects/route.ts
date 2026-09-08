import { NextResponse, type NextRequest } from "next/server";
import { knownProjectRoots } from "@/lib/quarters-runtimes";
import { jsonError } from "@/lib/http";

export const runtime = "nodejs";
export const dynamic = "force-dynamic";

// G5: candidate roots for a project-scoped file set (Cursor's project rules) -
// children of the composition's global_config.projects_root. `rid` is unused
// today (every runtime shares the one composition-wide projects_root) but
// kept in the path for symmetry with the sibling routes and in case a
// runtime-specific root list is ever needed.
export async function GET(_request: NextRequest, { params: _params }: { params: { rid: string } }) {
  try {
    return NextResponse.json({ projects: await knownProjectRoots() });
  } catch (error) {
    return jsonError(error, 400);
  }
}
