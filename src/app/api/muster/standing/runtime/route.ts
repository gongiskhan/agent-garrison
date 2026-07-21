import { NextResponse, type NextRequest } from "next/server";
import { createRuntime, setPrimaryRuntime, testRuntimeConnection } from "../../model";
import { CloneError } from "@/lib/clone";
import { jsonError } from "@/lib/http";

export const runtime = "nodejs";
export const dynamic = "force-dynamic";

// POST /api/muster/standing/runtime
// The create-runtime flow (S5b). One route, three actions:
//   - "create":      { composition?, templateId, newId? } → clone a runtime
//                    template and station the clone. Returns { model, newFittingId }.
//   - "set-primary": { composition?, fittingId }          → make a stationed
//                    runtime the composition's primary. Returns the model.
//   - "test":        { composition?, fittingId }          → a static readiness
//                    check on a stationed runtime. Returns the RuntimeTestResult.
export async function POST(request: NextRequest) {
  try {
    const body = (await request.json().catch(() => ({}))) as {
      composition?: unknown;
      action?: unknown;
      templateId?: unknown;
      newId?: unknown;
      fittingId?: unknown;
    };
    const composition = typeof body.composition === "string" ? body.composition.trim() || undefined : undefined;
    const action = typeof body.action === "string" ? body.action : "";

    if (action === "create") {
      const templateId = typeof body.templateId === "string" ? body.templateId.trim() : "";
      const newId = typeof body.newId === "string" ? body.newId.trim() || undefined : undefined;
      if (!templateId) return jsonError(new Error("templateId is required"), 400);
      return NextResponse.json(await createRuntime(composition, templateId, newId));
    }

    if (action === "set-primary") {
      const fittingId = typeof body.fittingId === "string" ? body.fittingId.trim() : "";
      if (!fittingId) return jsonError(new Error("fittingId is required"), 400);
      return NextResponse.json(await setPrimaryRuntime(composition, fittingId));
    }

    if (action === "test") {
      const fittingId = typeof body.fittingId === "string" ? body.fittingId.trim() : "";
      if (!fittingId) return jsonError(new Error("fittingId is required"), 400);
      return NextResponse.json(await testRuntimeConnection(composition, fittingId));
    }

    return jsonError(new Error('action must be "create", "set-primary", or "test"'), 400);
  } catch (error) {
    // cloneFitting surfaces a precise HTTP status (409 duplicate id, 400 bad id, …).
    if (error instanceof CloneError) return jsonError(error, error.status);
    return jsonError(error, 400);
  }
}
