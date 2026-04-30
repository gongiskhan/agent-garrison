import { NextResponse, type NextRequest } from "next/server";
import { sendTestMessage } from "@/lib/runner";
import { jsonError } from "@/lib/http";

export const runtime = "nodejs";
export const dynamic = "force-dynamic";

export async function POST(
  request: NextRequest,
  { params }: { params: { id: string } }
) {
  try {
    const body = await request.json();
    const state = await sendTestMessage(params.id, String(body.message ?? ""));
    return NextResponse.json({ state });
  } catch (error) {
    return jsonError(error, 400);
  }
}
