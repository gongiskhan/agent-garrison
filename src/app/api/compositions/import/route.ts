import { NextResponse, type NextRequest } from "next/server";
import {
  importComposition,
  inspectCompositionBundle,
  parseCompositionBundle
} from "@/lib/composition-transfer";
import { jsonError } from "@/lib/http";

export const runtime = "nodejs";
export const dynamic = "force-dynamic";

// Import a composition bundle.
//
// Body: { bundle, id?, name?, preview? }. `bundle` may be the parsed object or
// the raw JSON text (a paste), because the paste box would otherwise have to
// parse it client-side and re-report the error in a second voice.
//
// `preview: true` writes NOTHING and returns the inspection: which fittings are
// missing here, which vault keys are unset, what files would be written, and
// the id that is actually free. The panel always previews before it imports —
// an import that surprises you is an import you have to undo by hand.
export async function POST(request: NextRequest) {
  try {
    const body = (await request.json().catch(() => ({}))) as {
      bundle?: unknown;
      id?: unknown;
      name?: unknown;
      preview?: unknown;
    };
    if (body.bundle === undefined || body.bundle === null) {
      return jsonError(new Error("bundle is required"), 400);
    }
    const bundle = parseCompositionBundle(body.bundle);
    const requestedId = typeof body.id === "string" && body.id.trim() ? body.id.trim() : undefined;
    const name = typeof body.name === "string" && body.name.trim() ? body.name.trim() : undefined;

    if (body.preview === true) {
      const inspection = await inspectCompositionBundle(bundle, requestedId);
      return NextResponse.json({ inspection });
    }

    const composition = await importComposition({ bundle, id: requestedId, name });
    // Re-inspect the imported composition's bundle view so the caller can show
    // the same missing-fittings / missing-keys list after the fact without a
    // second round trip.
    const inspection = await inspectCompositionBundle(bundle, composition.id);
    return NextResponse.json({ composition, inspection }, { status: 201 });
  } catch (error) {
    const message = error instanceof Error ? error.message : String(error);
    return jsonError(error, /already exists/.test(message) ? 409 : 400);
  }
}
