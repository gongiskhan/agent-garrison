import { NextResponse } from "next/server";
import { readLibrary } from "@/lib/library";
import { vaultView, oauthHealth } from "@/lib/vault";
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
    const [library, view] = await Promise.all([readLibrary(), vaultView()]);
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
    const locked = !view.unlocked;
    // When the vault can't be read (keychain unavailable / decrypt fail) we have
    // no names or grants — flag it as UNKNOWN rather than reporting "missing".
    const names = view.unlocked ? (view.secrets ?? []).map((s: { key: string }) => s.key) : [];
    const health = view.unlocked ? await oauthHealth() : [];
    return NextResponse.json({
      connectors: buildConnectorsView(library, names, health, {
        vaultLocked: locked,
        ...(equippedFittingIds ? { equippedFittingIds } : {})
      }),
      vault: { unlocked: view.unlocked, locked, keySource: view.keySource }
    });
  } catch (error) {
    return jsonError(error, 400);
  }
}
