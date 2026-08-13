import { NextResponse, type NextRequest } from "next/server";
import { findOutboxFitting, OUTBOX_CANCEL_TIMEOUT_MS } from "../fittings";

export const runtime = "nodejs";
export const dynamic = "force-dynamic";

// POST /api/outbox/cancel  {fitting, id}
//
// Proxies the cancel to the Fitting holding the parked send and returns its
// answer VERBATIM, status code included. That matters most in the case the
// surface exists for: after the window elapses the fitting answers 409 "sent",
// and the honest thing to show the user is that the message went - not a
// cancellation that never happened. Softening it here would make the whole
// buffer a lie at exactly the moment it stops working.
//
// The fitting is resolved by exact id against the enumerated status files, so
// no caller-supplied string is ever built into a path or a host; an id that
// matches nothing is a 404, never a fetch to somewhere the caller named.
export async function POST(request: NextRequest) {
  let body: { fitting?: unknown; id?: unknown };
  try {
    body = (await request.json()) as { fitting?: unknown; id?: unknown };
  } catch {
    return NextResponse.json({ ok: false, status: "invalid", error: "a JSON body is required" }, { status: 400 });
  }

  const fittingId = typeof body?.fitting === "string" ? body.fitting.trim() : "";
  const id = typeof body?.id === "string" ? body.id.trim() : "";
  if (!fittingId || !id) {
    return NextResponse.json(
      { ok: false, status: "invalid", error: "cancel needs both a fitting and an id" },
      { status: 400 }
    );
  }

  const fitting = await findOutboxFitting(fittingId);
  if (!fitting) {
    return NextResponse.json(
      { ok: false, status: "unknown", error: `no running fitting ${fittingId}` },
      { status: 404 }
    );
  }

  try {
    const res = await fetch(new URL(`/outbox/${encodeURIComponent(id)}/cancel`, fitting.url), {
      method: "POST",
      headers: { accept: "application/json" },
      cache: "no-store",
      signal: AbortSignal.timeout(OUTBOX_CANCEL_TIMEOUT_MS)
    });
    const answer = await res.json().catch(() => null);
    if (answer === null) {
      return NextResponse.json(
        { ok: false, status: "unreachable", error: `${fittingId} answered ${res.status} with no JSON` },
        { status: 502 }
      );
    }
    return NextResponse.json(answer, { status: res.status });
  } catch (error) {
    // Unreachable is NOT cancelled. The send may still be parked and may still
    // go out, so the only safe report is that we could not reach the holder.
    const detail = error instanceof Error ? error.message : String(error);
    return NextResponse.json(
      { ok: false, status: "unreachable", error: `${fittingId} is not answering (${detail})` },
      { status: 502 }
    );
  }
}
