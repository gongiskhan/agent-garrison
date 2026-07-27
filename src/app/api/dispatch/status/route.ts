import { NextResponse, type NextRequest } from "next/server";
import { authenticateMachine } from "@/lib/dispatch-machines";
import { BoardUnavailableError, patchCard, readAllCards } from "@/lib/dispatch";
import { jsonError } from "@/lib/http";

export const runtime = "nodejs";
export const dynamic = "force-dynamic";

// POST /api/dispatch/status — terminal report from a worker.
//
// `done` moves the card to done; `failed` parks it in needs-attention with the
// machine named, so a remote failure reads as a remote failure on the board
// rather than a silent stall. The dispatch record is kept either way — it is
// the evidence of WHERE the card ran.
export async function POST(request: NextRequest) {
  try {
    const machine = await authenticateMachine(request.headers.get("authorization"));
    if (!machine) return NextResponse.json({ error: "unauthorized" }, { status: 401 });

    const body = (await request.json().catch(() => ({}))) as {
      cardId?: unknown;
      workerId?: unknown;
      state?: unknown;
      summary?: unknown;
      exitCode?: unknown;
      transcript?: unknown;
    };
    const cardId = typeof body.cardId === "string" ? body.cardId.trim() : "";
    const workerId = typeof body.workerId === "string" ? body.workerId.trim() : "";
    const state = body.state === "done" || body.state === "failed" ? body.state : null;
    if (!cardId) return jsonError(new Error("cardId is required"), 400);
    if (!state) return jsonError(new Error('state must be "done" or "failed"'), 400);

    const card = (await readAllCards()).find((c) => c.id === cardId);
    if (!card) return NextResponse.json({ error: "no such card" }, { status: 404 });

    const owned =
      card.dispatch && card.dispatch.machine === machine && card.dispatch.workerId === workerId;
    if (!owned) {
      // A worker reporting on a claim it no longer holds must not move the card
      // — the current owner is authoritative.
      return NextResponse.json(
        { ok: false, stop: true, reason: "claim not held by this worker" },
        { status: 409 }
      );
    }

    const summary =
      typeof body.summary === "string" && body.summary.trim()
        ? body.summary.trim().slice(0, 2000)
        : state === "done"
          ? "completed on outpost"
          : "failed on outpost";
    const nowIso = new Date().toISOString();

    const result = await patchCard(cardId, {
      rev: card.rev,
      list: state === "done" ? "done" : "needs-attention",
      dispatch: {
        ...card.dispatch,
        heartbeatAt: nowIso,
        state,
        detail: summary
      },
      // Named machine in the attention reason: "it failed" is not actionable,
      // "it failed on goncalos-mac-mini-1" is.
      ...(state === "failed"
        ? {
            attentionReason: `Dispatched run failed on ${machine}: ${summary}`,
            attentionKind: "failed"
          }
        : {})
    });

    if (!result.ok) {
      return NextResponse.json(
        { error: "status write failed", status: result.status, detail: result.body },
        { status: 502 }
      );
    }
    return NextResponse.json({ ok: true, state });
  } catch (error) {
    if (error instanceof BoardUnavailableError) {
      return NextResponse.json({ error: error.message }, { status: 503 });
    }
    return jsonError(error, 400);
  }
}
