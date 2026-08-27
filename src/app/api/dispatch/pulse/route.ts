import { NextResponse, type NextRequest } from "next/server";
import { authenticateMachine } from "@/lib/mesh/node-auth";
import { DISPATCH_PROTOCOL_VERSION, recordWorkerPulse } from "@/lib/mesh/node-workers";
import { jsonError } from "@/lib/http";

export const runtime = "nodejs";
export const dynamic = "force-dynamic";

// A pulse is sent while idle as well as while running. Card heartbeats prove
// claim ownership; this endpoint proves that a task-capable worker exists.
export async function POST(request: NextRequest) {
  try {
    const machine = await authenticateMachine(request.headers.get("authorization"));
    if (!machine) return NextResponse.json({ error: "unauthorized" }, { status: 401 });
    const body = await request.json().catch(() => ({}));
    const record = await recordWorkerPulse(machine, body);
    return NextResponse.json({ ok: true, machine, protocolVersion: DISPATCH_PROTOCOL_VERSION, acceptedAt: record.lastSeenAt });
  } catch (error) {
    return jsonError(error, 400);
  }
}

