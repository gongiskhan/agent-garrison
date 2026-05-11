import { NextResponse, type NextRequest } from "next/server";

export const runtime = "nodejs";
export const dynamic = "force-dynamic";

const OUTPOST_HOST = "http://127.0.0.1:3702";

export async function GET() {
  try {
    const res = await fetch(`${OUTPOST_HOST}/outposts`, { cache: "no-store" });
    const data = await res.json();
    return NextResponse.json(data, { status: res.status });
  } catch {
    return NextResponse.json({ error: "outpost-host unreachable" }, { status: 503 });
  }
}

export async function POST(request: NextRequest) {
  let body: { name?: string; token?: string };
  try {
    body = (await request.json()) as { name?: string; token?: string };
  } catch {
    return NextResponse.json({ error: "invalid JSON" }, { status: 400 });
  }
  if (!body.name || !body.token) {
    return NextResponse.json({ error: "name and token required" }, { status: 400 });
  }
  try {
    const res = await fetch(`${OUTPOST_HOST}/registry/register`, {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ name: body.name, token: body.token }),
    });
    const data = await res.json();
    return NextResponse.json(data, { status: res.status });
  } catch {
    return NextResponse.json({ error: "outpost-host unreachable" }, { status: 503 });
  }
}
