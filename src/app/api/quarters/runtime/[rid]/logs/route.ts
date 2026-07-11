import { NextResponse, type NextRequest } from "next/server";
import { resolveRuntimeQuarters, listRuntimeLogs, tailRuntimeLog } from "@/lib/quarters-runtimes";
import { jsonError } from "@/lib/http";

export const runtime = "nodejs";
export const dynamic = "force-dynamic";

// Generic-tier log tails (P5): declared log roots only, containment enforced
// in the lib.
async function descriptorFor(rid: string) {
  const entries = await resolveRuntimeQuarters();
  const entry = entries.find((e) => e.fittingId === rid && e.descriptor.tier === "generic");
  if (!entry) throw new Error(`no generic quarters descriptor for runtime "${rid}" in the current composition`);
  return entry.descriptor;
}

export async function GET(request: NextRequest, { params }: { params: { rid: string } }) {
  try {
    const descriptor = await descriptorFor(params.rid);
    const root = request.nextUrl.searchParams.get("root");
    const rel = request.nextUrl.searchParams.get("path");
    if (root && rel) return NextResponse.json(await tailRuntimeLog(descriptor, root, rel));
    return NextResponse.json(await listRuntimeLogs(descriptor));
  } catch (error) {
    return jsonError(error, 400);
  }
}
