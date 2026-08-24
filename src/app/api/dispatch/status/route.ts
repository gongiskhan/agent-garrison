import { NextResponse, type NextRequest } from "next/server";
import { authenticateMachine } from "@/lib/mesh/node-auth";
import {
  BoardUnavailableError,
  completeDispatchPhase,
  claimRevisionMatches,
  patchCard,
  readAllCards,
  validTransitionsForCard
} from "@/lib/dispatch";
import { dispatchEvidenceDir, verifyDispatchGate, verifyEvidenceManifest } from "@/lib/dispatch-evidence";
import { jsonError } from "@/lib/http";

export const runtime = "nodejs";
export const dynamic = "force-dynamic";

// A completion is a request to settle ONE phase, not permission to put the card
// in Done. The host rechecks the opaque run/routing identities, phase, revision,
// valid edge and evidence bytes, then asks Kanban's normal phase-transition
// routine to commit it. Failed runs park with their original phase recorded.
export async function POST(request: NextRequest) {
  try {
    const machine = await authenticateMachine(request.headers.get("authorization"));
    if (!machine) return NextResponse.json({ error: "unauthorized" }, { status: 401 });

    const body = (await request.json().catch(() => ({}))) as Record<string, unknown>;
    const cardId = typeof body.cardId === "string" ? body.cardId.trim() : "";
    const workerId = typeof body.workerId === "string" ? body.workerId.trim() : "";
    const runId = typeof body.runId === "string" ? body.runId.trim() : "";
    const routingToken = typeof body.routingToken === "string" ? body.routingToken.trim() : "";
    const phase = typeof body.phase === "string" ? body.phase.trim() : "";
    const state = body.state === "done" || body.state === "failed" ? body.state : null;
    const requestedTransition = typeof body.requestedTransition === "string" ? body.requestedTransition.trim() : "";
    const sessionId = typeof body.sessionId === "string" && /^[A-Za-z0-9._:-]{1,200}$/.test(body.sessionId.trim())
      ? body.sessionId.trim()
      : undefined;
    const logCursor = Number.isSafeInteger(body.logCursor) && Number(body.logCursor) >= 0 ? Number(body.logCursor) : 0;
    if (!cardId) return jsonError(new Error("cardId is required"), 400);
    if (!state) return jsonError(new Error('state must be "done" or "failed"'), 400);

    const card = (await readAllCards()).find((candidate) => candidate.id === cardId);
    if (!card) return NextResponse.json({ error: "no such card" }, { status: 404 });
    const dispatch = card.dispatch;
    const owned = dispatch
      && dispatch.machine === machine
      && dispatch.workerId === workerId
      && dispatch.runId === runId
      && dispatch.routingToken === routingToken;
    if (!owned || dispatch.releasedAt || dispatch.state === "done" || dispatch.state === "failed") {
      return NextResponse.json(
        { ok: false, stop: true, reason: "claim not held by this worker" },
        { status: 409 }
      );
    }
    if (!phase || dispatch.phase !== phase || card.list !== phase) {
      return NextResponse.json(
        { ok: false, stop: true, reason: `phase changed from ${phase || "unknown"} to ${card.list}` },
        { status: 409 }
      );
    }
    if (!/^[A-Za-z0-9][A-Za-z0-9_-]{0,80}$/.test(phase)) {
      return jsonError(new Error("phase cannot be used as a gate evidence name"), 400);
    }
    if (!claimRevisionMatches(card.rev, dispatch)) {
      return NextResponse.json({
        ok: false,
        stop: true,
        reason: `card revision changed outside this claim (expected ${dispatch.claimRevision ?? "unknown"}, found ${card.rev})`
      }, { status: 409 });
    }

    const summary =
      typeof body.summary === "string" && body.summary.trim()
        ? body.summary.trim().slice(0, 2000)
        : state === "done"
          ? "completed on a remote node"
          : "failed on a remote node";
    const required = state === "done"
      ? ["transcript.md", `gate-status.${phase}.json`, ...(requestedTransition === "done" ? ["evidence.md"] : [])]
      : [];
    const manifest = await verifyEvidenceManifest(cardId, runId, body.evidenceManifest, required);
    if (state === "failed" && manifest.length === 0) {
      return jsonError(new Error("a failed run must retain at least one diagnostic artifact"), 400);
    }

    if (state === "failed") {
      const nowIso = new Date().toISOString();
      const result = await patchCard(cardId, {
        rev: card.rev,
        list: "needs-attention",
        status: "needs-attention",
        runningSince: null,
        runDir: dispatchEvidenceDir(cardId, runId),
        parkedFrom: phase,
        retryKeepsContext: true,
        dispatch: {
          ...dispatch,
          heartbeatAt: nowIso,
          state: "failed",
          detail: summary,
          requestedTransition: requestedTransition || undefined,
          sessionId,
          logCursor,
          evidenceManifest: manifest
        },
        dispatchRun: {
          runId,
          machine,
          workerId,
          phase,
          state: "failed",
          claimedAt: dispatch.claimedAt,
          completedAt: nowIso,
          logIndex: dispatch.logIndex,
          sessionId,
          logCursor,
          evidenceManifest: manifest
        },
        attentionReason: `Dispatched run failed on ${machine}: ${summary}`,
        attentionKind: "failed"
      });
      if (!result.ok) {
        return NextResponse.json(
          { error: "status write failed", status: result.status, detail: result.body },
          { status: result.status === 409 ? 409 : 502 }
        );
      }
      return NextResponse.json({ ok: true, state: "failed", parkedFrom: phase });
    }

    const validTransitions = await validTransitionsForCard(card);
    if (!requestedTransition || !validTransitions.includes(requestedTransition)) {
      return NextResponse.json(
        { error: "invalid requested transition", requestedTransition, validTransitions },
        { status: 409 }
      );
    }
    await verifyDispatchGate(cardId, runId, phase, requestedTransition);
    const completed = await completeDispatchPhase(cardId, {
      rev: dispatch.claimRevision,
      runId,
      routingToken,
      phase,
      verdict: requestedTransition,
      summary,
      sessionId,
      logCursor,
      evidenceManifest: manifest
    });
    if (!completed.ok) {
      return NextResponse.json(
        { error: "phase completion was refused", status: completed.status, detail: completed.body },
        { status: completed.status }
      );
    }
    return NextResponse.json({ ok: true, state: "done", advanced: requestedTransition, detail: completed.body });
  } catch (error) {
    if (error instanceof BoardUnavailableError) {
      return NextResponse.json({ error: error.message }, { status: 503 });
    }
    return jsonError(error, 400);
  }
}
