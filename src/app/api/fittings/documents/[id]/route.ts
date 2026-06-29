import { NextResponse } from "next/server";
import fs from "node:fs/promises";
import { findArtifact } from "@/lib/document-store";
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
    if (!found || found.meta.namespace !== "documents") {
      return jsonError(`document ${id} not found`, 404);
    }
    const body = await fs.readFile(found.artifactPath, "utf8");
    return NextResponse.json({
      meta: found.meta,
      content: body
    });
  } catch (error) {
    return jsonError(error, 500);
  }
}

export async function PUT(request: Request, context: Context) {
  try {
    const id = await resolveId(context);
    const found = await findArtifact(id);
    if (!found || found.meta.namespace !== "documents") {
      return jsonError(`document ${id} not found`, 404);
    }
    const payload = (await request.json()) as { content?: string };
    if (typeof payload.content !== "string") {
      return jsonError("content (string) is required", 400);
    }
    await fs.writeFile(found.artifactPath, payload.content, "utf8");
    const updatedMeta = {
      ...found.meta,
      updated: nowIso()
    };
    await fs.writeFile(
      found.sidecarPath,
      JSON.stringify(sortKeys(updatedMeta), null, 2) + "\n",
      "utf8"
    );
    return NextResponse.json({ meta: updatedMeta });
  } catch (error) {
    return jsonError(error, 500);
  }
}

function nowIso(): string {
  return new Date().toISOString().replace(/\.\d+Z$/, "Z");
}

function sortKeys<T extends Record<string, unknown>>(obj: T): T {
  const sorted: Record<string, unknown> = {};
  for (const key of Object.keys(obj).sort()) {
    sorted[key] = obj[key];
  }
  return sorted as T;
}
