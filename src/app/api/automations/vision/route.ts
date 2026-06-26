import { NextResponse } from "next/server";
import { readLibrary } from "@/lib/library";
import { findRoutingConfigPath, readRoutingConfig, resolveRoute } from "@/lib/model-router";
import { verifyInternalToken } from "@/lib/internal-token";

export const runtime = "nodejs";
export const dynamic = "force-dynamic";

// Per-step vision/fixer model call for a browser step, routed through the Model
// Router (decision 5 — no hardcoded model). Given an observation (a11y tree +
// url/title/heading; screenshot optional) and the step, the operative returns a
// resolved Playwright action (mode=action) or a pass/fail verdict (mode=verify).
// Internal-token gated.
export async function POST(req: Request) {
  if (!(await verifyInternalToken(req.headers.get("x-garrison-internal")))) {
    return NextResponse.json({ error: "forbidden" }, { status: 403 });
  }
  let body: { observation?: any; step?: any; mode?: string };
  try {
    body = await req.json();
  } catch {
    return NextResponse.json({ error: "invalid body" }, { status: 400 });
  }
  const { observation, step, mode = "action" } = body;
  if (!observation || !step) return NextResponse.json({ error: "observation + step required" }, { status: 400 });

  // Route via the Model Router (image task type for a screenshot-grounded call).
  let routedVia: string | null = null;
  const classification = { taskType: "image" as const, tier: "T1-standard" as const, contextKind: "automation-vision" };
  try {
    const entries = await readLibrary();
    const configPath = findRoutingConfigPath(entries);
    if (configPath) {
      const config = await readRoutingConfig(configPath);
      routedVia = resolveRoute(config, classification).target.id;
    }
  } catch (err) {
    return NextResponse.json({ error: `model router unavailable: ${err instanceof Error ? err.message : String(err)}` }, { status: 500 });
  }

  const a11y = Array.isArray(observation.a11y)
    ? observation.a11y.slice(0, 80).map((n: any) => `${n.role}: ${n.name ?? ""}`).join("\n")
    : "";
  const prompt =
    mode === "verify"
      ? [
          "You are resolving a browser VERIFY step. Given the page state, decide if the expected outcome holds.",
          `Expected: ${step.expectedOutcome ?? step.description ?? ""}`,
          `URL: ${observation.url}\nTitle: ${observation.title}\nHeading: ${observation.headingText}`,
          `Accessible elements:\n${a11y}`,
          'Reply ONLY JSON: { "passed": true|false, "reasoning": "...", "assertion": { "kind":"text-visible", "text":"..." } }'
        ].join("\n\n")
      : [
          "You are resolving a browser ACTION step into a single Playwright action. Use the accessible elements to ground it.",
          `Goal: ${step.description ?? ""}`,
          `URL: ${observation.url}\nTitle: ${observation.title}\nHeading: ${observation.headingText}`,
          `Accessible elements (role: name):\n${a11y}`,
          'Reply ONLY JSON: { "kind":"click|fill|select|check|hover|press", "role":"button|link|textbox|...", "name":"the accessible name", "value":"(for fill/select/press)" }'
        ].join("\n\n");

  const gatewayUrl = process.env.GARRISON_GATEWAY_URL || `http://127.0.0.1:${process.env.GARRISON_GATEWAY_PORT || "4777"}`;
  try {
    const res = await fetch(`${gatewayUrl}/chat`, {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify({ message: prompt, classification: { taskType: classification.taskType, tier: classification.tier } })
    });
    if (!res.ok) return NextResponse.json({ error: `gateway ${res.status}`, routedVia }, { status: 502 });
    const json = await res.json();
    const text = json.reply ?? json.text ?? json.message ?? "";
    const m = text.match(/\{[\s\S]*\}/);
    if (!m) return NextResponse.json({ error: "vision reply had no JSON", routedVia }, { status: 502 });
    return NextResponse.json({ result: JSON.parse(m[0]), routedVia });
  } catch (err) {
    return NextResponse.json({ error: `gateway unreachable: ${err instanceof Error ? err.message : String(err)}`, routedVia }, { status: 503 });
  }
}
