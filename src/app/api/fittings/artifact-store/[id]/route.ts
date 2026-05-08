import { NextResponse } from "next/server";
import fs from "node:fs/promises";
import { deleteArtifact, findArtifact } from "@/lib/artifact-store";
import { jsonError } from "@/lib/http";

export const runtime = "nodejs";
export const dynamic = "force-dynamic";

interface Context {
  params: Promise<{ id: string }> | { id: string };
}

async function resolveId(context: Context): Promise<string> {
  const params = await context.params;
  return params.id;
}

export async function GET(_request: Request, context: Context) {
  try {
    const id = await resolveId(context);
    const found = await findArtifact(id);
    if (!found) {
      return jsonError(`artifact ${id} not found`, 404);
    }
    const body = await fs.readFile(found.artifactPath);
    return new NextResponse(body, {
      headers: {
        "content-type": found.meta.mime || "application/octet-stream",
        "cache-control": "no-store"
      }
    });
  } catch (error) {
    return jsonError(error, 500);
  }
}

export async function DELETE(_request: Request, context: Context) {
  try {
    const id = await resolveId(context);
    const ok = await deleteArtifact(id);
    if (!ok) {
      return jsonError(`artifact ${id} not found`, 404);
    }
    return NextResponse.json({ deleted: id });
  } catch (error) {
    return jsonError(error, 500);
  }
}
