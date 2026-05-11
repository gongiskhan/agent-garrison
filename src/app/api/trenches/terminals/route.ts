import { NextResponse, type NextRequest } from "next/server";
import { ensureWsServer, trenchesBaseUrl, trenchesWsUrl } from "@/lib/trenches/ws-server";

export const runtime = "nodejs";
export const dynamic = "force-dynamic";

export async function POST(request: NextRequest) {
  try {
    await ensureWsServer();
    const body = await request.json().catch(() => ({}));
    const res = await fetch(`${trenchesBaseUrl()}/terminals`, {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify(body),
    });
    const json = await res.json();
    if (!res.ok) {
      return NextResponse.json(json, { status: res.status });
    }
    return NextResponse.json({ ...json, wsUrl: trenchesWsUrl() }, { status: 201 });
  } catch (err) {
    return NextResponse.json(
      { error: err instanceof Error ? err.message : String(err) },
      { status: 500 }
    );
  }
}
