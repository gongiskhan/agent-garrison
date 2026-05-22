import { NextResponse } from "next/server";
import { stopOwnPortFitting } from "@/lib/own-port-lifecycle";

export const runtime = "nodejs";
export const dynamic = "force-dynamic";

export async function POST(_: Request, { params }: { params: { id: string } }) {
  try {
    const result = await stopOwnPortFitting(params.id);
    if (!result.ok) {
      return NextResponse.json({ error: result.error ?? "stop failed" }, { status: result.status ?? 500 });
    }
    return NextResponse.json({ ok: true, wasRunning: result.wasRunning, pid: result.pid });
  } catch (err) {
    const message = err instanceof Error ? err.message : String(err);
    return NextResponse.json({ error: message }, { status: 500 });
  }
}
