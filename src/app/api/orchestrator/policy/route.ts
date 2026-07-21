import { NextRequest, NextResponse } from "next/server";
import { resolveActiveComposition } from "@/lib/active-composition";
import { readComposition } from "@/lib/compositions";
import { readRoutingPolicy, writeRoutingPolicy } from "@/lib/orchestrator-policy";

export const dynamic = "force-dynamic";

// The routing-policy document behind the Muster Orchestrator tab (successor to
// the retired own-port composer server's GET/PUT /routing). Whole-document,
// baseline-sha guarded: 409 on a stale baseline, 422 when the config fails
// validation or the policy compile.

async function resolveCompositionId(compositionId?: string | null): Promise<string> {
  return compositionId?.trim() || (await resolveActiveComposition()).id;
}

export async function GET(request: NextRequest) {
  try {
    const id = await resolveCompositionId(request.nextUrl.searchParams.get("composition"));
    const composition = await readComposition(id);
    const { config, baselineSha } = await readRoutingPolicy(composition.directory);
    return NextResponse.json({ composition: id, config, baselineSha });
  } catch (err) {
    return NextResponse.json(
      { error: err instanceof Error ? err.message : String(err) },
      { status: 500 }
    );
  }
}

export async function PUT(request: NextRequest) {
  let body: { composition?: string; baseline?: string; config?: unknown };
  try {
    body = await request.json();
  } catch {
    return NextResponse.json({ error: "invalid-json" }, { status: 400 });
  }
  if (!body || typeof body !== "object" || body.config === undefined) {
    return NextResponse.json({ error: "config is required" }, { status: 400 });
  }
  try {
    const id = await resolveCompositionId(body.composition);
    const result = await writeRoutingPolicy(id, body.config, body.baseline ?? null);
    if (result.status === "conflict") {
      return NextResponse.json(
        {
          error: "conflict",
          message: "routing.json changed since baseline",
          currentSha: result.currentSha
        },
        { status: 409 }
      );
    }
    if (result.status === "invalid") {
      return NextResponse.json({ error: "invalid-config", errors: result.errors }, { status: 422 });
    }
    return NextResponse.json({
      ok: true,
      baselineSha: result.baselineSha,
      ...(result.warnings.length ? { warnings: result.warnings } : {})
    });
  } catch (err) {
    return NextResponse.json(
      { error: err instanceof Error ? err.message : String(err) },
      { status: 500 }
    );
  }
}
