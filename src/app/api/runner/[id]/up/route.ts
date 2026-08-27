import { NextResponse, type NextRequest } from "next/server";
import { up } from "@/lib/runner";
import { jsonError } from "@/lib/http";

export const runtime = "nodejs";

export async function POST(request: NextRequest, { params }: { params: { id: string } }) {
  try {
    // {full: true} forces install + setup hooks + verify even when the
    // composition is unchanged (the fast path skips them otherwise).
    const body = await request.json().catch(() => ({}));
    return NextResponse.json({ state: await up(params.id, { full: body?.full === true }) });
  } catch (error) {
    return jsonError(error, 400);
  }
}
