import { NextResponse } from "next/server";
import { readLibrary } from "@/lib/library";
import { credentialNames, oauthHealth } from "@/lib/connector-auth";
import { readCortexBase } from "@/lib/cortex-proxy";
import { buildConnectorsView } from "@/lib/connectors-view";
import { getActiveComposition } from "@/lib/active-composition";
import { readComposition } from "@/lib/compositions";
import { jsonError } from "@/lib/http";

export const runtime = "nodejs";
export const dynamic = "force-dynamic";

// The Vault ↔ Connectors view: every connector Fitting + its sealed status (which
// scoped secret NAMES are present, or OAuth health). No secret VALUE is returned.
export async function GET() {
  try {
    const [library, names, health, cortex] = await Promise.all([readLibrary(), credentialNames(), oauthHealth(), readCortexBase()]);
    // Which Fittings are actually stationed: a connector whose Fitting is not
    // in the composition has nothing running to connect TO, and the page has
    // to say so instead of showing a dead card. A read failure yields null =
    // unknown, which renders as equipped rather than falsely "not stationed".
    let equippedFittingIds: Set<string> | null = null;
    try {
      const composition = await readComposition(await getActiveComposition());
      equippedFittingIds = new Set(
        Object.values(composition.selections ?? {})
          .flat()
          .map((sel) => (sel as { id?: string }).id ?? "")
          .filter(Boolean)
      );
    } catch {
      equippedFittingIds = null;
    }
    return NextResponse.json({
      connectors: buildConnectorsView(library, names, health, {
        cortexBaseUrl: cortex.baseUrl ?? undefined,
        ...(equippedFittingIds ? { equippedFittingIds } : {})
      }),
      vault: { unlocked: true, locked: false }
    });
  } catch (error) {
    return jsonError(error, 400);
  }
}
