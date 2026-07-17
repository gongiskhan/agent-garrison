import { NextResponse, type NextRequest } from "next/server";
import { listCompositions, readCompositionWithDerivedTasks } from "@/lib/compositions";
import { cloneComposition } from "@/lib/composition-clone";
import { resolveActiveComposition } from "@/lib/active-composition";
import { jsonError } from "@/lib/http";

export const runtime = "nodejs";
export const dynamic = "force-dynamic";

export async function GET() {
  try {
    const compositions = await listCompositions();
    const withDerived = await Promise.all(
      compositions.map((composition) => readCompositionWithDerivedTasks(composition.id))
    );
    return NextResponse.json({ compositions: withDerived });
  } catch (error) {
    return jsonError(error, 500);
  }
}

// Create a composition as a clean clone of an existing in-repo composition.
// The active composition is the default source, while callers may name an
// explicit sourceId. Runtime/install artifacts are excluded by cloneComposition;
// authored prompts and the composition routing policy are preserved.
export async function POST(request: NextRequest) {
  try {
    const body = (await request.json().catch(() => ({}))) as {
      name?: unknown;
      id?: unknown;
      sourceId?: unknown;
    };
    const name = typeof body.name === "string" ? body.name.trim() : "";
    if (!name) return jsonError(new Error("name is required"), 400);
    const active = await resolveActiveComposition();
    const sourceId = typeof body.sourceId === "string" && body.sourceId.trim()
      ? body.sourceId.trim()
      : active.external
        ? ""
        : active.id;
    if (!sourceId) {
      return jsonError(
        new Error("an in-repo sourceId is required when the active composition is external"),
        400
      );
    }
    const composition = await cloneComposition({
      sourceId,
      name,
      id: typeof body.id === "string" ? body.id : undefined
    });
    return NextResponse.json({ composition }, { status: 201 });
  } catch (error) {
    const message = error instanceof Error ? error.message : String(error);
    return jsonError(error, /already exists/.test(message) ? 409 : 400);
  }
}
