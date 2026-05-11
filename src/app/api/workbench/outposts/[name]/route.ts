import { NextResponse, type NextRequest } from "next/server";

export const runtime = "nodejs";
export const dynamic = "force-dynamic";

const OUTPOST_HOST = "http://127.0.0.1:3702";

export async function DELETE(
  _request: NextRequest,
  { params }: { params: { name: string } }
) {
  const name = params.name;
  try {
    const res = await fetch(`${OUTPOST_HOST}/registry/${encodeURIComponent(name)}`, {
      method: "DELETE",
    });
    const data = await res.json();
    return NextResponse.json(data, { status: res.status });
  } catch {
    return NextResponse.json({ error: "outpost-host unreachable" }, { status: 503 });
  }
}

// POST /:name — blocking RPC call forwarded to the named bridge
export async function POST(
  request: NextRequest,
  { params }: { params: { name: string } }
) {
  const name = params.name;
  let body: { type?: string; payload?: unknown };
  try {
    body = (await request.json()) as { type?: string; payload?: unknown };
  } catch {
    return NextResponse.json({ error: "invalid JSON" }, { status: 400 });
  }
  if (!body.type) {
    return NextResponse.json({ error: "type required" }, { status: 400 });
  }
  try {
    const res = await fetch(`${OUTPOST_HOST}/outposts/${encodeURIComponent(name)}/rpc`, {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ type: body.type, payload: body.payload ?? {} }),
    });
    const data = await res.json();
    return NextResponse.json(data, { status: res.status });
  } catch {
    return NextResponse.json({ error: "outpost-host unreachable" }, { status: 503 });
  }
}
