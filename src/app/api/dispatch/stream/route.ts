import { NextResponse, type NextRequest } from "next/server";
import { authenticateMachine } from "@/lib/mesh/node-auth";
import { appendDispatchStreamEvent } from "@/lib/dispatch-stream";
import { readAllCards } from "@/lib/dispatch";
import { jsonError } from "@/lib/http";

export const runtime = "nodejs";
export const dynamic = "force-dynamic";

export async function POST(request: NextRequest) {
  try {
    const machine = await authenticateMachine(request.headers.get("authorization"));
    if (!machine) return NextResponse.json({ error: "unauthorized" }, { status: 401 });
    const body = await request.json().catch(() => ({})) as Record<string, unknown>;
    const cardId = typeof body.cardId === "string" ? body.cardId.trim() : "";
    const workerId = typeof body.workerId === "string" ? body.workerId.trim() : "";
    const runId = typeof body.runId === "string" ? body.runId.trim() : "";
    if (!cardId) return NextResponse.json({ error: "cardId is required" }, { status: 400 });
    const card = (await readAllCards()).find((candidate) => candidate.id === cardId);
    if (!card) return NextResponse.json({ error: "no such card" }, { status: 404 });
    const dispatch = card.dispatch;
    const owned = dispatch && dispatch.machine === machine && dispatch.workerId === workerId && dispatch.runId === runId;
    if (!owned) return NextResponse.json({ error: "claim not held by this worker" }, { status: 409 });
    const result = await appendDispatchStreamEvent(cardId, dispatch, body);
    return NextResponse.json({ ok: true, ...result });
  } catch (error) {
    return jsonError(error, 400);
  }
}

