import { NextResponse } from "next/server";
import { readLibrary } from "@/lib/library";
import { vaultView, oauthHealth } from "@/lib/vault";
import { buildConnectorsView } from "@/lib/connectors-view";
import { jsonError } from "@/lib/http";

export const runtime = "nodejs";
export const dynamic = "force-dynamic";

// The Vault ↔ Connectors view: every connector Fitting + its sealed status (which
// scoped secret NAMES are present, or OAuth health). No secret VALUE is returned.
export async function GET() {
  try {
    const [library, view] = await Promise.all([readLibrary(), vaultView()]);
    const locked = !view.unlocked;
    // When the vault can't be read (keychain unavailable / decrypt fail) we have
    // no names or grants — flag it as UNKNOWN rather than reporting "missing".
    const names = view.unlocked ? (view.secrets ?? []).map((s: { key: string }) => s.key) : [];
    const health = view.unlocked ? await oauthHealth() : [];
    return NextResponse.json({
      connectors: buildConnectorsView(library, names, health, { vaultLocked: locked }),
      vault: { unlocked: view.unlocked, locked, keySource: view.keySource }
    });
  } catch (error) {
    return jsonError(error, 400);
  }
}
