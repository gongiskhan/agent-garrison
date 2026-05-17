import { NextResponse, type NextRequest } from "next/server";
import { getGatewayBaseUrl } from "@/lib/runner";
import { jsonError } from "@/lib/http";

export const runtime = "nodejs";
export const dynamic = "force-dynamic";

export async function POST(
  request: NextRequest,
  { params }: { params: { id: string } }
) {
  try {
    const baseUrl = getGatewayBaseUrl(params.id);
    if (!baseUrl) {
      return NextResponse.json(
        { error: "Operative is not running" },
        { status: 503 }
      );
    }
    const body = await request.json();
    const message = String(body.message ?? "").trim();
    if (!message) {
      return NextResponse.json({ error: "message is required" }, { status: 400 });
    }

    const origin = request.headers.get("x-garrison-origin") ?? "ui-tab";
    const upstream = await fetch(`${baseUrl}/chat/stream`, {
      method: "POST",
      headers: {
        "content-type": "application/json",
        "x-garrison-origin": origin
      },
      body: JSON.stringify({ message })
    });

    if (!upstream.ok || !upstream.body) {
      const text = await upstream.text();
      return NextResponse.json(
        { error: `gateway returned ${upstream.status}: ${text}` },
        { status: 502 }
      );
    }

    return new Response(upstream.body, {
      status: 200,
      headers: {
        "content-type": "text/event-stream; charset=utf-8",
        "cache-control": "no-cache, no-transform",
        connection: "keep-alive",
        "x-accel-buffering": "no"
      }
    });
  } catch (error) {
    return jsonError(error, 400);
  }
}
