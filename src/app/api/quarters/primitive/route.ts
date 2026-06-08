import { NextResponse, type NextRequest } from "next/server";
import { getPrimitiveDetail } from "@/lib/quarters-detail";
import { jsonError } from "@/lib/http";

export const runtime = "nodejs";
export const dynamic = "force-dynamic";

// GET /api/quarters/primitive?id=mcp:context7 — full detail for one primitive,
// for the per-surface editors (the list state model doesn't carry content/config).
export async function GET(request: NextRequest) {
  try {
    const id = request.nextUrl.searchParams.get("id");
    if (!id) return jsonError(new Error("id query param is required"), 400);
    return NextResponse.json(await getPrimitiveDetail(id));
  } catch (error) {
    return jsonError(error, 400);
  }
}
