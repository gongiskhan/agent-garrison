import { NextResponse, type NextRequest } from "next/server";
import { resolveRuntimeQuarters, listFileSet } from "@/lib/quarters-runtimes";
import { jsonError } from "@/lib/http";

export const runtime = "nodejs";
export const dynamic = "force-dynamic";

async function descriptorFor(rid: string) {
  const entries = await resolveRuntimeQuarters();
  const entry = entries.find((e) => e.fittingId === rid && e.descriptor.tier === "generic");
  if (!entry) throw new Error(`no generic quarters descriptor for runtime "${rid}" in the current composition`);
  return entry.descriptor;
}

// G5: the entries of one file_sets id - a rule/skill/agent/hook/project-rule
// file, never an arbitrary path (glob + root containment enforced in the lib).
export async function GET(request: NextRequest, { params }: { params: { rid: string; set: string } }) {
  try {
    const project = request.nextUrl.searchParams.get("project") ?? undefined;
    const rows = await listFileSet(await descriptorFor(params.rid), params.set, project);
    return NextResponse.json({ entries: rows });
  } catch (error) {
    return jsonError(error, 400);
  }
}
