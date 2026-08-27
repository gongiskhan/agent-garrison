// Per-stretch instrumentation for the dashboard (Conversations, Task 5).
//
//   GET /api/conversation-metrics                    → board-level rollup (groupBy=duty)
//   GET /api/conversation-metrics?groupBy=model      → … by model | chosenBy
//   GET /api/conversation-metrics?id=<conversation>  → one conversation's metrics
//
// Read-only; costs are LIST rates and an unknown model reports unpriced, never
// zero (the improver diets on these numbers).
import { NextRequest, NextResponse } from "next/server";
// @ts-ignore — pure .mjs package module
import { conversationMetrics, rollupMetrics } from "@garrison/claude-pty";

export const dynamic = "force-dynamic";

export async function GET(request: NextRequest) {
  const id = request.nextUrl.searchParams.get("id");
  if (id) {
    if (!/^[A-Za-z0-9][A-Za-z0-9._-]{0,127}$/.test(id)) {
      return NextResponse.json({ error: "invalid conversation id" }, { status: 400 });
    }
    return NextResponse.json({ conversationId: id, metrics: conversationMetrics(id) });
  }
  const groupByParam = request.nextUrl.searchParams.get("groupBy") ?? "duty";
  const groupBy = ["duty", "model", "chosenBy"].includes(groupByParam) ? groupByParam : "duty";
  return NextResponse.json(rollupMetrics({ groupBy }));
}
