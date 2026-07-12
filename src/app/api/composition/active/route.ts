import { NextResponse, type NextRequest } from "next/server";
import {
  getActiveComposition,
  setActiveComposition,
  resolveCompositionPointer
} from "@/lib/active-composition";
import { jsonError } from "@/lib/http";

export const runtime = "nodejs";
export const dynamic = "force-dynamic";

// The current active-composition pointer, plus its resolution (id/dir/external).
export async function GET() {
  try {
    const pointer = await getActiveComposition();
    const resolved = resolveCompositionPointer(pointer);
    return NextResponse.json({
      pointer,
      id: resolved.id,
      dir: resolved.dir,
      manifestPath: resolved.manifestPath,
      external: resolved.external
    });
  } catch (error) {
    return jsonError(error, 500);
  }
}

// Set the pointer WITHOUT running a switch (down/up). The full switch goes
// through POST /api/composition/switch. Accepts { target } (composition id or
// apm.yml path); tolerates { active_composition } as an alias.
export async function PUT(request: NextRequest) {
  try {
    const body = await request.json().catch(() => ({}));
    const raw =
      typeof body?.target === "string"
        ? body.target
        : typeof body?.active_composition === "string"
          ? body.active_composition
          : "";
    if (raw.trim().length === 0) {
      return jsonError(new Error("target (composition id or apm.yml path) is required"), 400);
    }
    await setActiveComposition(raw);
    const pointer = await getActiveComposition();
    const resolved = resolveCompositionPointer(pointer);
    return NextResponse.json({ pointer, id: resolved.id, external: resolved.external });
  } catch (error) {
    return jsonError(error, 400);
  }
}
