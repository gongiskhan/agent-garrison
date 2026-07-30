import { NextResponse, type NextRequest } from "next/server";
import {
  bundleFileName,
  buildCompositionBundle,
  inspectCompositionBundle,
  serializeBundle
} from "@/lib/composition-transfer";
import { jsonError } from "@/lib/http";

export const runtime = "nodejs";
export const dynamic = "force-dynamic";

// Export a composition as one portable bundle.
//
// Two shapes on purpose. `?download=1` returns the bundle document ITSELF as an
// attachment, so the URL can be handed to anyone or curl'd. Without it the
// response is { bundle, inspection, warnings } — the panel needs the same
// server-side view an import gets (which fittings and vault keys this bundle
// depends on) to show what a recipient will need, and fetching it twice to
// render one card would be silly.
export async function GET(request: NextRequest, { params }: { params: { id: string } }) {
  try {
    const { bundle, warnings } = await buildCompositionBundle(params.id);
    if (request.nextUrl.searchParams.get("download") === "1") {
      return new NextResponse(serializeBundle(bundle), {
        status: 200,
        headers: {
          "Content-Type": "application/json; charset=utf-8",
          "Content-Disposition": `attachment; filename="${bundleFileName(bundle)}"`,
          // A bundle is a point-in-time snapshot of a directory that changes
          // whenever the composition is edited; a cached copy would hand back a
          // stale export.
          "Cache-Control": "no-store"
        }
      });
    }
    // Inspected against THIS machine, which is the honest reading for the
    // export card: it is the same check the recipient's import will run.
    const inspection = await inspectCompositionBundle(bundle, bundle.composition.id);
    return NextResponse.json({
      bundle,
      inspection,
      warnings,
      filename: bundleFileName(bundle)
    });
  } catch (error) {
    const message = error instanceof Error ? error.message : String(error);
    return jsonError(error, /does not exist/.test(message) ? 404 : 500);
  }
}
