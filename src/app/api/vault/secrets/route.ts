import { NextResponse, type NextRequest } from "next/server";
import { applyVaultSecretUpdates, vaultViewMasked } from "@/lib/vault";
import { jsonError } from "@/lib/http";
import type { VaultSecretUpdate } from "@/lib/types";

export const runtime = "nodejs";
export const dynamic = "force-dynamic";

// GET returns MASKED secrets. It used to return every value in plaintext, which
// meant one unauthenticated request dumped the whole vault — and since the app
// is fronted by `tailscale serve` (which proxies to loopback), that request
// could come from any device on the tailnet and still look local, so a
// remote-address check would not have caught it. Verified: a curl from another
// machine returned all three account tokens in the clear.
//
// Server-side callers that need plaintext use vaultView()/readVaultSecrets()
// directly. Plaintext leaves the process over HTTP only via ./reveal, one named
// key at a time, recorded in the vault audit log.
export async function GET() {
  try {
    return NextResponse.json(await vaultViewMasked());
  } catch (error) {
    return jsonError(error, 400);
  }
}

// PUT applies a PARTIAL update: an entry with no `value` keeps whatever is
// stored. This is what lets the UI round-trip a list it only ever saw masked —
// without it, saving an unrelated row would write the mask string over a real
// credential. Keys absent from the body are still deleted, so the list stays
// authoritative about which secrets exist.
export async function PUT(request: NextRequest) {
  try {
    const body = (await request.json()) as { secrets?: unknown };
    const raw = Array.isArray(body.secrets) ? body.secrets : [];
    const updates: VaultSecretUpdate[] = raw
      .filter((entry): entry is Record<string, unknown> => !!entry && typeof entry === "object")
      .map((entry) => ({
        key: String(entry.key ?? ""),
        // Only a STRING counts as an edit. undefined/null/missing all mean
        // "unchanged" — never coerce, or a dropped field silently blanks a secret.
        ...(typeof entry.value === "string" ? { value: entry.value } : {})
      }))
      .filter((entry) => entry.key.trim().length > 0);

    const secrets = await applyVaultSecretUpdates(updates);
    return NextResponse.json({ unlocked: true, secrets });
  } catch (error) {
    return jsonError(error, 400);
  }
}
