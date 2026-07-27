import { NextResponse, type NextRequest } from "next/server";
import { authenticateMachine } from "@/lib/dispatch-machines";
import { BoardUnavailableError, patchCard, readAllCards } from "@/lib/dispatch";
import { jsonError } from "@/lib/http";

export const runtime = "nodejs";
export const dynamic = "force-dynamic";

// POST /api/dispatch/heartbeat — "I am still working on this card."
//
// Answers with { stop: true } when this worker no longer owns the claim, which
// is the ONLY signal that stops a worker whose lease was reclaimed. Without it
// a machine that froze past its lease and then woke up would keep running
// alongside whoever took the card over — two runs, one card, on two machines.
export async function POST(request: NextRequest) {
  try {
    const machine = await authenticateMachine(request.headers.get("authorization"));
    if (!machine) return NextResponse.json({ error: "unauthorized" }, { status: 401 });

    const body = (await request.json().catch(() => ({}))) as {
      cardId?: unknown;
      workerId?: unknown;
      progress?: unknown;
    };
    const cardId = typeof body.cardId === "string" ? body.cardId.trim() : "";
    const workerId = typeof body.workerId === "string" ? body.workerId.trim() : "";
    if (!cardId) return jsonError(new Error("cardId is required"), 400);

    const card = (await readAllCards()).find((c) => c.id === cardId);
    if (!card) return NextResponse.json({ error: "no such card" }, { status: 404 });

    // Ownership is (machine, workerId). A restarted worker on the same machine
    // gets a fresh id, so the previous process is told to stop rather than both
    // beating on one claim.
    const owned =
      card.dispatch && card.dispatch.machine === machine && card.dispatch.workerId === workerId;
    if (!owned) {
      return NextResponse.json({
        ok: false,
        stop: true,
        reason: card.dispatch ? `claim held by ${card.dispatch.machine}` : "claim released"
      });
    }

    const result = await patchCard(cardId, {
      rev: card.rev,
      dispatch: {
        ...card.dispatch,
        heartbeatAt: new Date().toISOString(),
        state: "running",
        ...(typeof body.progress === "string" ? { detail: body.progress.slice(0, 280) } : {})
      }
    });

    // A raced heartbeat is not fatal: the next beat re-reads the card. Only an
    // ownership change stops the worker.
    if (!result.ok && result.status === 409) {
      return NextResponse.json({ ok: true, stop: false, raced: true });
    }
    if (!result.ok) {
      return NextResponse.json(
        { error: "heartbeat failed", status: result.status, detail: result.body },
        { status: 502 }
      );
    }
    return NextResponse.json({ ok: true, stop: false });
  } catch (error) {
    if (error instanceof BoardUnavailableError) {
      return NextResponse.json({ error: error.message }, { status: 503 });
    }
    return jsonError(error, 400);
  }
}
