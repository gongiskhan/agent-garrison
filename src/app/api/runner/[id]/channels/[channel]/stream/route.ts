import type { NextRequest } from "next/server";
import { getGatewayBaseUrl } from "@/lib/runner";

export const runtime = "nodejs";
export const dynamic = "force-dynamic";

// Phase 9H — SSE proxy from the browser to http-gateway /channels/<id>/stream.
// Keeps the request alive for the lifetime of the gateway connection.

export async function GET(
  _request: NextRequest,
  { params }: { params: { id: string; channel: string } }
) {
  const baseUrl = getGatewayBaseUrl(params.id);
  if (!baseUrl) {
    return new Response(JSON.stringify({ error: "Operative is not running" }), {
      status: 503,
      headers: { "content-type": "application/json" }
    });
  }

  const upstream = await fetch(`${baseUrl}/channels/${encodeURIComponent(params.channel)}/stream`, {
    method: "GET",
    headers: { accept: "text/event-stream" }
  });

  if (!upstream.ok || !upstream.body) {
    const text = await upstream.text().catch(() => "");
    return new Response(
      JSON.stringify({ error: `gateway returned ${upstream.status}: ${text.slice(0, 200)}` }),
      { status: 502, headers: { "content-type": "application/json" } }
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
}
