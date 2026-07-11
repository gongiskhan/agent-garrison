import { NextResponse, type NextRequest } from "next/server";
import { resolveRuntimeQuarters, readRuntimeFile, writeRuntimeFile } from "@/lib/quarters-runtimes";
import { jsonError } from "@/lib/http";

export const runtime = "nodejs";
export const dynamic = "force-dynamic";

// Generic-tier file surface (P5): serves ONLY the descriptor's DECLARED files
// (allowlist containment in the lib), format-validated + sha-guarded on PUT,
// Garrison-projected files refused (ownership-respected).
async function descriptorFor(rid: string) {
  const entries = await resolveRuntimeQuarters();
  const entry = entries.find((e) => e.fittingId === rid && e.descriptor.tier === "generic");
  if (!entry) {
    throw new Error(`no generic quarters descriptor for runtime "${rid}" in the current composition`);
  }
  return entry.descriptor;
}

export async function GET(request: NextRequest, { params }: { params: { rid: string } }) {
  try {
    const declared = request.nextUrl.searchParams.get("path");
    if (!declared) return jsonError(new Error("path query parameter is required"), 400);
    return NextResponse.json(await readRuntimeFile(await descriptorFor(params.rid), declared));
  } catch (error) {
    return jsonError(error, 400);
  }
}

export async function PUT(request: NextRequest, { params }: { params: { rid: string } }) {
  try {
    const body = (await request.json()) as { path?: string; content?: string; baselineSha?: string | null };
    if (!body.path || typeof body.content !== "string") {
      return jsonError(new Error("path and content are required"), 400);
    }
    return NextResponse.json(
      await writeRuntimeFile(await descriptorFor(params.rid), body.path, body.content, body.baselineSha ?? null)
    );
  } catch (error) {
    return jsonError(error, 400);
  }
}
