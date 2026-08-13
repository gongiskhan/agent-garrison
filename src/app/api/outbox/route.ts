import { NextResponse } from "next/server";
import { bySoonest, listOutboxFittings, readFittingOutbox, type PendingSend } from "./fittings";

export const runtime = "nodejs";
export const dynamic = "force-dynamic";

// GET /api/outbox
//
// Every outbound send currently parked in a cancel window, across every Fitting
// that holds one. The shell fans out server-side and merges; see ./fittings.ts
// for why discovery is an enumeration rather than a registry, and why a fitting
// URL must never reach the browser.
//
// This is what makes the delay buffer worth having. A parked send that can only
// be cancelled with a curl one-liner printed into an agent's answer is not
// revertible in practice, and the autonomy band that grants act-without-asking
// on an outbound message is staked on it being revertible in practice.
export async function GET() {
  const fittings = await listOutboxFittings();
  const answers = await Promise.all(fittings.map((fitting) => readFittingOutbox(fitting)));
  const pending: PendingSend[] = answers.flat().sort(bySoonest);
  // checkedAt is the client's proof this is a live read: an empty list from a
  // stale poll and an empty list from "nothing is parked" look identical
  // otherwise.
  return NextResponse.json({ pending, checkedAt: new Date().toISOString() });
}
