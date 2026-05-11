import { NextResponse, type NextRequest } from "next/server";
import { readHosts, upsertHost } from "@/lib/hosts";

export const runtime = "nodejs";
export const dynamic = "force-dynamic";

export async function GET() {
  return NextResponse.json({ hosts: readHosts() });
}

export async function POST(request: NextRequest) {
  try {
    const body = await request.json();
    const hosts = upsertHost(body);
    return NextResponse.json({ hosts });
  } catch (err) {
    return NextResponse.json(
      { error: err instanceof Error ? err.message : String(err) },
      { status: 400 }
    );
  }
}
