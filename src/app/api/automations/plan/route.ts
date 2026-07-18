import { NextResponse } from "next/server";
import { readLibrary } from "@/lib/library";
import { findRoutingConfigPath, readRoutingConfig, resolveRoute } from "@/lib/model-router";
import { verifyInternalToken } from "@/lib/internal-token";

export const runtime = "nodejs";
export const dynamic = "force-dynamic";

// The planner's model call, routed through the Model Router (decision 5 — no
// hardcoded model). resolveRoute() picks the target for the "automation"
// classification from the routing matrix; the prompt is then executed by the
// operative via the gateway (its auth, the chosen model). Internal-token gated
// (it drives the operative on the caller's behalf).
export async function POST(req: Request) {
  if (!(await verifyInternalToken(req.headers.get("x-garrison-internal")))) {
    return NextResponse.json({ error: "forbidden" }, { status: 403 });
  }
  let body: { prompt?: string };
  try {
    body = await req.json();
  } catch {
    return NextResponse.json({ error: "invalid body" }, { status: 400 });
  }
  const prompt = body.prompt;
  if (!prompt || typeof prompt !== "string") {
    return NextResponse.json({ error: "prompt required" }, { status: 400 });
  }

  // The planner's classification. The gateway applies the Model Router to THIS
  // hint (the Kanban §10 {taskType,tier} contract), so the routing is BINDING —
  // the gateway routes to the resolved target rather than re-classifying freely.
  const classification = { taskType: "writing" as const, tier: "T2-deep" as const, contextKind: "automation-plan" };

  // Resolve locally too — for the routedVia report AND to FAIL CLOSED on a
  // present-but-broken routing config (resolveRoute throws on an invalid config).
  let routedVia: string | null = null;
  let routerAvailable = false;
  try {
    const entries = await readLibrary();
    const configPath = findRoutingConfigPath(entries);
    if (configPath) {
      const config = await readRoutingConfig(configPath); // throws if unreadable
      const route = resolveRoute(config, classification); // throws on invalid config
      routedVia = route.target.id;
      routerAvailable = true;
    }
  } catch (err) {
    const message = err instanceof Error ? err.message : String(err);
    return NextResponse.json({ error: `model router unavailable: ${message}` }, { status: 500 });
  }

  // Execute the prompt via the gateway (the operative + its auth), forwarding the
  // binding classification hint so the gateway honors the same route.
  const gatewayUrl = process.env.GARRISON_GATEWAY_URL || `http://127.0.0.1:${process.env.GARRISON_GATEWAY_PORT || "24777"}`;
  try {
    const res = await fetch(`${gatewayUrl}/chat`, {
      method: "POST",
      headers: { "content-type": "application/json" },
      // The gateway reads body.classification = {taskType,tier} (Kanban §10) in
      // both souls + PTY modes; this shape makes the route honored, not ignored.
      body: JSON.stringify({ message: prompt, classification: { taskType: classification.taskType, tier: classification.tier } })
    });
    if (!res.ok) {
      return NextResponse.json({ error: `gateway ${res.status}`, routedVia }, { status: 502 });
    }
    const json = await res.json();
    const text = json.reply ?? json.text ?? json.message ?? "";
    return NextResponse.json({ text, routedVia, routerAvailable });
  } catch (err) {
    const message = err instanceof Error ? err.message : String(err);
    // The operative/gateway must be running to plan.
    return NextResponse.json({ error: `gateway unreachable: ${message}`, routedVia }, { status: 503 });
  }
}
