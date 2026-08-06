import { NextResponse, type NextRequest } from "next/server";
import { getCompositionDirectory, DEFAULT_COMPOSITION_ID } from "@/lib/compositions";
import { writeAuthoredOverride, isAuthoredSectionId } from "@/lib/orchestrator-authored-store";
import { writeAssembledOrchestratorPrompt } from "@/lib/orchestrator-projection";
import { getGatewayBaseUrl } from "@/lib/runner";
import { jsonError } from "@/lib/http";

export const runtime = "nodejs";
export const dynamic = "force-dynamic";

// POST /api/orchestrator/authored
// Body: { composition?, sectionId, content }
// The write surface for the Muster orchestrator panel (S5c). Persists ONE
// authored doctrine section into the composition's authored-overrides JSON and
// returns the freshly re-assembled preview ({sections, assembled}). Constraint
// 12: only an AUTHORED section id is accepted - a locked block id (capabilities /
// duties-and-levels / readiness) is refused with 400, and the locked sections in
// the returned preview are ALWAYS regenerated from the resolved model, never read
// from disk, so an authored edit can never mutate a locked block.
export async function POST(request: NextRequest) {
  try {
    const body = (await request.json().catch(() => ({}))) as {
      composition?: unknown;
      sectionId?: unknown;
      content?: unknown;
    };
    const composition =
      typeof body.composition === "string" && body.composition.trim()
        ? body.composition.trim()
        : DEFAULT_COMPOSITION_ID;
    const sectionId = typeof body.sectionId === "string" ? body.sectionId : "";
    const content = typeof body.content === "string" ? body.content : "";

    if (!isAuthoredSectionId(sectionId)) {
      return jsonError(new Error(`"${sectionId}" is not an editable orchestrator section`), 400);
    }

    await writeAuthoredOverride(getCompositionDirectory(composition), sectionId, content);
    // Re-derive and atomically materialize the exact prompt the runtime reads.
    // Then queue a warm-session rebuild at a turn boundary, so the next real
    // turn sees the authored Identity/policy without requiring an operator restart.
    const { preview } = await writeAssembledOrchestratorPrompt(composition);
    let runtimeRefresh: "queued" | "not-running" | "failed" = "not-running";
    const gateway = getGatewayBaseUrl(composition);
    if (gateway) {
      try {
        const response = await fetch(`${gateway}/control/reload-prompt`, {
          method: "POST",
          signal: AbortSignal.timeout(2_000)
        });
        runtimeRefresh = response.ok ? "queued" : "failed";
      } catch {
        runtimeRefresh = "failed";
      }
    }
    return NextResponse.json({ ...preview, runtimeRefresh });
  } catch (error) {
    return jsonError(error, 400);
  }
}
