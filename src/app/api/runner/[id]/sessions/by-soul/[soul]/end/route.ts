import { NextResponse, type NextRequest } from "next/server";
import { getGatewayBaseUrl } from "@/lib/runner";

export const runtime = "nodejs";
export const dynamic = "force-dynamic";

// Phase 9H — kill a Soul's active sub-session from the chat UI.

export async function POST(
  _request: NextRequest,
  { params }: { params: { id: string; soul: string } }
) {
  const baseUrl = getGatewayBaseUrl(params.id);
  if (!baseUrl) {
    return NextResponse.json({ error: "Operative is not running" }, { status: 503 });
  }
  const upstream = await fetch(
    `${baseUrl}/sessions/by-soul/${encodeURIComponent(params.soul)}/end`,
    { method: "POST" }
  );
  const data = await upstream.json().catch(() => ({}));
  return NextResponse.json(data, { status: upstream.status });
}
