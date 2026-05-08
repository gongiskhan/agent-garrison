import { NextResponse } from "next/server";
import { listArtifacts } from "@/lib/artifact-store";
import { jsonError } from "@/lib/http";

export const runtime = "nodejs";
export const dynamic = "force-dynamic";

export async function GET() {
  try {
    const artifacts = await listArtifacts();
    const documents = artifacts.filter((a) => a.namespace === "documents");
    return NextResponse.json({ documents });
  } catch (error) {
    return jsonError(error, 500);
  }
}
