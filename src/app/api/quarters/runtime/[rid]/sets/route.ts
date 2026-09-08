import { NextResponse, type NextRequest } from "next/server";
import { resolveRuntimeQuarters } from "@/lib/quarters-runtimes";
import { jsonError } from "@/lib/http";

export const runtime = "nodejs";
export const dynamic = "force-dynamic";

// G5: the descriptor's file_sets summaries (id, label, available, reason,
// home-scoped count) - exactly what resolveRuntimeQuarters already computes,
// so this is a thin read of that one entry rather than a second code path.
async function entryFor(rid: string) {
  const entries = await resolveRuntimeQuarters();
  const entry = entries.find((e) => e.fittingId === rid && e.descriptor.tier === "generic");
  if (!entry) throw new Error(`no generic quarters descriptor for runtime "${rid}" in the current composition`);
  return entry;
}

export async function GET(_request: NextRequest, { params }: { params: { rid: string } }) {
  try {
    const entry = await entryFor(params.rid);
    const declByid = new Map((entry.descriptor.file_sets ?? []).map((d) => [d.id, d]));
    // Availability (available/reason/count) merged with the manifest's own
    // declaration (format/frontmatter/create/write/scope) - the panel needs
    // both to know WHAT it is rendering, not just whether it can.
    const fileSets = (entry.fileSets ?? []).map((a) => ({ ...declByid.get(a.id), ...a }));
    return NextResponse.json({ fileSets });
  } catch (error) {
    return jsonError(error, 400);
  }
}
