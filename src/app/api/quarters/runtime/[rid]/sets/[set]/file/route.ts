import { NextResponse, type NextRequest } from "next/server";
import {
  resolveRuntimeQuarters,
  readFileSetEntry,
  writeFileSetEntry,
  createFileSetEntry,
  deleteFileSetEntry
} from "@/lib/quarters-runtimes";
import { jsonError } from "@/lib/http";

export const runtime = "nodejs";
export const dynamic = "force-dynamic";

async function descriptorFor(rid: string) {
  const entries = await resolveRuntimeQuarters();
  const entry = entries.find((e) => e.fittingId === rid && e.descriptor.tier === "generic");
  if (!entry) throw new Error(`no generic quarters descriptor for runtime "${rid}" in the current composition`);
  return entry.descriptor;
}

// G5: one entry inside a file_sets id - read (GET), sha-guarded write (PUT),
// create (POST, only when the set declares create:true), delete (DELETE,
// same gate). rel + root + glob containment is enforced in the lib, not here.
export async function GET(request: NextRequest, { params }: { params: { rid: string; set: string } }) {
  try {
    const rel = request.nextUrl.searchParams.get("rel");
    if (!rel) return jsonError(new Error("rel query parameter is required"), 400);
    const project = request.nextUrl.searchParams.get("project") ?? undefined;
    return NextResponse.json(await readFileSetEntry(await descriptorFor(params.rid), params.set, rel, project));
  } catch (error) {
    return jsonError(error, 400);
  }
}

export async function PUT(request: NextRequest, { params }: { params: { rid: string; set: string } }) {
  try {
    const body = (await request.json()) as { rel?: string; content?: string; baselineSha?: string | null; project?: string };
    if (!body.rel || typeof body.content !== "string") {
      return jsonError(new Error("rel and content are required"), 400);
    }
    return NextResponse.json(
      await writeFileSetEntry(await descriptorFor(params.rid), params.set, body.rel, body.content, body.baselineSha ?? null, body.project)
    );
  } catch (error) {
    return jsonError(error, 400);
  }
}

export async function POST(request: NextRequest, { params }: { params: { rid: string; set: string } }) {
  try {
    const body = (await request.json()) as { rel?: string; content?: string; project?: string };
    if (!body.rel || typeof body.content !== "string") {
      return jsonError(new Error("rel and content are required"), 400);
    }
    return NextResponse.json(await createFileSetEntry(await descriptorFor(params.rid), params.set, body.rel, body.content, body.project));
  } catch (error) {
    return jsonError(error, 400);
  }
}

export async function DELETE(request: NextRequest, { params }: { params: { rid: string; set: string } }) {
  try {
    const rel = request.nextUrl.searchParams.get("rel");
    if (!rel) return jsonError(new Error("rel query parameter is required"), 400);
    const project = request.nextUrl.searchParams.get("project") ?? undefined;
    await deleteFileSetEntry(await descriptorFor(params.rid), params.set, rel, project);
    return NextResponse.json({ deleted: true });
  } catch (error) {
    return jsonError(error, 400);
  }
}
