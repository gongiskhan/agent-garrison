import { NextResponse, type NextRequest } from "next/server";
import { authenticateMachine } from "@/lib/mesh/node-auth";
import {
  acknowledgeDispatchCancellation,
  BoardUnavailableError,
  readAllCards
} from "@/lib/dispatch";
import { verifyEvidenceManifest } from "@/lib/dispatch-evidence";
import { jsonError } from "@/lib/http";

export const runtime = "nodejs";
export const dynamic = "force-dynamic";

// Positive worker acknowledgement for Stop & reroute. The host keeps the claim
// locked until the worker proves the exact run/routing identity and states that
// its process group has stopped. A timeout is deliberately not success.
export async function POST(request: NextRequest) {
  try {
    const machine = await authenticateMachine(request.headers.get("authorization"));
    if (!machine) return NextResponse.json({ error: "unauthorized" }, { status: 401 });
    const body = (await request.json().catch(() => ({}))) as Record<string, unknown>;
    const cardId = typeof body.cardId === "string" ? body.cardId.trim() : "";
    const workerId = typeof body.workerId === "string" ? body.workerId.trim() : "";
    const runId = typeof body.runId === "string" ? body.runId.trim() : "";
    const routingToken = typeof body.routingToken === "string" ? body.routingToken.trim() : "";
    if (!cardId || !runId || !routingToken || body.stopped !== true) {
      return jsonError(new Error("cardId, runId, routingToken and stopped:true are required"), 400);
    }

    const card = (await readAllCards()).find((candidate) => candidate.id === cardId);
    if (!card) return NextResponse.json({ error: "no such card" }, { status: 404 });
    const dispatch = card.dispatch;
    const owned = dispatch
      && dispatch.machine === machine
      && dispatch.workerId === workerId
      && dispatch.runId === runId
      && dispatch.routingToken === routingToken;
    if (!owned || dispatch.state !== "cancelling" || !dispatch.cancellation) {
      return NextResponse.json({ ok: false, stop: true, error: "cancellation claim is no longer held by this worker" }, { status: 409 });
    }

    const manifest = await verifyEvidenceManifest(cardId, runId, body.evidenceManifest, []);
    const result = await acknowledgeDispatchCancellation(cardId, {
      rev: card.rev,
      machine,
      workerId,
      runId,
      routingToken,
      stopped: true,
      summary: typeof body.summary === "string" ? body.summary.slice(0, 1000) : "remote process group stopped",
      logCursor: Number.isSafeInteger(body.logCursor) ? body.logCursor : 0,
      evidenceManifest: manifest
    });
    return NextResponse.json(result.body, { status: result.status });
  } catch (error) {
    if (error instanceof BoardUnavailableError) {
      return NextResponse.json({ error: error.message }, { status: 503 });
    }
    return jsonError(error, 400);
  }
}
