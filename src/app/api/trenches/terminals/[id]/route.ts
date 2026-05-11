import { NextResponse } from "next/server";
import { ensureWsServer, trenchesBaseUrl } from "@/lib/trenches/ws-server";

export const runtime = "nodejs";
export const dynamic = "force-dynamic";

export async function DELETE(
  _request: Request,
  { params }: { params: { id: string } }
) {
  try {
    await ensureWsServer();
    const res = await fetch(`${trenchesBaseUrl()}/terminals/${encodeURIComponent(params.id)}`, {
      method: "DELETE",
    });
    const json = await res.json().catch(() => ({}));
    return NextResponse.json(json, { status: res.status });
  } catch (err) {
    return NextResponse.json(
      { error: err instanceof Error ? err.message : String(err) },
      { status: 500 }
    );
  }
}
