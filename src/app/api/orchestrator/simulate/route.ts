import { NextRequest, NextResponse } from "next/server";
import { resolveActiveComposition } from "@/lib/active-composition";
import { readComposition } from "@/lib/compositions";
import { simulateTryIt } from "@/lib/orchestrator-policy";

export const dynamic = "force-dynamic";

// Try-it dry run for the Muster Orchestrator tab (successor to the retired
// own-port composer server's POST /simulate tryIt branch): deterministic
// heuristic classification + the resolved phase rail + gate reasoning. No
// model call — the live classifier runs at the gateway for real turns.

export async function POST(request: NextRequest) {
  let body: { composition?: string; prompt?: string; workKind?: string; project?: string | null };
  try {
    body = await request.json();
  } catch {
    return NextResponse.json({ error: "invalid-json" }, { status: 400 });
  }
  if (!body?.prompt || typeof body.prompt !== "string") {
    return NextResponse.json({ error: "prompt is required" }, { status: 400 });
  }
  try {
    const id = body.composition?.trim() || (await resolveActiveComposition()).id;
    const composition = await readComposition(id);
    const outcome = await simulateTryIt(composition.directory, {
      prompt: body.prompt,
      workKind: body.workKind ?? null,
      project: body.project ?? null
    });
    if (outcome.status === "unknown-profile") {
      return NextResponse.json(
        { error: "unknown-profile", profile: outcome.profile, known: outcome.known },
        { status: 422 }
      );
    }
    return NextResponse.json(outcome.result);
  } catch (err) {
    return NextResponse.json(
      { error: err instanceof Error ? err.message : String(err) },
      { status: 500 }
    );
  }
}
