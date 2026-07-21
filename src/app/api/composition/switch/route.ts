import { NextResponse, type NextRequest } from "next/server";
import { switchComposition } from "@/lib/composition-switch";
import { jsonError } from "@/lib/http";

export const runtime = "nodejs";
export const dynamic = "force-dynamic";

// Switch the active composition: resolve the target first (a resolver error
// returns 409 with a readable message and changes NO state), then clean
// down -> set pointer -> up. Body: { target } (composition id or apm.yml path).
export async function POST(request: NextRequest) {
  try {
    const body = await request.json().catch(() => ({}));
    const target = typeof body?.target === "string" ? body.target : "";
    if (target.trim().length === 0) {
      return jsonError(new Error("target (composition id or apm.yml path) is required"), 400);
    }
    const result = await switchComposition(target);
    if (!result.ok) {
      return NextResponse.json({ ok: false, error: result.error, id: result.id }, { status: 409 });
    }
    return NextResponse.json({ ok: true, id: result.id });
  } catch (error) {
    return jsonError(error, 400);
  }
}
