import { NextResponse } from "next/server";
import { activeGatewayBaseUrl } from "@/lib/runner";
import { BASE_GATEWAY_PORT, profilePort } from "@/lib/instance-profile";
import { EMPTY_VOCABULARY, normalizeRouteOptions } from "@/lib/decision-feedback";

export const runtime = "nodejs";
export const dynamic = "force-dynamic";

// GET /api/orchestrator/route-options
//
// The shell's same-origin proxy of the gateway's GET /route/options — the routing
// vocabulary (targets, duties, efforts, tiers, flows, accounts, projects) the
// dimension feedback card fills its menus from.
//
// Proxied, not read from disk: the vocabulary is the gateway's COMPILED policy,
// held only in that process, and the gateway is also what validates a routing
// value at the edge. A second reader over the policy file is how a menu starts
// offering something the edge would refuse. The web channel and the Kanban board
// front the same endpoint the same way, for the same reason.
//
// Server-side by necessity, too: the browser is almost never on this box (HARD
// RULE in CLAUDE.md), so a machine-local gateway URL handed to the client would
// be unreachable AND mixed content. The client only ever sees this relative path.
export async function GET() {
  // The live runner record first, then a PROFILE-SHIFTED base port. A literal
  // port here would be per-instance wrong by construction (dev 4777, prod 5777,
  // codex 24777) and would quietly read another instance's routing vocabulary.
  const gatewayUrl =
    activeGatewayBaseUrl() ??
    `http://127.0.0.1:${process.env.GARRISON_GATEWAY_PORT || profilePort(BASE_GATEWAY_PORT)}`;

  // 503 + a reason the card can render, never a 500: "the operative is not
  // running" is an ordinary state of the Garrison home page, and the card
  // degrades to typed corrections rather than blocking the verdict.
  const unavailable = (reason: string) =>
    NextResponse.json({ ...EMPTY_VOCABULARY, available: false, reason }, { status: 503 });

  try {
    const res = await fetch(new URL("/route/options", gatewayUrl), {
      headers: { accept: "application/json" },
      cache: "no-store",
      // The card is opened mid-tap; a gateway that is starting up must not hang it.
      signal: AbortSignal.timeout(2500)
    });
    if (!res.ok) return unavailable(`the gateway answered ${res.status}`);
    const body = await res.json();
    return NextResponse.json({ ...normalizeRouteOptions(body), available: true, reason: null });
  } catch (error) {
    const detail = error instanceof Error ? error.message : String(error);
    return unavailable(`the gateway is not answering - start the session to correct a route (${detail})`);
  }
}
