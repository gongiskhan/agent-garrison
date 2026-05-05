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
    const filename = String(body.filename ?? "").trim();
    const contentBase64 = String(body.content_base64 ?? "");
    if (!filename || !contentBase64) {
      return NextResponse.json(
        { error: "filename and content_base64 are required" },
        { status: 400 }
      );
    }

    const upstream = await fetch(`${baseUrl}/attachments`, {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify({ filename, content_base64: contentBase64 })
    });

    const data = await upstream.json().catch(() => ({}));
    return NextResponse.json(data, { status: upstream.status });
  } catch (error) {
    return jsonError(error, 400);
  }
}
